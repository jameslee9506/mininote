/**
 * Writes src-tauri/tauri.updater.conf.json, the overlay that release builds merge into
 * tauri.conf.json (`tauri build --config …`): the updater endpoint, the public signing
 * key and `createUpdaterArtifacts`. Everything is validated first, so a release job
 * fails before it builds anything: the key format, the versions (which must all agree),
 * the tag, and in CI the repository visibility and the presence of the signing secret.
 * Nothing secret is printed or written; the private key only ever signs in CI.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/;
const KEY_ERROR = "TAURI_UPDATER_PUBLIC_KEY must hold the complete .pub file written by `tauri signer generate`.";

/**
 * Validates the inputs and returns the overlay. `versions` maps each file to the version
 * it declares; `tag` is the git tag being released, when there is one.
 */
export function createReleaseConfig({ repository, publicKey, versions, tag }) {
  if (typeof repository !== "string" || !OWNER_REPO.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be a GitHub owner/repo name.");
  }
  const [owner, repo] = repository.split("/");
  if (owner.endsWith("-") || repo === "." || repo === ".." || repo.endsWith(".git")) {
    throw new Error("GITHUB_REPOSITORY must be a GitHub owner/repo name, without .git.");
  }

  // The .pub file is base64 text wrapping two lines: a minisign comment and the base64
  // key itself (42 bytes: "Ed", an 8-byte key id and the 32-byte public key).
  const pubkey = typeof publicKey === "string" ? publicKey.trim() : "";
  const decoded = Buffer.from(pubkey, "base64");
  if (pubkey === "" || decoded.toString("base64") !== pubkey) throw new Error(KEY_ERROR);
  const lines = decoded.toString("utf8").trim().split(/\r?\n/);
  const key = Buffer.from(lines[1] ?? "", "base64");
  if (
    lines.length !== 2 ||
    !lines[0].startsWith("untrusted comment: ") ||
    key.toString("base64") !== lines[1] ||
    key.length !== 42 ||
    key.subarray(0, 2).toString("ascii") !== "Ed"
  ) {
    throw new Error(KEY_ERROR);
  }

  // One stable channel: a prerelease must never become /releases/latest.
  const version = versions["src-tauri/tauri.conf.json"];
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    throw new Error("The release version must be a stable SemVer version such as 0.1.0.");
  }
  for (const [file, value] of Object.entries(versions)) {
    if (value !== version) throw new Error(`${file} declares version ${value}; src-tauri/tauri.conf.json has ${version}.`);
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`The release tag must be v${version}, not ${tag}.`);

  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey,
        endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`],
      },
    },
  };
}

/** The `[package]` table of a Cargo.toml: its `name` and `version` literals (not inherited from a workspace). */
export function cargoPackage(toml) {
  const table = toml.split(/^\s*\[package\]\s*$/m)[1]?.split(/^\s*\[/m)[0] ?? "";
  const field = (name) => table.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, "m"))?.[1];
  return { name: field("name"), version: field("version") };
}

/** The locked version of the package `name` in a Cargo.lock. */
export function cargoLockVersion(lock, name) {
  const entry = lock.split(/^\[\[package\]\]\s*$/m).find((block) => new RegExp(`^name = "${name}"$`, "m").test(block));
  return entry?.match(/^version = "([^"]+)"$/m)?.[1];
}

async function main() {
  const root = new URL("../", import.meta.url);
  const text = (path) => readFile(new URL(path, root), "utf8");
  const json = async (path) => JSON.parse(await text(path));
  const [pkg, lock, tauri, cargo, cargoLock] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    json("src-tauri/tauri.conf.json"),
    text("src-tauri/Cargo.toml"),
    text("src-tauri/Cargo.lock"),
  ]);

  if (process.env.GITHUB_ACTIONS === "true") {
    if (process.env.GITHUB_REF_TYPE !== "tag") throw new Error("Releases run from a version tag only.");
    if (process.env.RELEASE_REPOSITORY_PRIVATE !== "false") {
      throw new Error("Updates download without credentials, so the repository must be public.");
    }
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
      throw new Error("Set the TAURI_SIGNING_PRIVATE_KEY repository secret before releasing.");
    }
  }

  const crate = cargoPackage(cargo);
  const config = createReleaseConfig({
    repository: process.env.GITHUB_REPOSITORY,
    publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
    versions: {
      "package.json": pkg.version,
      "package-lock.json": lock.version,
      'package-lock.json packages[""]': lock.packages?.[""]?.version,
      "src-tauri/tauri.conf.json": tauri.version,
      "src-tauri/Cargo.toml": crate.version,
      "src-tauri/Cargo.lock": cargoLockVersion(cargoLock, crate.name ?? ""),
    },
    tag: process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined,
  });
  await writeFile(new URL("src-tauri/tauri.updater.conf.json", root), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote the updater overlay for ${process.env.GITHUB_REPOSITORY} v${tauri.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
