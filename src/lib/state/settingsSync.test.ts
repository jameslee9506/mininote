import { describe, expect, it } from "vitest";
import { SyncLedger } from "./settingsSync";

describe("SyncLedger", () => {
  it("keeps a local change until its own write comes back", () => {
    const ledger = new SyncLedger();
    expect(ledger.adopts("fontSize")).toBe(true);
    ledger.touch("fontSize");
    expect(ledger.adopts("fontSize")).toBe(false);
    expect(ledger.send()).toEqual(["fontSize"]);
    // Another window's change that arrives now was applied before this write.
    expect(ledger.adopts("fontSize")).toBe(false);
    ledger.landed(["fontSize"]);
    expect(ledger.adopts("fontSize")).toBe(true);
    expect(ledger.send()).toEqual([]);
  });

  it("counts writes still in flight", () => {
    const ledger = new SyncLedger();
    ledger.touch("theme");
    ledger.send();
    ledger.touch("theme");
    ledger.send();
    ledger.landed(["theme"]);
    expect(ledger.adopts("theme")).toBe(false);
    ledger.landed(["theme"]);
    expect(ledger.adopts("theme")).toBe(true);
    // A stray echo never goes below zero.
    ledger.landed(["theme"]);
    ledger.touch("theme");
    ledger.send();
    expect(ledger.adopts("theme")).toBe(false);
  });

  it("sends a failed write again with the next one", () => {
    const ledger = new SyncLedger();
    ledger.touch("a");
    const ids = ledger.send();
    ledger.failed(ids);
    expect(ledger.adopts("a")).toBe(false);
    ledger.touch("b");
    expect(ledger.send().sort()).toEqual(["a", "b"]);
  });
});
