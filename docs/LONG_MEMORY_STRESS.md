# Long-session Chinese memory validation

Run the deterministic tests without any Jev key:

```sh
bun test tests/cjk-memory-150-rounds.test.ts
bun test tests/long-memory.test.ts tests/jev-scorer.test.ts tests/jev-recall.test.ts
bun run typecheck
```

The test uses 150 successive synthetic Chinese compactions with different
module decisions. Two old user constraints and an unresolved blocker must
survive in the structured `[Long-term Memory]` section after **every** round.
The memory section is bounded at 24 facts (8 constraints, 8 blockers,
8 decisions). One final round confirms that explicit user closure removes
only its identified blocker.

This is a reproducible **structural retention** test, not a user study or
a claim that Jev improves semantic answer accuracy. The original session
file and on-demand `vcc_recall` remain the reliable route for exact old text.
An actual Jev API key is not used by CI: HTTP behavior is tested with mocks.

## Next-level benchmark requirements

- Compare a fixed held-out Chinese corpus, including mixed English code
  terms, against deterministic-only and Jev-enabled modes.
- Measure answer correctness and quote provenance separately from
  presence of a keyword in the summary.
- Measure real Jev latency, cost, failure rates, and false-retention
  cases only after explicit private-data authorization and with an API key.
- Run the full automated agent on realistic Pi sessions; unit tests
  do not prove agent behavior across every provider and version.
