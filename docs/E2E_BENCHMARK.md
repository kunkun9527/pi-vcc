# Long-session end-to-end verification

The integration suite is intentionally **offline**. It does not claim any real
model answer-accuracy result or Jev improvement without a live provider.

CI now runs two independent checks:

1. `bun test tests/session-jsonl-e2e.test.ts` simulates 200 sequential Chinese
   compactions. It verifies a user constraint and unresolved blocker with
   persistent **exact source entry IDs**, checks protected memory integrity
   after every handoff, writes a real Pi-style JSONL session, and uses the
   registered `vcc_recall` tool to recover the exact original content.
   It also checks that the active-lineage scope refuses off-branch evidence.
2. `bun run test:host` executes `scripts/pi1-host.mjs` with the actual
   `@earendil-works/pi-coding-agent` 1.3.0 SDK and fake offline provider.
   It loads the extension, compacts through real host lifecycle hooks,
   checks nested tool calls and reload, and must not issue summarizer calls.

## Run

```sh
bun install
bun run typecheck
bun test tests/session-jsonl-e2e.test.ts
bun run test:host
```

## Interpretation

Structural memory retention and evidence recovery are testable without
network access; semantic answer accuracy, cost, p95 latency and Jev benefit
require a separate real-model benchmark with consent and API credentials.
The CI exercise is not 200 paid model turns, and it does not prove all
possible Pi providers support identical compaction behavior.
