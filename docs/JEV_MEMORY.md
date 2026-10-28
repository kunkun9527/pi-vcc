# Optional Jev long-term memory scoring

The default pi-vcc behavior is **offline and deterministic**. It preserves
critical user constraints and unresolved blockers in the `[Long-term Memory]`
section of each summary (8 of each category, plus 8 decisions). The original
Pi JSONL session file remains the source of truth; no messages are deleted.

## Three Jev modes (including shadow)

Choose **off** (no request, default), **shadow** (send scoring requests and record
metadata only, but always preserve deterministic memory/recall ordering), or
**active** (use valid Jev scores and preserve deterministic fallback on failure).

In Pi's TUI, open `/pi-vcc-config` and select **Jev 评分模式**.
Or configure `"jevMode": "off" | "shadow" | "active"` in
`pi-vcc-config.json`. A legacy `"jevEnabled": true` means active.

Environment override precedence is `PI_VCC_JEV_MODE` (off/shadow/active),
then legacy `PI_VCC_JEV_ENABLED` (0/1), then `jevMode`, then
`jevEnabled`. **Every non-off mode still requires `JEVMODEL_API_KEY`.**

Use `/pi-vcc-jev-stats` to view batch counts, fallbacks, shadow runs, potential
reorders and average latency. A local metadata-only ledger is stored at the
Pi agent directory's `pi-vcc-jev-ledger.jsonl` (override with
`PI_VCC_JEV_LEDGER_PATH`). It contains timestamps, mode, counts, success,
priority-change flags (against deterministic recency for memory) and latency only—**no query text, candidate text, memory/source ID,
response payload or API keys**. The ledger rotates at approximately 1 MiB.
Stats are observational and do not prove improved historical answer accuracy.\nChanging the mode invalidates cached active scores immediately, including in-flight results from older generations.\nA changed score is not counted as a priority change unless the candidate order actually differs from the deterministic newest-first baseline.

## Enable optional hosted Jev scoring

```sh
export PI_VCC_JEV_ENABLED=1
export JEVMODEL_API_KEY="your-api-key"
```

No API key or an effective mode of `off` means **zero network requests**. With opt-in,
pi-vcc scores up to four decision candidates at completed `agent_end` turns,
not during compaction. The scoring API is `POST https://jevmodel.org/v1/systemone`,
using the `jev-latest` model and **one batch request** containing independent score questions per candidate.
Decisions are ranked by score, then recency. Explicit constraints and
unresolved blockers are never pruned based on model scores.

**Privacy:** Jev is an external provider. A bounded excerpt of a historical
decision is sent only when explicitly enabled; email addresses, common API
key patterns, URLs, and absolute home paths are redacted best-effort.
This is not a complete personal-information or secrets detector.
Do not enable it for sensitive transcripts without review and consent.

If Jev times out (1.8 seconds per batch), returns an invalid response,
or has no credits, scoring stops and deterministic ranking remains in effect.
Network errors cannot prevent `/compact` or `/pi-vcc` from completing.
There are no retries inside the active session. No key or raw request text
is included in diagnostic logs.

## Optional Jev recall reranking

When the same Jev opt-in is enabled, both the `/pi-vcc-recall` command and
`vcc_recall` tool rerank at most the first four **lexically matched** results.
This does not create semantic search hits or change the underlying session
history. The query and each short rendered candidate are redacted using the
same best-effort rules; only truncated text is sent externally.

If a batch fails or even one response is missing/low-confidence, all hits retain their original lexical order. Batches are limited to five candidates, with a bounded payload.
No API call happens for zero or one result, or without both opt-in and key.

## Closing resolved issues

The `[Long-term Memory]` section lists IDs:

```text
[Long-term Memory]
- [blocker:0011aa22] 数据库连接仍然失败，需要继续排查
```

To retire a blocker, the user explicitly writes `已解决：0011aa22`
(or `resolved: 0011aa22`). Assistant claims alone do not clear blockers.
The example ID is illustrative; use the actual ID in the summary.

## Limitations

- A bounded summary cannot retain every old fact forever (maximum 24 records).
- This feature is not an embedding database and does not add semantic recall.
- The Jev adapter scores *decisions*, not entire messages. It does not rewrite text.
- If the agent never reaches `agent_end` before a compaction, the local
  deterministic memory section still works without a Jev score.
- New session branches start without an in-memory Jev score cache;
  structured facts remain in the previous summary and raw JSONL history.

Source and API contract: https://jevmodel.org/docs/
