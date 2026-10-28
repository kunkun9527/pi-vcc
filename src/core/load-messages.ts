import { readSessionEntries, hydrateSessionEntry } from "./session-jsonl";
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
        ? hydrateSessionEntry(sessionFile, e)?.message ?? e.message : e.message;
      rendered.push(renderMessage(original, messageIndex, full));
      rawMessages.push(original);
      entryIds.push(typeof e.id === "string" ? e.id : "");
    }
    messageIndex++;
  }

  return { rendered, rawMessages, entryIds };
};

/** Exact evidence/expand loader. First applies lineage + scope + index
 * selectors to JSONL metadata; only then decodes requested large payloads.
 * Indices remain global session message indices, including off-lineage turns.
 */
export function loadSelectedMessages(
  sessionFile: string,
  selection: { ids?: ReadonlySet<string>; indices?: ReadonlySet<number> },
  allowedEntryIds?: Set<string>,
  entryFilter?: (globalIndex: number) => boolean,
): LoadedMessages {
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];
  let index = 0;
  for (const entry of readSessionEntries(sessionFile)) {
    if (entry.type !== "message" || !entry.message) continue;
    const selected = (typeof entry.id === "string" && selection.ids?.has(entry.id))
      || selection.indices?.has(index) || false;
    if (selected && (!allowedEntryIds || allowedEntryIds.has(entry.id))
      && (!entryFilter || entryFilter(index))) {
      const message = (entry.vccOmittedBytes
        ? hydrateSessionEntry(sessionFile, entry)?.message
        : entry.message) as Message | undefined;
      if (message) {
        rendered.push(renderMessage(message, index, true));
        rawMessages.push(message);
        entryIds.push(typeof entry.id === "string" ? entry.id : "");
      }
    }
    index++;
  }
  return { rendered, rawMessages, entryIds };
}
