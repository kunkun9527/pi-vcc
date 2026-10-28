# Deterministic CJK support

This fork adds character-aware transcript truncation, CJK sentence boundaries,
Chinese intent and cause detection, lexical bigram recall, and conservative
mixed Han/English token estimates.

- Compaction remains free of LLM calls.
- Chinese recall is substring and bigram-based, not semantic retrieval.
- Token counts are heuristics. Actual usage depends on the active model tokenizer.
- English and other languages retain the original behavior wherever possible.
- Inspired by TextFold's multilingual design: https://github.com/chenxiachan/textfold
  (Apache-2.0); this TypeScript implementation is independent.

Test: `bun test tests/cjk-text.test.ts tests/cjk-intent.test.ts tests/cjk-recall.test.ts tests/cjk-tokens.test.ts`
