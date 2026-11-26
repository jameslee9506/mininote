import { describe, expect, it } from "vitest";
import { recentNotes, startOfDay, timeStyle, unlisted, withSave, type SavedTimes } from "./recent";
import { buildTree } from "./tree";

/** The nodes of a listing of notes, each with its modification time. */
function listed(files: Record<string, number>) {
  const paths = Object.keys(files);
  return buildTree({ paths, kinds: "f".repeat(paths.length), mtimes: paths.map((p) => files[p]) }).nodes;
}

const notesOf = (nodes: ReturnType<typeof listed>) => [...nodes.values()].filter((n) => n.fileKind === "note");
const NONE: SavedTimes = new Map();

describe("recent notes", () => {
  it("lists the notes changed last, the newest first", () => {
    const nodes = listed({ "a.md": 10, "b.md": 30, "c.md": 20, "pic.png": 99, "unknown.md": 0 });
    expect(recentNotes(notesOf(nodes), NONE, 10).map((r) => r.node.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(recentNotes(notesOf(nodes), NONE, 2).map((r) => r.node.path)).toEqual(["b.md", "c.md"]);
  });

  it("puts a note saved since the listing first, with the time of that save", () => {
    const nodes = listed({ "a.md": 10, "b.md": 30 });
    const times = withSave(NONE, "a.md", 40.7);
    expect(recentNotes(notesOf(nodes), times, 10)).toMatchObject([
      { node: { path: "a.md" }, mtime: 40 },
      { node: { path: "b.md" }, mtime: 30 },
    ]);
    // An older time never replaces a newer one.
    expect(withSave(times, "a.md", 35)).toBe(times);
  });

  it("drops a save once a listing reports it, or no longer has its path", () => {
    const times = withSave(withSave(withSave(NONE, "a.md", 40), "b.md", 50), "gone.md", 60);
    const settled = unlisted(times, listed({ "a.md": 40, "b.md": 45 }));
    expect([...settled]).toEqual([["b.md", 50]]);
    expect(unlisted(settled, listed({ "a.md": 40, "b.md": 45 }))).toBe(settled);
  });

  it("shows a time of day for today, and a date before it", () => {
    const now = new Date(2026, 10, 26, 15, 30).getTime();
    const today = startOfDay(now);
    expect(today).toBe(new Date(2026, 10, 26).getTime());
    expect(timeStyle(now, today)).toBe("time");
    expect(timeStyle(today, today)).toBe("time");
    expect(timeStyle(today - 1, today)).toBe("day");
    // A time ahead of the clock is no time of today either.
    expect(timeStyle(new Date(2026, 10, 27, 9).getTime(), today)).toBe("day");
    expect(timeStyle(new Date(2025, 11, 31).getTime(), today)).toBe("date");
  });
});
