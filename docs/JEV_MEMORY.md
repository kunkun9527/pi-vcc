# Optional Jev long-term memory scoring

The default pi-vcc behavior is **offline and deterministic**. It preserves
critical user constraints and unresolved blockers in the `[Long-term Memory]`
section of each summary (8 of each category, plus 8 decisions). The original
Pi JSONL session file remains the source of truth; no messages are deleted.

## Enable optional hosted Jev scoring

```sh
export PI_VCC_JEV_ENABLED=1
export JEVMODEL_API_KEY="your-api-key"
```

No API key or unset opt-in means **zero network requests**. With opt-in,
pi-vcc scores up to four decision candidates at completed `agent_end` turns,
not during compaction. The scoring API is `POST https://jevmodel.org/v1/systemone`,
using the `jev-latest` model and one `score` question per candidate.
Decisions are ranked by score, then recency. Explicit constraints and
unresolved blockers are never pruned based on model scores.

**Privacy:** Jev is an external provider. A bounded excerpt of a historical
decision is sent only when explicitly enabled; email addresses, common API
key patterns, URLs, and absolute home paths are redacted best-effort.
This is not a complete personal-information or secrets detector.
Do not enable it for sensitive transcripts without review and consent.

If Jev times out (1.8 seconds per candidate), returns an invalid response,
or has no credits, scoring stops and deterministic ranking remains in effect.
Network errors cannot prevent `/compact` or `/pi-vcc` from completing.
There are no retries inside the active session. No key or raw request text
is included in diagnostic logs.

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
