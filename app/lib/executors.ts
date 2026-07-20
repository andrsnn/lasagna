// Shared task executors used by both the interactive /api/query route and
// the scheduled task runner. Keeping this in one place avoids forking the
// LLM tool loop or reimplementing SSRF guards.

import type { Message as OllamaMessage, Tool, ToolCall } from "ollama";
import { DEFAULT_MODEL, DEFAULT_RESEARCH_MODEL } from "@/app/models";
import { chatClientFor } from "@/app/lib/llm/router";
import {
  MAX_TOOL_ROUNDS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  executeTool,
} from "@/app/lib/ollama/tools";
import { currentDateSystemLine } from "@/app/lib/system-context";
import { enforceStructured } from "@/app/lib/structured-output";
import { UserStoppedError } from "@/app/api/chat/stop-flag";
import { withDeadline } from "@/app/lib/with-deadline";
import { buildMcpToolset, executeMcpTool } from "@/app/lib/mcp/client";
import type { McpRuntimeConnector } from "@/app/lib/mcp/shared";

const QUERY_TIMEOUT_MS = 280_000;
const TOOL_TIMEOUT_MS = 60_000;
// Budget kept back from the tool loop so the FINAL answer (plus a JSON repair
// round) always has room to run. When remaining time drops below this, the
// loop stops offering tools and forces an answer from what's been gathered.
const FINAL_ANSWER_RESERVE_MS = 90_000;

const DEFAULT_SYSTEM =
  "You are a data fetcher embedded inside an artifact. Be terse. Use the provided tools when you need real-world information.";

const JSON_INSTRUCTION =
  "Respond with ONE JSON value (object or array) matching the schema below. " +
  "Output JSON ONLY: no prose, no commentary, no markdown code fences. " +
  "Your entire reply must start with `{` or `[` and end with `}` or `]`.";

// Layered in only when web tools are on. Same stale-link failure as the chat
// route: a query app that emits URLs (product pages, listings, sources) tends
// to hand back links the model half-remembers, which are dead by now. Keep it
// terse to fit the data-fetcher budget; the chat route carries the long form.
const LIVE_LINKS_NOTE =
  "LIVE LINKS: any URL you output must be one you got from web_search/web_fetch " +
  "results in THIS run - never guess, reconstruct, or recall a URL from memory. " +
  "For a link the user will open (product, listing, source), fetch it first and " +
  "confirm the page really shows that item; treat 404s, redirects to a homepage, " +
  "and 'no longer available' pages as DEAD and search for the current URL instead. " +
  "Ship a real live link or an empty value, never a stale one.";

export type QueryInput = {
  prompt: string;
  schema?: unknown;
  model?: string;
  webSearch?: boolean;
  system?: string;
  /**
   * The user's MCP connectors to expose to this run (URL + key + discovered
   * tools). When present, each connector's tools are offered to the model under
   * a namespaced wire-name and a call is routed back to the right server — the
   * same mechanism the chat tool loop uses. Empty/undefined ⇒ no MCP tools.
   */
  connectors?: McpRuntimeConnector[];
};

// Nudges the data-fetcher toward the connected servers when MCP tools are on,
// mirroring the chat prompt's framing. Terse to fit the fetcher's budget.
const MCP_TOOLS_NOTE =
  "You have tools provided by the user's connected MCP servers (each marked " +
  "\"Provided by the … connector\"). When the request needs real data those " +
  "servers expose, CALL those tools to fetch it - do not invent values. If a " +
  "needed server/tool isn't available, say so in the result rather than " +
  "fabricating data.";

export type QueryOutcome =
  | { status: number; payload: { text: string; json?: unknown; model: string } }
  | { status: number; payload: { error: string; text?: string; model: string } };

/**
 * Execute one Ollama Cloud chat completion with optional tool gathering and
 * forced-JSON synthesis. Returns the same `Outcome` shape the interactive
 * query route uses, so callers can inspect status + payload uniformly.
 */
