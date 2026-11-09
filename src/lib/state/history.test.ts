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

  it("falls back to the previous survivor and merges neighbors on removal", () => {
    const h = new NavHistory();
    visit(h, "a.md", "b.md", "a.md", "c.md");
    h.moveTo(h.neighbor(-1)!);
    h.remove((e) => e.path === "a.md");
    expect(h.paths()).toEqual(["b.md", "c.md"]);
    expect(h.current?.path).toBe("b.md");
    h.remove((e) => e.path === "b.md");
    expect(h.current).toBeNull();
    expect(h.canForward).toBe(true);
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
