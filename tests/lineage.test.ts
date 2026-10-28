import { describe, it, expect } from "bun:test";
import { getActiveLineageEntryIds } from "../src/core/lineage";

describe("getActiveLineageEntryIds", () => {
  it("returns IDs from active branch", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("fails closed when getBranch throws even if getEntries includes old branches", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => [{ id: "x" }, { id: "y" }],
    });
    expect([...ids]).toEqual([]);
  });

  it("returns empty set when both branch and entries are unavailable", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => {
        throw new Error("boom2");
      },
    });
    expect(ids.size).toBe(0);
  });
  it("returns an empty set when branch has no active entries", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => [],
      getEntries: () => [{ id: "off-branch-secret" }],
    });
    expect([...ids]).toEqual([]);
  });

});
