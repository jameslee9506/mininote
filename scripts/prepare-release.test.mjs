import { describe, expect, it } from "vitest";
import { cargoLockVersion, cargoPackage, createReleaseConfig } from "./prepare-release.mjs";

/** A public key in the .pub file's shape: base64 over a comment line and a base64 42-byte "Ed…" key. */
function publicKey(body = Buffer.alloc(40, 7)) {
  const key = Buffer.concat([Buffer.from("Ed"), body]).toString("base64");
  return Buffer.from(`untrusted comment: minisign public key: 1234\n${key}\n`).toString("base64");
}

const versions = (v) => ({
  "package.json": v,
  "package-lock.json": v,
  "src-tauri/tauri.conf.json": v,
  "src-tauri/Cargo.toml": v,
});

describe("createReleaseConfig", () => {
  it("writes the endpoint of the repository and the public key", () => {
    const key = publicKey();
    const config = createReleaseConfig({ repository: "owner/repo", publicKey: `${key}\n`, versions: versions("0.1.0"), tag: "v0.1.0" });
    expect(config).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: { pubkey: key, endpoints: ["https://github.com/owner/repo/releases/latest/download/latest.json"] },
      },
    });
  });

  it("rejects anything but a GitHub owner/repo name", () => {
    for (const repository of [undefined, "repo", "owner/repo.git", "owner-/repo", "owner/re po"]) {
      expect(() => createReleaseConfig({ repository, publicKey: publicKey(), versions: versions("0.1.0") })).toThrow(/GITHUB_REPOSITORY/);
    }
  });

  it("rejects a malformed or missing public key", () => {
    const comment = Buffer.from("untrusted comment: x\n").toString("base64");
    const plainKey = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(40)]).toString("base64");
    const shortKey = publicKey(Buffer.alloc(30));
    for (const publicKey of [undefined, "", "not base64!", comment, plainKey, shortKey]) {
      expect(() => createReleaseConfig({ repository: "owner/repo", publicKey, versions: versions("0.1.0") })).toThrow(/\.pub file/);
    }
  });

  it("requires one stable version everywhere, and a matching tag", () => {
    const key = publicKey();
    expect(() => createReleaseConfig({ repository: "o/r", publicKey: key, versions: versions("0.1.0-beta.1") })).toThrow(/stable/);
    expect(() => createReleaseConfig({ repository: "o/r", publicKey: key, versions: { ...versions("0.1.0"), "src-tauri/Cargo.toml": "0.1.1" } })).toThrow(
      /Cargo\.toml declares version 0\.1\.1/,
    );
    expect(() => createReleaseConfig({ repository: "o/r", publicKey: key, versions: { ...versions("0.1.0"), "src-tauri/Cargo.toml": undefined } })).toThrow(
      /Cargo\.toml/,
    );
    expect(() => createReleaseConfig({ repository: "o/r", publicKey: key, versions: versions("0.1.0"), tag: "0.1.0" })).toThrow(/must be v0\.1\.0/);
    expect(() => createReleaseConfig({ repository: "o/r", publicKey: key, versions: versions("0.1.0") })).not.toThrow();
  });
});

describe("Cargo metadata", () => {
  const toml = `[package]\nname = "mininote"\nversion = "0.1.0" # the app version\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`;

  it("reads the package name and version, not a dependency's", () => {
    expect(cargoPackage(toml)).toEqual({ name: "mininote", version: "0.1.0" });
    expect(cargoPackage("[dependencies]\nserde = \"1\"\n")).toEqual({ name: undefined, version: undefined });
  });

  it("reads the locked version of the package only", () => {
    const lock = `version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\n\n[[package]]\nname = "mininote"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n`;
    expect(cargoLockVersion(lock, "mininote")).toBe("0.1.0");
    expect(cargoLockVersion(lock, "mini")).toBeUndefined();
  });
});
