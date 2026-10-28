import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevMode } from "./jev-scorer";

/** Metadata-only local ledger. Never record state, query, candidates, IDs,
 * auth headers, answers or secrets. Bound file growth at ~1 MiB.
 */
export type JevOperation = "memory" | "recall";
export interface JevLedgerRecord {
  at: string;
  operation: JevOperation;
  mode: Exclude<JevMode, "off">;
  source: "judge" | "fallback";
  count: number;
  changed: boolean;
  applied: boolean;
  latencyMs: number;
}
const MAX_BYTES = 1024 * 1024;
export const jevLedgerPath = (): string =>
  process.env.PI_VCC_JEV_LEDGER_PATH ?? join(getAgentDir(), "pi-vcc-jev-ledger.jsonl");

export function recordJevEvaluation(input: Omit<JevLedgerRecord, "at">): void {
  try {
    const file = jevLedgerPath();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + ".previous");
    const row: JevLedgerRecord = {
      at: new Date().toISOString(),
      operation: input.operation === "memory" ? "memory" : "recall",
      mode: input.mode === "shadow" ? "shadow" : "active",
      source: input.source === "judge" ? "judge" : "fallback",
      count: Math.max(0, Math.min(5, Math.floor(input.count))),
      changed: input.changed === true,
      applied: input.applied === true,
      latencyMs: Math.max(0, Math.min(60000, Math.round(input.latencyMs))),
    };
    appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch {
    // Statistics must never prevent compaction or recall.
  }
}

/** At most the last 512KiB: no unbounded read for long-lived sessions. */
export function readJevLedger(): JevLedgerRecord[] {
  let fd: number | undefined;
  try {
    const file = jevLedgerPath();
    const fileSize = statSync(file).size;
    const length = Math.min(fileSize, 512 * 1024);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buffer, done, length - done, fileSize - length + done);
      if (!n) break;
      done += n;
    }
    const text = buffer.subarray(0, done).toString("utf8");
    const lines = text.split("\n").slice(length < fileSize ? 1 : 0);
    const result: JevLedgerRecord[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JevLedgerRecord;
        if ((entry.operation === "memory" || entry.operation === "recall")
          && (entry.mode === "shadow" || entry.mode === "active")
          && (entry.source === "judge" || entry.source === "fallback")
          && Number.isFinite(entry.latencyMs)) result.push(entry);
      } catch {}
    }
    return result;
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function jevLedgerSummary(records: readonly JevLedgerRecord[]): string {
  if (!records.length) return "Jev: no scoring records yet.";
  const valid = records.filter(row => row.source === "judge");
  const attempts = records.length;
  const averageMs = Math.round(records.reduce((sum, row) => sum + row.latencyMs, 0) / attempts);
  const changed = valid.filter(row => row.changed).length;
  const applied = records.filter(row => row.applied).length;
  const shadow = records.filter(row => row.mode === "shadow").length;
  const memory = records.filter(row => row.operation === "memory").length;
  return `Jev scoring: ${attempts} batches (${memory} memory, ${attempts - memory} recall)\n` +
    `Valid: ${valid.length}/${attempts}; fallback: ${attempts - valid.length}\n` +
    `Shadow: ${shadow}; active scoring applied: ${applied}; potential priority changes: ${changed}\n` +
    `Average batch latency: ${averageMs} ms\n` +
    "Metadata only: no queries, candidates, source IDs, or API keys are logged.";
}
