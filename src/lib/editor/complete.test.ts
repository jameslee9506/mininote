import { describe, expect, it } from "vitest";
import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownExtensions } from "./syntax";
import { wikiLinkSource } from "./complete";
import type { EditorHost, NoteCandidate } from "./host";

const md = markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions] });

/** A candidate as the host builds it: notes by title, images by full file name. */
function candidate(path: string): NoteCandidate {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const isNote = name.endsWith(".md");
  const title = isNote ? name.slice(0, -3) : name;
  return { path, kind: isNote ? "note" : "image", title, folder: slash < 0 ? "" : path.slice(0, slash), linkText: title };
}

const candidates = [
  "project-plan.md",
  "Notes from meeting.md",
  "work/2024_meeting_notes.md",
  "Notebook.md",
  "Note.md",
  "diagrams.md",
  "attachments/diagram.png",
].map(candidate);
const host = { noteCandidates: () => candidates } as unknown as EditorHost;

/** "§" marks the caret. */
function complete(marked: string): { state: EditorState; result: CompletionResult | null } {
  const pos = marked.indexOf("§");
  const state = EditorState.create({ doc: marked.replace("§", ""), selection: { anchor: pos }, extensions: [md] });
  return { state, result: wikiLinkSource(host)(new CompletionContext(state, pos, false)) as CompletionResult | null };
}

const labels = (marked: string): string[] => (complete(marked).result?.options ?? []).map((o) => o.label);

/** Accepts the option with `label`; returns the doc with "§" at the caret. */
function accept(marked: string, label: string): string {
  const { state, result } = complete(marked);
  const option = result!.options.find((o) => o.label === label)!;
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state;
    },
  } as unknown as EditorView;
  const apply = option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void;
  apply(view, option, result!.from, result!.to!);
  const doc = current.doc.toString();
  const head = current.selection.main.head;
  return doc.slice(0, head) + "§" + doc.slice(head);
}

describe("[[ completion", () => {
  it("ranks like the quick switcher: every space-separated token must match", () => {
    expect(labels("[[project plan§")).toEqual(["project-plan"]);
    expect(labels("[[meeting notes§")).toEqual(expect.arrayContaining(["Notes from meeting", "2024_meeting_notes"]));
    expect(labels("[[work meeting§")).toEqual(["2024_meeting_notes"]);
    expect(labels("[[note§")[0]).toBe("Note");
  });

  it("offers images, first after ![[, inserted with their extension", () => {
    expect(labels("[[diag§")).toEqual(["diagrams", "diagram.png"]);
    expect(labels("![[diag§")).toEqual(["diagram.png", "diagrams"]);
    expect(labels("![[§")[0]).toBe("diagram.png");
    expect(accept("![[diag§", "diagram.png")).toBe("![[diagram.png]]§");
  });

  it("replaces only the target inside an existing link, keeping a table's escaped pipe", () => {
    expect(accept("[[No§|alias]] x", "Note")).toBe("[[Note|alias]]§ x");
    expect(accept("| [[No§\\|alias]] | x |", "Note")).toBe("| [[Note\\|alias]]§ | x |");
  });
});
