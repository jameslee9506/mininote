import { describe, expect, it } from "vitest";
import backend from "../../../src-tauri/src/fs_ops.rs?raw";
import { CODE_EXTS, CODE_NAME_PREFIXES, CODE_NAMES, codeLanguageOf } from "./codeFiles";

/** The strings of a `const NAME: &[&str] = &[…];` list in the backend's source. */
function backendList(name: string): string[] {
  const body = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(backend)?.[1];
  if (body === undefined) throw new Error(`${name} is missing from fs_ops.rs`);
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

const sorted = (list: readonly string[]): string[] => [...list].sort();

describe("code files", () => {
  it("tells the language by whole name, then name prefix, then extension", () => {
    expect(codeLanguageOf("src/player.GD")).toBe("gdscript");
    expect(codeLanguageOf("level.tscn")).toBe("config");
    expect(codeLanguageOf("a.d.ts")).toBe("typescript");
    expect(codeLanguageOf("notes.txt")).toBe("text");
    expect(codeLanguageOf("CMakeLists.txt")).toBe("cmake");
    expect(codeLanguageOf("Makefile")).toBe("makefile");
    expect(codeLanguageOf("Dockerfile.dev")).toBe("dockerfile");
    expect(codeLanguageOf("LICENSE")).toBe("text");
  });

  it("knows no other name, however an object would answer", () => {
    for (const name of ["model.glb", "archive.zip", "gd", ".gd", "build", "Makefiles", "constructor", "x.constructor", "a.__proto__"])
      expect(codeLanguageOf(name), name).toBeNull();
  });

  it("lists the names the backend lists", () => {
    expect(sorted(backendList("CODE_EXTS"))).toEqual(sorted(CODE_EXTS));
    expect(sorted(backendList("CODE_NAMES"))).toEqual(sorted(CODE_NAMES));
    expect(sorted(backendList("CODE_NAME_PREFIXES"))).toEqual(sorted(CODE_NAME_PREFIXES));
  });
});
