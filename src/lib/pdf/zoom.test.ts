import { describe, expect, it } from "vitest";
import { clampZoom, formatZoom, MAX_ZOOM, MIN_ZOOM, parsePage, parseZoom, stepZoom } from "./zoom";

describe("stepZoom", () => {
  it("moves from one step to the next", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2 / 3, 1)).toBe(0.75);
    expect(stepZoom(0.5, -1)).toBeCloseTo(1 / 3);
  });

  it("leaves a zoom between two steps for the nearest one on that side", () => {
    expect(stepZoom(0.87, 1)).toBe(0.9);
    expect(stepZoom(0.87, -1)).toBe(0.8);
    // A fitted zoom that shows as a step's percentage counts as that step.
    expect(stepZoom(0.9004, 1)).toBe(1);
    expect(stepZoom(0.8996, -1)).toBe(0.8);
  });

  it("stays at the ends", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(9, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(0.1, -1)).toBe(MIN_ZOOM);
    // From beyond the ends, the first step is the end itself.
    expect(stepZoom(9, -1)).toBe(MAX_ZOOM);
    expect(stepZoom(0.1, 1)).toBe(MIN_ZOOM);
  });
});

describe("parseZoom", () => {
  it("reads a percentage with or without its sign", () => {
    expect(parseZoom("150")).toBe(1.5);
    expect(parseZoom(" 150 % ")).toBe(1.5);
    expect(parseZoom("62.5%")).toBe(0.625);
    expect(parseZoom("62,5")).toBe(0.625);
  });

  it("keeps the zoom within the limits", () => {
    expect(parseZoom("5")).toBe(MIN_ZOOM);
    expect(parseZoom("9000")).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });

  it("refuses anything else", () => {
    for (const text of ["", "%", "abc", "-50", "0", "1e3", "50%%", "5 0"]) expect(parseZoom(text)).toBeNull();
  });
});

describe("parsePage", () => {
  it("reads a page number within the document", () => {
    expect(parsePage("3", 10)).toBe(3);
    expect(parsePage(" 10 ", 10)).toBe(10);
    expect(parsePage("0", 10)).toBe(1);
    expect(parsePage("99", 10)).toBe(10);
  });

  it("refuses anything else", () => {
    for (const text of ["", "x", "1.5", "-2", "3/10"]) expect(parsePage(text, 10)).toBeNull();
    expect(parsePage("1", 0)).toBeNull();
  });
});

describe("formatZoom", () => {
  it("rounds to a whole percentage", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(2 / 3)).toBe("67%");
    expect(formatZoom(0.8749)).toBe("87%");
  });
});
