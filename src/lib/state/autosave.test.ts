import { describe, expect, it } from "vitest";
import { retryDelay, saveDelay, within } from "./autosave";

describe("autosave timing", () => {
  it("debounces 400 ms but never past 2 s after the first unsaved edit", () => {
    expect(saveDelay(1000, 1000, 400, 2000)).toBe(400);
    expect(saveDelay(2800, 1000, 400, 2000)).toBe(200);
    expect(saveDelay(4000, 1000, 400, 2000)).toBe(0);
    expect(saveDelay(5000, 1000, 2000, 10_000)).toBe(2000);
  });

  it("backs off 1, 2, 5, then 10 s", () => {
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([1000, 2000, 5000, 10_000, 10_000]);
  });

  it("bounds waits without rejecting", async () => {
    expect(await within(Promise.resolve(), 50)).toBe(true);
    expect(await within(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await within(new Promise(() => {}), 10)).toBe(false);
  });
});