export async function executeQuery(input: QueryInput): Promise<QueryOutcome> {
  const model =
    typeof input.model === "string" && input.model.length > 0 ? input.model : DEFAULT_MODEL;
  const webSearch = input.webSearch === true;
  const wantsJson = !!input.schema;

  let llm;
  try {
    llm = chatClientFor(model);
  } catch (err) {
    return {
      status: 500,
      payload: { error: err instanceof Error ? err.message : "LLM provider unavailable", model },
    };
  }

  const userSystem = input.system?.trim();
  const system = userSystem || DEFAULT_SYSTEM;

  // Expose the user's MCP connectors' tools to this run (same wire-name +
  // dispatch derivation the chat loop uses), so a source/query with mcp:true
  // can pull real data from a connected server.
  const mcp = buildMcpToolset(input.connectors);
  const hasMcp = mcp.tools.length > 0;

  const conv: OllamaMessage[] = [
    { role: "system", content: currentDateSystemLine() },
    { role: "system", content: system },
  ];
  if (webSearch) {
    conv.push({ role: "system", content: LIVE_LINKS_NOTE });
  }
  if (hasMcp) {
    conv.push({ role: "system", content: MCP_TOOLS_NOTE });
  }
  if (wantsJson) {
    conv.push({
      role: "system",
      content: `${JSON_INSTRUCTION}\n\nSchema:\n${JSON.stringify(input.schema, null, 2)}`,
    });
  }
  conv.push({ role: "user", content: input.prompt });

  const baseTools: Tool[] = [
    ...(webSearch ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : []),
    ...mcp.tools,
  ];
  const tools: Tool[] | undefined = baseTools.length ? baseTools : undefined;

  // Single wall-clock deadline shared across every tool round, every web
  // tool call, and the JSON synth call. Vercel kills the function at
  // maxDuration; without a global cap a hung web_search/web_fetch (which
  // the Ollama SDK exposes no AbortSignal for) can blow past that and
  // leave the schedule stuck on status="running" because the
  // setResult(complete|error) write at the end of runScheduledTask never
  // runs.
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  async function chatWithTimeout(options: Parameters<typeof llm.chat>[0]) {
    return withDeadline(() => llm.chat(options), deadline, "Query");
  }

  try {
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Graceful degrade instead of a hard timeout: when the remaining budget
      // dips below the final-answer reserve, stop offering tools and tell the
      // model to answer from what it has gathered. A slow model in a long
      // web_search loop then produces a PARTIAL result instead of burning the
      // whole deadline mid-loop and failing with "Query timed out" (observed:
      // a ~1T model consumed 280s across search rounds and died holding the
      // residual, where a fast model finishes in budget).
      const remaining = deadline - Date.now();
      const outOfToolBudget = tools !== undefined && remaining < FINAL_ANSWER_RESERVE_MS;
      const roundTools = outOfToolBudget ? undefined : tools;
      if (outOfToolBudget) {
        conv.push({
          role: "user",
          content:
            "Time budget is nearly exhausted. STOP calling tools. Answer NOW " +
            "using only the information already gathered above" +
            (wantsJson ? ", as the required JSON" : "") + ".",
        });
      }
      const res = await chatWithTimeout({
        model,
        messages: conv,
        tools: roundTools,
        stream: false,
        ...(wantsJson && !roundTools && !model.startsWith("gpt-oss") ? { format: "json" } : {}),
      });
      const msg = res.message;
      const calls = (msg.tool_calls ?? []) as ToolCall[];
      finalText = msg.content ?? "";

      if (calls.length === 0 || outOfToolBudget) break;

      conv.push({ role: "assistant", content: finalText, tool_calls: calls });
      for (const call of calls) {
        const args = call.function.arguments as Record<string, unknown>;
        // Route custom MCP connector tools to their session; everything else
        // goes to the built-in executor. Both return the same ToolExecResult
        // shape, so the result handling below is shared.
        const mcpTarget = mcp.dispatch.get(call.function.name);
        const r = await withDeadline(
          () =>
            mcpTarget
              ? executeMcpTool(
                  mcp.getSession(mcpTarget.connector),
                  mcpTarget.connector,
                  mcpTarget.toolName,
                  args
                )
              : executeTool(call.function.name, args),
          deadline,
          `tool:${call.function.name}`,
          TOOL_TIMEOUT_MS
        );
        conv.push({
          role: "tool",
          content: JSON.stringify(r.ok ? r.result : { error: r.error }),
          tool_name: call.function.name,
        } as OllamaMessage);
      }
    }

    if (wantsJson) {
      // Parse → validate against the schema → bounded repair loop. This is the
      // shared reliability path: the same shape comes back every time even when
      // web tools were on (which disables Ollama's `format:"json"` above), which
      // is exactly when the old single strictJsonParse failed most.
      conv.push({ role: "assistant", content: finalText });
      const enforced = await enforceStructured({
        initialText: finalText,
        schema: input.schema,
        runRepair: async (instruction) => {
          conv.push({ role: "user", content: instruction });
          const synth = await chatWithTimeout({
            model,
            messages: conv,
            stream: false,
            ...(model.startsWith("gpt-oss") ? {} : { format: "json" }),
          });
          const out = synth.message?.content ?? "";
          conv.push({ role: "assistant", content: out });
          return out;
        },
      });
      if (!enforced.ok) {
        return {
          status: 502,
          payload: { error: enforced.error, text: enforced.text.slice(0, 1000), model },
        };
      }
      return { status: 200, payload: { text: enforced.text, json: enforced.json, model } };
    }

    return { status: 200, payload: { text: finalText, model } };
  } catch (err) {
    return {
      status: 500,
      payload: { error: err instanceof Error ? err.message : "Unknown error", model },
    };
  }
}

