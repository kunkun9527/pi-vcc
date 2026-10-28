import { readSessionEntries, readSessionEntryById } from "./session-jsonl";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  /** Stable Pi session entry IDs aligned with rendered/rawMessages. */
  entryIds: string[];
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
  /** Optional filter by global message index (for compaction-scoped searches) */
  entryFilter?: (globalIndex: number) => boolean,
): LoadedMessages => {
  const entries = readSessionEntries(sessionFile);
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];
  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = (!allowedEntryIds || allowedEntryIds.has(e.id)) &&
      (!entryFilter || entryFilter(messageIndex));
    if (allowed) {
      const original = full && e.vccOmittedBytes && typeof e.id === "string"
        ? readSessionEntryById(sessionFile, e.id)?.message ?? e.message : e.message;
      rendered.push(renderMessage(original, messageIndex, full));
      rawMessages.push(original);
      entryIds.push(typeof e.id === "string" ? e.id : "");
    }
    messageIndex++;
  }

  return { rendered, rawMessages, entryIds };
};
