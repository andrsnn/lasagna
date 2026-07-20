import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Esbuild ships native binaries that the Next.js bundler shouldn't try to bundle.
  // Marking it as external for server components keeps the binary on disk and
  // loaded via require() at runtime.
  //
  // puppeteer-core is reached via a runtime dynamic import in
  // app/lib/web/agentic.ts (the Advanced Web `browse_page` tool). Keeping it
  // external means it's loaded from node_modules at runtime rather than bundled
  // into the Vercel function — the headless browser only actually runs in the
  // Fly worker, which has the Chromium binary (see worker/Dockerfile).
  serverExternalPackages: ["esbuild", "puppeteer-core"],
};

export default nextConfig;
