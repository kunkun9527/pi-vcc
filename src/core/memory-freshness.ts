import { execFileSync } from "node:child_process";
import type { MemoryFact } from "./long-memory";

/** A file change invalidates the freshness of a remembered code claim, not
 * the original user's instruction. Nothing is silently deleted or rewritten.
 * "tracked" means unchanged since recording, NOT semantically verified.
 */
export type FreshnessState = "tracked" | "needs-review" | "unknown";
export interface CodeChangeSnapshot {
  head: string;
  dirtyPaths: ReadonlySet<string>;
  changedSince(commit: string): ReadonlySet<string> | undefined;
}
const FILE_PATTERN = /(?:[a-zA-Z0-9_.-]+\/){0,5}[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|json|yaml|yml|toml|md|sql|sh|css|html|vue|svelte)\b/gu;

export function extractMemoryFiles(text: string): string[] {
  return [...new Set(text.match(FILE_PATTERN) ?? [])].filter(path =>
    path.length <= 36 && !path.split("/").includes("..") && !path.startsWith("/"),
  ).slice(0, 2);
}

export function trackCodeMemory(facts: MemoryFact[], snapshot?: CodeChangeSnapshot): MemoryFact[] {
  return facts.map(fact => {
    const files = fact.relatedFiles?.length ? fact.relatedFiles : extractMemoryFiles(fact.text);
    if (!files.length) return fact;
    const baselineCommit = fact.baselineCommit ?? snapshot?.head;
    let freshness: FreshnessState = fact.freshness ?? "unknown";
    if (fact.freshness === "needs-review") freshness = "needs-review";
    else if (!baselineCommit || !snapshot) freshness = "unknown";
    else {
      const changed = snapshot.changedSince(baselineCommit);
      if (!changed) freshness = "needs-review"; // missing git history: fail safely
      else freshness = files.some(file => changed.has(file) || snapshot.dirtyPaths.has(file))
        ? "needs-review" : "tracked";
    }
    return { ...fact, relatedFiles: files, baselineCommit, freshness };
  });
}

/** Collect one project snapshot per compaction. Subprocesses have timeouts and
 * no shell; repo errors return undefined, leaving facts visibly unknown.
 */
export function captureCodeChangeSnapshot(cwd: string): CodeChangeSnapshot | undefined {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, {
        cwd, encoding: "utf8", timeout: 1500, maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch { return undefined; }
  };
  const head = run(["rev-parse", "--verify", "HEAD"]);
  if (!head || !/^[0-9a-f]{40,64}$/iu.test(head)) return undefined;
  const repoRoot = run(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return undefined;
  const normalizePaths = (output: string | undefined) => output === undefined ? undefined
    : new Set(output.split("\n").map(p => p.trim()).filter(Boolean));
  const dirty = normalizePaths(run(["diff", "--name-only", "HEAD"])) ?? new Set<string>();
  const untracked = normalizePaths(run(["ls-files", "--others", "--exclude-standard"])) ?? new Set<string>();
  for (const path of untracked) dirty.add(path);
  const cache = new Map<string, ReadonlySet<string> | undefined>();
  return {
    head,
    dirtyPaths: dirty,
    changedSince(commit: string): ReadonlySet<string> | undefined {
      if (!/^[0-9a-f]{8,64}$/iu.test(commit)) return undefined;
      if (cache.has(commit)) return cache.get(commit);
      const changed = normalizePaths(run(["diff", "--name-only", commit, head]));
      cache.set(commit, changed);
      return changed;
    },
  };
}
