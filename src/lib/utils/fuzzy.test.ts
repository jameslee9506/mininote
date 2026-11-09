import { describe, expect, it } from "vitest";
import { choseong, fuzzyMatch, fuzzyRank } from "./fuzzy";

describe("fuzzy", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("mn", "MiniNote")?.positions).toEqual([0, 4]);
    expect(fuzzyMatch("xyz", "MiniNote")).toBeNull();
  });

  it("ranks contiguous and early matches higher", () => {
    const ranked = fuzzyRank("note", ["a note", "notebook", "n-o-t-e"], (s) => s, 10).map((r) => r.item);
    expect(ranked[0]).toBe("notebook");
    expect(ranked.at(-1)).toBe("n-o-t-e");
  });

  it("matches NFD Hangul names with NFC queries", () => {
    expect(fuzzyMatch("\uD55C\uAE00", "\uD55C\uAE00 \uB178\uD2B8".normalize("NFD"))).not.toBeNull();
  });

  it("matches while the last Hangul syllable is still being composed", () => {
    expect(fuzzyMatch("\uD558", "\uD55C\uAE00")?.positions).toEqual([0]);
    expect(fuzzyMatch("\uD55C\uADF8", "\uD55C\uAE00 \uB178\uD2B8")?.positions).toEqual([0, 1]);
    expect(fuzzyMatch("\u3134", "\uD55C\uAE00 \uB178\uD2B8")?.positions).toEqual([3]);
    expect(fuzzyMatch("\uD558", "\uD638\uBC15")).toBeNull();
  });

  it("supports Hangul initial-consonant queries", () => {
    expect(choseong("\uD55C\uAE00 \uB178\uD2B8")).toBe("\u314E\u3131 \u3134\u314C");
    expect(fuzzyMatch("\u314E\u3131", "\uD55C\uAE00 \uB178\uD2B8")?.positions).toEqual([0, 1]);
    expect(fuzzyMatch("\u3134\u314C", "\uD68C\uC758\uB85D")).toBeNull();
  });
});