// ---- deep research engine (used by Structured research in chat) ----------

const RESEARCH_SYNTHESIS_SYSTEM =
  "You are the synthesizer for a deep-research run. Parallel research sub-agents " +
  "have already investigated the user's request; their findings are provided below " +
  "as RESEARCH BRIEFS with inline source citations. Produce the exact answer the " +
  "user asked for, grounded in those briefs.\n\n" +
  "Be concrete: transcribe the actual data points (names, companies, roles, emails, " +
  "links, dates, numbers) rather than describing the research.\n\n" +
  "You have web_search and web_fetch tools. The briefs are a starting point, not a " +
  "ceiling: when the user asked for a specific field (a contact name, an email, an " +
  "open role, a profile URL, a metric) and the briefs don't already contain it, USE " +
  "THE TOOLS to look it up before you answer. Prefer a few targeted searches that " +
  "fill the most important gaps over leaving columns blank. Spend your tool budget " +
  "on the fields the user explicitly asked for.\n\n" +
  "Hard rules for every field you output:\n" +
  "- Put ONLY the real value in a field. NEVER write meta-commentary such as 'not " +
  "transcribed in briefs', 'not verified', 'not found', 'unknown', 'N/A', or 'see " +
  "website'. If after trying you genuinely cannot find a value, leave it as an empty " +
  "string \"\" — an empty cell is correct; a sentence about the research is not.\n" +
  "- Never invent or guess data. An empty string is correct when a value is truly " +
  "unavailable; fabricated data is not.\n" +
  "- Every row must be a real, specific entity with enough filled fields to be useful.";

// Synthesis may now call web tools to fill gaps; bound the gathering loop well
// below the global MAX_TOOL_ROUNDS so a model that keeps searching can't burn
// the whole deadline before it ever emits the table. The wall-clock deadline is
// still the real backstop.
const SYNTHESIS_MAX_TOOL_ROUNDS = 8;

export type ResearchInput = {
  prompt: string;
  schema?: unknown;
  model?: string;
  depth?: "standard" | "deep";
  /** Coarse progress callback for UI liveness ("Planning…", "Researching
   *  sources (2)…", "Compiling…"). Best-effort; never throws into the run. */
  onProgress?: (stage: string) => void;
  /** Optional user-stop check, polled at stage boundaries. On a hit the run
   *  throws UserStoppedError (propagated to the caller) instead of finishing. */
  shouldStop?: () => boolean | Promise<boolean>;
};

/**
 * Run a full deep-research pass (planner → parallel web sub-agents → reflection)
 * and synthesize the findings into schema-conforming JSON. Returns the same
 * `QueryOutcome` shape as executeQuery.
 *
 * This is the long pole: the orchestrator can run for many minutes, so it's
 * only invoked from the Fly worker (1-hour budget), never inline in a Vercel
 * function. The orchestrator + research modules are dynamically imported
 * (mirroring executeCode) so they stay out of route bundles. Consumed by the
 * chat Structured research flow.
 */
