import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function getSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const sha = getSha();
const publicDir = resolve(process.cwd(), "public");
mkdirSync(publicDir, { recursive: true });
writeFileSync(resolve(publicDir, "v.txt"), sha + "\n");
console.log(`wrote public/v.txt: ${sha}`);
