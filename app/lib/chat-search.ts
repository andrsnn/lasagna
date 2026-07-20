/**
 * Tiny purpose-built inverted index for the /chats search box.
 *
 * Designed to be:
 *   - cheap to build (single pass per chat, no third-party deps)
 *   - cheap to update incrementally (per-chat token sets stored alongside the
 *     postings so a chat can be removed and re-added without rebuilding)
 *   - cheap to persist (the on-disk shape is just the per-chat rows; the
 *     postings map is reconstructed on hydration in one O(tokens) pass)
 *   - cheap to query (token lookup is a Map hit; last-token prefix scan walks
 *     the sorted token list with binary search + linear scan)
 *
 * Scoring is BM25-lite: title hits weighted, idf computed against numChats,
 * no length normalization (corpus is small — usually < 1k chats).
 */

export type ChatRow = {
  id: string;
  title: string;
  body: string; // joined message content; caller is responsible for capping
  indexedAt: number;
};

type Posting = { chatId: string; tf: number; inTitle: boolean };

type ByChatEntry = {
  tokens: string[]; // unique tokens contributed by this chat
  title: string;
  body: string;
  indexedAt: number;
};

export type ChatIndex = {
  postings: Map<string, Posting[]>;
  sortedTokens: string[]; // for prefix scans
  byChat: Map<string, ByChatEntry>;
  numChats: number;
  builtAt: number;
};

export type ChatSearchHit = {
  chatId: string;
  score: number;
  preview: string;
};

// Bump on any change to what gets indexed (e.g. body now includes artifact
// HTML and proposedVfs file contents) so existing caches are dropped on
// load instead of serving stale results.
export type PersistedChatIndex = {
  version: 2;
  builtAt: number;
  chats: Record<
    string,
    { tokens: string[]; title: string; body: string; indexedAt: number }
  >;
};

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is"]);
const TOKEN_RE = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** Build an index from scratch. */
export function buildChatIndex(rows: ChatRow[]): ChatIndex {
  const index: ChatIndex = {
    postings: new Map(),
    sortedTokens: [],
    byChat: new Map(),
    numChats: 0,
    builtAt: Date.now(),
  };
  for (const row of rows) addOrReplace(index, row);
  finalize(index);
  return index;
}

/**
 * Patch in place. Upserts overwrite existing postings for that chat; removes
 * drop them. Returns the same ChatIndex reference (mutated) so callers can
 * keep a stable identity if they want, but the React layer treats it as
 * immutable and re-wraps via setState.
 */
export function patchChatIndex(
  index: ChatIndex,
  upserts: ChatRow[],
  removeIds: ReadonlyArray<string>
): ChatIndex {
  for (const id of removeIds) removeChat(index, id);
  for (const row of upserts) addOrReplace(index, row);
  index.builtAt = Date.now();
  finalize(index);
  return index;
}

function addOrReplace(index: ChatIndex, row: ChatRow): void {
  // If this chat is already indexed, drop its old postings first so we don't
  // double-count tokens that survived the rebuild.
  if (index.byChat.has(row.id)) removeChat(index, row.id);

  const titleTokens = tokenize(row.title);
  const bodyTokens = tokenize(row.body);
  const titleSet = new Set(titleTokens);
  const allCounts = countTokens([...titleTokens, ...bodyTokens]);

  for (const [token, tf] of allCounts) {
    const list = index.postings.get(token);
    const posting: Posting = { chatId: row.id, tf, inTitle: titleSet.has(token) };
    if (list) list.push(posting);
    else index.postings.set(token, [posting]);
  }

  index.byChat.set(row.id, {
    tokens: [...allCounts.keys()],
    title: row.title,
    body: row.body,
    indexedAt: row.indexedAt,
  });
  index.numChats = index.byChat.size;
}

function removeChat(index: ChatIndex, chatId: string): void {
  const entry = index.byChat.get(chatId);
  if (!entry) return;
  for (const token of entry.tokens) {
    const list = index.postings.get(token);
    if (!list) continue;
    const filtered = list.filter((p) => p.chatId !== chatId);
    if (filtered.length === 0) index.postings.delete(token);
    else index.postings.set(token, filtered);
  }
  index.byChat.delete(chatId);
  index.numChats = index.byChat.size;
}

function finalize(index: ChatIndex): void {
  index.sortedTokens = [...index.postings.keys()].sort();
}

/**
 * Score chats against a free-form query. Last query token does prefix
 * matching so typeahead (e.g. "ze" → "zenscreen") works mid-word.
 */