export async function executeResearch(input: ResearchInput): Promise<QueryOutcome> {
  const model =
    typeof input.model === "string" && input.model.length > 0
      ? input.model
      : DEFAULT_RESEARCH_MODEL;
  const wantsJson = !!input.schema;
  const onProgress = input.onProgress;
  const report = (stage: string) => {
    try {
      onProgress?.(stage);
    } catch {
      /* progress is best-effort */
    }
  };

  let llm;
  try {
    llm = chatClientFor(model);
  } catch (err) {
    return {
      status: 500,
      payload: { error: err instanceof Error ? err.message : "LLM provider unavailable", model },
    };
  }

  // --- Stage 1: orchestrated research (plan → sub-agents → reflect) ---
  report("Planning the research…");
  let briefsContext: string;
  try {
    const { orchestrateResearch } = await import("@/app/api/chat/research/orchestrator");
    // Translate the orchestrator's stage events into coarse, human progress.
    let subagents = 0;
    const emit = (event: string, data: unknown) => {
      if (event !== "tool_call") return; // act on stage starts only
      const name = String((data as { name?: unknown })?.name ?? "");
      if (name.startsWith("research:plan")) report("Planning the research…");
      else if (name.startsWith("research:subagent")) {
        subagents += 1;
        report(`Researching sources (${subagents})…`);
      } else if (name.startsWith("research:reflect")) report("Reviewing findings for gaps…");
    };
    const result = await orchestrateResearch({
      streamId: `research-${crypto.randomUUID()}`,
      model,
      // publicOrigin only matters for image_search proxy rewriting, which
      // research doesn't use; web_search/web_fetch work without it.
      publicOrigin: "",
      conv: [{ role: "user", content: input.prompt }],
      userQuestion: input.prompt,
      // canHandoff:false ⇒ the orchestrator ignores this deadline and runs every
      // round to completion; the worker's own kill timer is the real backstop.
      workerDeadlineAt: Date.now() + 55 * 60_000,
      canHandoff: false,
      emit,
      shouldStop: input.shouldStop,
    });
    briefsContext = result.briefsContext;
  } catch (err) {
    // A user Stop must propagate as-is so the producer marks the run "stopped"
    // (terminal, no error banner / no exception logging) rather than a failure.
    if (err instanceof UserStoppedError) throw err;
    return {
      status: 500,
      payload: { error: `Research failed: ${err instanceof Error ? err.message : String(err)}`, model },
    };
  }

  // --- Stage 2: structured synthesis of the briefs ---
  if (input.shouldStop) {
    let stop = false;
    try {
      stop = await input.shouldStop();
    } catch {
      stop = false;
    }
    if (stop) throw new UserStoppedError("Stopped before synthesis.");
  }
  report("Compiling structured results…");
  const conv: OllamaMessage[] = [
    { role: "system", content: currentDateSystemLine() },
    { role: "system", content: RESEARCH_SYNTHESIS_SYSTEM },
    { role: "system", content: LIVE_LINKS_NOTE },
  ];
  if (wantsJson) {
    conv.push({
      role: "system",
      content: `${JSON_INSTRUCTION}\n\nSchema:\n${JSON.stringify(input.schema, null, 2)}`,
    });
  }
  conv.push({
    role: "user",
    content: `${briefsContext}\n\n---\n\nUSER REQUEST:\n${input.prompt}`,
  });

  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  async function chatWithTimeout(options: Parameters<typeof llm.chat>[0]) {
    return withDeadline(() => llm.chat(options), deadline, "Research synthesis");
  }

  async function stopped(): Promise<boolean> {
    if (!input.shouldStop) return false;
    try {
      return await input.shouldStop();
    } catch {
      return false;
    }
  }

  try {
    // Tool-enabled gathering loop: the synthesizer can fire web_search/web_fetch
    // to fill fields the briefs under-transcribed (contacts, emails, open roles)
    // before committing to the structured answer. format:"json" can't coexist
    // with tools, so the final enforceStructured pass owns JSON conformance —
    // exactly the shape executeQuery uses when web tools are on.
    const synthTools: Tool[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
    let finalText = "";
    for (let round = 0; round < SYNTHESIS_MAX_TOOL_ROUNDS; round++) {
      if (await stopped()) throw new UserStoppedError("Stopped during synthesis.");
      const res = await chatWithTimeout({
        model,
        messages: conv,
        tools: synthTools,
        stream: false,
      });
      const msg = res.message;
      const calls = (msg.tool_calls ?? []) as ToolCall[];
      finalText = msg.content ?? "";
      if (calls.length === 0) break;
      if (round > 0) report("Filling in missing details…");
      conv.push({ role: "assistant", content: finalText, tool_calls: calls });
      for (const call of calls) {
        const r = await withDeadline(
          () =>
            executeTool(
              call.function.name,
              call.function.arguments as Record<string, unknown>
            ),
          deadline,
          `tool:${call.function.name}`,
          TOOL_TIMEOUT_MS
        );
        conv.push({
          role: "tool",
          content: JSON.stringify(r.ok ? r.result : { error: r.error }),
          tool_name: call.function.name,
        } as OllamaMessage);
      }
    }
    // The gathering loop only keeps `finalText` from a tool-FREE model turn - a
    // turn that also makes tool calls carries no prose. So if the model was
    // still calling web tools when the loop hit SYNTHESIS_MAX_TOOL_ROUNDS,
    // `finalText` is empty even though the research fully ran: the orchestrator
    // produced briefs and the synthesizer burned all 8 rounds gathering, but it
    // never converged to a written answer. That is the "did a ton of research
    // but the report came back empty" bug. Force ONE final tool-free turn so the
    // model is compelled to write the report from everything already in `conv`.
    // (The structured path below has enforceStructured as its own backstop; the
    // report path had none, so an exhausted loop returned a blank report.)
    if (!wantsJson && finalText.trim().length === 0) {
      report("Writing the report…");
      const res = await chatWithTimeout({
        model,
        messages: [
          ...conv,
          {
            role: "user",
            content:
              "Write the full research report now, using everything gathered above. " +
              "Do not call any tools - respond with the finished report as markdown, " +
              "with inline citations and a Sources list.",
          },
        ],
        stream: false,
      });
      finalText = res.message?.content ?? "";
    }

    conv.push({ role: "assistant", content: finalText });

    if (!wantsJson) {
      return { status: 200, payload: { text: finalText, model } };
    }

    const enforced = await enforceStructured({
      initialText: finalText,
      schema: input.schema,
      runRepair: async (instruction) => {
        conv.push({ role: "user", content: instruction });
        const synth = await chatWithTimeout({
          model,
          messages: conv,
          stream: false,
          ...(model.startsWith("gpt-oss") ? {} : { format: "json" }),
        });
        const out = synth.message?.content ?? "";
        conv.push({ role: "assistant", content: out });
        return out;
      },
    });
    if (!enforced.ok) {
      return {
        status: 502,
        payload: { error: enforced.error, text: enforced.text.slice(0, 1000), model },
      };
    }
    return { status: 200, payload: { text: enforced.text, json: enforced.json, model } };
  } catch (err) {
    return {
      status: 500,
      payload: { error: err instanceof Error ? err.message : "Unknown error", model },
    };
  }
}

// ---- code-execution sandbox (artifact.exec / run_code) -------------------

import type { AttachedFile } from "@/app/db";

export type CodeInput = {
  language: "python" | "node";
  code: string;
  stdin?: string;
  inputFiles?: AttachedFile[];
  userHash: string;
  timeoutMs?: number;
  appId?: string;
};

export type CodeOutcome = {
  status: number;
  payload: {
    ok: boolean;
    language?: "python" | "node";
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    /** Pointers to files the run produced (already uploaded to Blob). */
    files?: AttachedFile[];
    error?: string;
  };
};

/**
 * Run one sandbox program for a saved app. Thin wrapper over the same
 * app/lib/exec/sandbox.ts executor the chat run_code tool uses, returning a
 * uniform {status, payload} the /api/exec resume route surfaces to the iframe.
 * Dynamic import keeps node:child_process / node:fs out of the Vercel bundle.
 */
export async function executeCode(input: CodeInput): Promise<CodeOutcome> {
  try {
    const { runCode } = await import("@/app/lib/exec/sandbox");
    const r = await runCode(
      {
        language: input.language,
        code: input.code,
        stdin: input.stdin,
        input_files: (input.inputFiles ?? []).map((f) => f.name),
        timeout_ms: input.timeoutMs,
      },
      {
        available: input.inputFiles ?? [],
        userHash: input.userHash,
        sessionId: input.appId ?? "exec",
      }
    );
    if (!r.ok) {
      return { status: 400, payload: { ok: false, error: r.error } };
    }
    const result = r.result as {
      language?: "python" | "node";
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: 200,
      payload: {
        ok: true,
        language: result.language,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        files: r.files ?? [],
      },
    };
  } catch (err) {
    return {
      status: 500,
      payload: {
        ok: false,
        error: err instanceof Error ? err.message : "Sandbox execution failed",
      },
    };
  }
}
