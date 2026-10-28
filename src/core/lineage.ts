interface LineageEntryLike {
  id?: string;
}

interface LineageSessionManagerLike {
  getBranch: () => LineageEntryLike[];
  getEntries?: () => LineageEntryLike[];
}

export const getActiveLineageEntryIds = (sessionManager: LineageSessionManagerLike): Set<string> => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    // An empty active branch is an empty scope, NOT permission to search all history.
    return new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
  } catch {
    // fall through to defensive fallback
  }

  // Fail closed when branch information is unavailable or fails.
  // Cross-branch access is possible only through an explicit scope:'all'.
  return new Set();
};