export function searchChatIndex(
  index: ChatIndex,
  query: string,
  limit = 50
): ChatSearchHit[] {
  const trimmed = query.trim();
  if (!trimmed || index.numChats === 0) return [];

  const rawTokens = tokenize(trimmed);
  if (rawTokens.length === 0) return [];

  // Detect whether the user is mid-word — if the raw query doesn't end with a
  // word break, treat the last token as a prefix.
  const lastChar = trimmed[trimmed.length - 1];
  const lastIsPartial = /[a-z0-9]/i.test(lastChar);
  const lastToken = rawTokens[rawTokens.length - 1];

  const scores = new Map<string, number>();
  const matchedQueryTerms = new Map<string, Set<string>>(); // chatId -> raw terms it matched
  // termHits[i] = set of chatIds that satisfied rawTokens[i]. Used to enforce
  // AND semantics so a query like "ollama-models" doesn't surface chats that
  // only contain "models" with no "ollama" anywhere.
  const termHits: Set<string>[] = [];

  const recordTerm = (chatId: string, term: string) => {
    const set = matchedQueryTerms.get(chatId);
    if (set) set.add(term);
    else matchedQueryTerms.set(chatId, new Set([term]));
  };

  for (let i = 0; i < rawTokens.length; i++) {
    const term = rawTokens[i];
    const isLast = i === rawTokens.length - 1;
    const candidates =
      isLast && lastIsPartial && term.length >= 2
        ? prefixTokens(index, term)
        : index.postings.has(term)
          ? [term]
          : [];

    const hitsForTerm = new Set<string>();
    termHits.push(hitsForTerm);

    for (const tok of candidates) {
      const list = index.postings.get(tok);
      if (!list) continue;
      const df = list.length;
      const idf = Math.log(1 + index.numChats / df);
      // Exact matches outrank prefix expansions; weight prefix hits half.
      const expansion = tok === term ? 1 : 0.5;
      for (const p of list) {
        const inc = idf * (p.tf + (p.inTitle ? 3 : 0)) * expansion;
        scores.set(p.chatId, (scores.get(p.chatId) ?? 0) + inc);
        recordTerm(p.chatId, tok);
        hitsForTerm.add(p.chatId);
      }
    }

    // Short-circuit: if any required term has zero matches, no chat can
    // satisfy the conjunction.
    if (hitsForTerm.size === 0) return [];
  }

  if (scores.size === 0) return [];

  const hits: ChatSearchHit[] = [];
  for (const [chatId, score] of scores) {
    // AND filter: the chat must have matched every query term.
    let satisfiedAll = true;
    for (const set of termHits) {
      if (!set.has(chatId)) {
        satisfiedAll = false;
        break;
      }
    }
    if (!satisfiedAll) continue;
    const entry = index.byChat.get(chatId);
    if (!entry) continue;
    const terms = matchedQueryTerms.get(chatId);
    hits.push({ chatId, score, preview: makePreview(entry.body, terms) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function prefixTokens(index: ChatIndex, prefix: string): string[] {
  // Binary search for first token >= prefix, then linear walk while the
  // token still starts with prefix. Cap to keep pathological prefixes
  // (e.g. "a") from blowing up.
  const arr = index.sortedTokens;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < arr.length && arr[i].startsWith(prefix); i++) {
    out.push(arr[i]);
    if (out.length >= 24) break;
  }
  return out;
}

const PREVIEW_WINDOW = 140;

function makePreview(body: string, matchedTerms: Set<string> | undefined): string {
  if (!body) return "";
  if (!matchedTerms || matchedTerms.size === 0) {
    return body.length > PREVIEW_WINDOW ? body.slice(0, PREVIEW_WINDOW) + "…" : body;
  }
  const lower = body.toLowerCase();
  let earliest = -1;
  let earliestLen = 0;
  for (const term of matchedTerms) {
    const idx = lower.indexOf(term);
    if (idx === -1) continue;
    if (earliest === -1 || idx < earliest) {
      earliest = idx;
      earliestLen = term.length;
    }
  }
  if (earliest === -1) {
    return body.length > PREVIEW_WINDOW ? body.slice(0, PREVIEW_WINDOW) + "…" : body;
  }
  const half = Math.floor((PREVIEW_WINDOW - earliestLen) / 2);
  const start = Math.max(0, earliest - half);
  const end = Math.min(body.length, start + PREVIEW_WINDOW);
  let snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < body.length) snippet = snippet + "…";
  return snippet;
}

// --------- persistence ----------

export function indexToPersisted(index: ChatIndex): PersistedChatIndex {
  const chats: PersistedChatIndex["chats"] = {};
  for (const [id, entry] of index.byChat) {
    chats[id] = {
      tokens: entry.tokens,
      title: entry.title,
      body: entry.body,
      indexedAt: entry.indexedAt,
    };
  }
  return { version: 2, builtAt: index.builtAt, chats };
}

export function indexFromPersisted(p: PersistedChatIndex): ChatIndex {
  const index: ChatIndex = {
    postings: new Map(),
    sortedTokens: [],
    byChat: new Map(),
    numChats: 0,
    builtAt: p.builtAt,
  };
  for (const [id, entry] of Object.entries(p.chats)) {
    // Re-derive postings from the stored token list. We re-tokenize body
    // because tf counts aren't stored on disk (they're cheap to recompute
    // and would otherwise double the persisted size).
    const titleTokens = tokenize(entry.title);
    const bodyTokens = tokenize(entry.body);
    const titleSet = new Set(titleTokens);
    const counts = countTokens([...titleTokens, ...bodyTokens]);
    for (const [token, tf] of counts) {
      const posting: Posting = { chatId: id, tf, inTitle: titleSet.has(token) };
      const list = index.postings.get(token);
      if (list) list.push(posting);
      else index.postings.set(token, [posting]);
    }
    index.byChat.set(id, {
      tokens: entry.tokens,
      title: entry.title,
      body: entry.body,
      indexedAt: entry.indexedAt,
    });
  }
  index.numChats = index.byChat.size;
  finalize(index);
  return index;
}
