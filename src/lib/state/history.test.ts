import { describe, expect, it } from "vitest";
import { NavHistory } from "./history";

const visit = (h: NavHistory, ...paths: string[]) => paths.forEach((path) => h.push({ path, virtual: false }));

describe("NavHistory", () => {
  it("pushes, truncates forward entries and ignores revisits", () => {
    const h = new NavHistory(3);
    visit(h, "a.md", "b.md", "b.md", "c.md", "d.md");
    expect(h.paths()).toEqual(["b.md", "c.md", "d.md"]);
    h.moveTo(h.neighbor(-1)!);
    visit(h, "e.md");
    expect(h.paths()).toEqual(["b.md", "c.md", "e.md"]);
    expect(h.canForward).toBe(false);
  });

  it("merges neighbors on removal and keeps a current entry that survives", () => {
    const h = new NavHistory();
    visit(h, "a.md", "b.md", "a.md", "c.md");
    h.remove((e) => e.path === "b.md");
    expect(h.paths()).toEqual(["a.md", "c.md"]);
    expect(h.current?.path).toBe("c.md");
    expect(h.canBack).toBe(true);
  });

  it("leaves a gap where the current entry was removed", () => {
    const h = new NavHistory();
    visit(h, "a.md", "b.md", "c.md");
    h.moveTo(h.neighbor(-1)!);
    h.remove((e) => e.path === "b.md");
    expect(h.paths()).toEqual(["a.md", "c.md"]);
    // Nothing takes the removed entry's place: its neighbors are the survivors on both sides.
    expect(h.current).toBeNull();
    expect(h.neighbor(-1)?.path).toBe("a.md");
    expect(h.neighbor(1)?.path).toBe("c.md");
    expect(h.canBack).toBe(true);
    expect(h.canForward).toBe(true);
    // Going back lands on the earlier survivor, with the later one still ahead.
    h.moveTo(h.neighbor(-1)!);
    expect(h.current?.path).toBe("a.md");
    expect(h.canBack).toBe(false);
    expect(h.neighbor(1)?.path).toBe("c.md");
  });

  it("goes on from a gap with the next visit", () => {
    const h = new NavHistory();
    visit(h, "a.md", "b.md", "c.md");
    h.moveTo(h.neighbor(-1)!);
    h.remove((e) => e.path === "b.md");
    visit(h, "d.md");
    expect(h.paths()).toEqual(["a.md", "d.md"]);
    expect(h.current?.path).toBe("d.md");

    // Revisiting the entry before the gap does not record it twice.
    h.remove((e) => e.path === "d.md");
    visit(h, "a.md");
    expect(h.paths()).toEqual(["a.md"]);
    expect(h.current?.path).toBe("a.md");
    expect(h.canBack).toBe(false);
  });

  it("has no way back from a gap at the start", () => {
    const h = new NavHistory();
    visit(h, "a.md", "b.md");
    h.moveTo(h.neighbor(-1)!);
    h.remove((e) => e.path === "a.md");
    expect(h.current).toBeNull();
    expect(h.canBack).toBe(false);
    expect(h.neighbor(-1)).toBeNull();
    expect(h.neighbor(1)?.path).toBe("b.md");
    h.clear();
    visit(h, "c.md");
    expect(h.current?.path).toBe("c.md");
  });

  it("remaps folder prefixes and keeps entry identity", () => {
    const h = new NavHistory();
    visit(h, "x/a.md", "xy/b.md", "x/c.md");
    const first = h.neighbor(-1)!;
    h.remap("x", "z");
    expect(h.paths()).toEqual(["z/a.md", "xy/b.md", "z/c.md"]);
    expect(h.moveTo(first)).toBe(true);
    expect(h.current?.path).toBe("xy/b.md");
  });
});
