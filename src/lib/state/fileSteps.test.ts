import { describe, expect, it } from "vitest";
import { StepHistory } from "./fileSteps";

describe("StepHistory", () => {
  it("undoes newest first and redoes what was undone", () => {
    const h = new StepHistory<string>();
    h.record("undo rename");
    h.record("undo delete");
    expect(h.take("redo")).toBeNull();

    expect(h.take("undo")).toBe("undo delete");
    h.performed("undo", "redo delete");
    expect(h.take("undo")).toBe("undo rename");
    h.performed("undo", "redo rename");
    expect(h.canUndo).toBe(false);

    // Redo goes the other way round, and each redone step can be undone again.
    expect(h.take("redo")).toBe("redo rename");
    h.performed("redo", "undo rename again");
    expect(h.take("undo")).toBe("undo rename again");
    expect(h.take("redo")).toBe("redo delete");
  });

  it("forgets what was undone once a new operation is done", () => {
    const h = new StepHistory<string>();
    h.record("a");
    h.take("undo");
    h.performed("undo", "redo a");
    h.record("b");
    expect(h.canRedo).toBe(false);
    expect(h.take("undo")).toBe("b");
  });

  it("drops a step that failed and keeps one that was put back", () => {
    const h = new StepHistory<string>();
    h.record("a");
    h.record("b");
    // Failed: nothing is reported for it, so the step before it is next.
    expect(h.take("undo")).toBe("b");
    expect(h.take("undo")).toBe("a");
    h.putBack("undo", "a");
    expect(h.take("undo")).toBe("a");
    expect(h.canRedo).toBe(false);
  });

  it("keeps the newest steps within its limit", () => {
    const h = new StepHistory<number>(2);
    h.record(1);
    h.record(2);
    h.record(3);
    expect(h.take("undo")).toBe(3);
    expect(h.take("undo")).toBe(2);
    expect(h.take("undo")).toBeNull();
    h.record(4);
    h.clear();
    expect(h.canUndo).toBe(false);
  });
});
