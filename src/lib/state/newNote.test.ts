import { describe, expect, it } from "vitest";
import { canDiscardNewNote, type NewNoteSnapshot } from "./newNote";

const created: NewNoteSnapshot = { epoch: 1, path: "Notes/\uC81C\uBAA9 \uC5C6\uC74C 2.md", revision: 5 };

describe("canDiscardNewNote", () => {
  it("accepts Unicode titles and the generated collision suffix", () => {
    expect(canDiscardNewNote(created, created, "")).toBe(true);
    expect(canDiscardNewNote(created, created, "", "\uC81C\uBAA9 \uC5C6\uC74C 2".normalize("NFD"))).toBe(true);
    const english = { ...created, path: "Untitled 1.md" };
    expect(canDiscardNewNote(english, english, "", "Untitled 1")).toBe(true);
  });

  it("preserves existing notes, even when their name looks like a new note", () => {
    expect(canDiscardNewNote(null, created, "")).toBe(false);
    expect(canDiscardNewNote(created, { ...created, path: "Notes/\uC81C\uBAA9 \uC5C6\uC74C.md" }, "")).toBe(false);
    expect(canDiscardNewNote(created, { ...created, epoch: 2 }, "")).toBe(false);
  });

  it("preserves edited or reopened notes, including text erased or undone back to empty", () => {
    expect(canDiscardNewNote(created, { ...created, revision: 6 }, "")).toBe(false);
    expect(canDiscardNewNote(created, created, "text")).toBe(false);
    expect(canDiscardNewNote(created, created, " \n")).toBe(false);
  });

  it("preserves renamed notes and uncommitted custom titles", () => {
    expect(canDiscardNewNote(created, { ...created, path: "Notes/Meeting.md" }, "")).toBe(false);
    expect(canDiscardNewNote(created, created, "", "Meeting")).toBe(false);
    expect(canDiscardNewNote(created, created, "", "\uC81C\uBAA9 \uC5C6\uC74C 3")).toBe(false);
    expect(canDiscardNewNote(created, created, "", "")).toBe(false);
  });
});
