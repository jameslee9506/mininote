# Releasing mininote

The app checks for a newer version once at launch. When one exists, an update icon appears in the
main top strip (or in the top-right corner of the Welcome screen); clicking it downloads the signed
archive, writes every unsaved note, installs the new version and restarts. GitHub Releases hosts both
the version manifest (`latest.json`) and the archives, so the app needs no update server and no
credentials. The mechanism is described in [ARCHITECTURE.md §6.7](ARCHITECTURE.md).

Releases publish to the public `jameslee9506/mininote` repository, where the Actions variable and
secrets listed below live. Ordinary local builds use the empty updater configuration committed in
`src-tauri/tauri.conf.json` and never check for updates. Release builds merge the generated, ignored
overlay `src-tauri/tauri.updater.conf.json` into it (`tauri build --config …`).

The setup below was completed on 2026-11-09. The updater signing key lives outside the checkout at
`~/.tauri/mininote.key`, its public half next to it as `~/.tauri/mininote.key.pub`, and its password
in the macOS login keychain under the service `mininote-tauri-updater-key`
(`security find-generic-password -s mininote-tauri-updater-key -w`). The repository's Actions
variable and secrets hold copies of all three. Back up the two files and the password: installed
apps verify every update against this key, so it can never be replaced without stranding them.

## One-time setup

Already done; the steps stay here for reference and for moving to another machine, where the key
and password are restored from the backup, never generated again.

1. The repository must be **public** with Actions enabled: updates download without
   authentication, and the preparation script refuses to run a release from a private repository.
   Never embed a GitHub token in the app. Set the remote with the personal SSH alias
   (`git@github-jameslee9506:jameslee9506/mininote.git`).
2. Generate the updater signing key outside the checkout:

   ```sh
   mkdir -p ~/.tauri
   npm run tauri -- signer generate -w ~/.tauri/mininote.key
   chmod 600 ~/.tauri/mininote.key
   ```

   This writes `~/.tauri/mininote.key` (private) and `~/.tauri/mininote.key.pub` (public). Keep the
   password it asks for in the macOS login keychain under the service `mininote-tauri-updater-key`
   (`security add-generic-password -s mininote-tauri-updater-key -a "$USER" -w`; read it back with
   `security find-generic-password -s mininote-tauri-updater-key -w`), and back up both files.
   Every later release must use the same key, or installed apps stop trusting updates. Never
   commit the key (`*.key` is ignored).
3. In the repository's **Settings → Secrets and variables → Actions**, configure:

   | Kind | Name | Value |
   |---|---|---|
   | Variable | `TAURI_UPDATER_PUBLIC_KEY` | The complete contents of `~/.tauri/mininote.key.pub` (the base64 text, not a path) |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY` | The complete contents of `~/.tauri/mininote.key` |
   | Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen when generating the key; omit it if the key has none |

   From a terminal, with the personal account active in `gh`:

   ```sh
   gh variable set TAURI_UPDATER_PUBLIC_KEY -R jameslee9506/mininote < ~/.tauri/mininote.key.pub
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R jameslee9506/mininote < ~/.tauri/mininote.key
   security find-generic-password -s mininote-tauri-updater-key -w | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R jameslee9506/mininote
   ```

`scripts/prepare-release.mjs` validates the public key's format, the versions, the tag, and in CI the
repository visibility and the presence of the signing secret, before anything is built or any release
is created. It never prints key material. Tauri verifies the signature of every archive before
installing it.

## Create a release

Use a stable version such as `0.1.0`; prerelease and build suffixes are deliberately excluded, since
`/releases/latest` is the single channel. Set that version in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then refresh the lockfiles:

```sh
npm install --package-lock-only
(cd src-tauri && cargo check)
```

Run the checks (`npm run check`, `npm test`, `cd src-tauri && cargo check && cargo test --lib`),
commit everything including both lockfiles, and push a tag that matches the version exactly:

```sh
git tag v0.1.0
git push origin main v0.1.0
```

`.github/workflows/release.yml` then:

1. **Check**: validates the configuration and runs the type checks and unit tests on Linux.
2. **Build**: one job per platform, run one at a time because each merges its platform into the
   release's `latest.json`. Apple Silicon and Intel macOS (`.dmg` plus the `.app.tar.gz` updater
   archive), Windows (`.msi` and NSIS `-setup.exe`; NSIS is the preferred updater target) and
   Linux on Ubuntu 22.04 (`.deb`, `.rpm` and the `.AppImage`, which is the only Linux package the
   updater can replace). Every updater archive gets a `.sig`, and all of it lands in a **draft**
   release named `mininote vX.Y.Z`.
3. **Verify**: downloads the draft's `latest.json` and fails unless it carries the released version
   and a signed artifact for `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `linux-x86_64`.

Once every job is green, review the draft's assets on GitHub and publish it as the latest release.
Drafts and prereleases are not served at `/releases/latest/download/latest.json`, so nothing reaches
users before that click. Never publish a draft from a failed or incomplete run, and never rerun or
move a tag after its release is published: make a new version instead.

The first updater-enabled release must be installed by hand from its installer; apps built without
the overlay know neither the endpoint nor the key. On macOS, install into a writable Applications
folder, since the update replaces the `.app` in place. From then on, a higher published version shows
the update icon at the next launch. Keep the application identifier (`com.mininote.desktop`) and the
signing key stable across releases so settings and update trust survive.

## Prepare or build locally

To validate the configuration without building:

```sh
export GITHUB_REPOSITORY='jameslee9506/mininote'
export TAURI_UPDATER_PUBLIC_KEY="$(cat ~/.tauri/mininote.key.pub)"
npm run release:prepare
```

This only writes the public overlay; it uploads nothing and needs no private key. To build a release
bundle locally, pass the overlay and the signing key explicitly:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/mininote.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s mininote-tauri-updater-key -w)"
npm run tauri -- build --target aarch64-apple-darwin --config src-tauri/tauri.updater.conf.json
```

Use `x86_64-apple-darwin` for Intel. A local build publishes nothing and does not update
`latest.json`; only the workflow does.

## Install a local build

To run the working tree as the installed app on this Mac, without a release: build only the `.app`,
sign it ad hoc, and put it in place of the installed one.

```sh
npm run tauri -- build --bundles app
ditto src-tauri/target/release/bundle/macos/mininote.app /Applications/mininote-new.app
codesign --force --sign - /Applications/mininote-new.app
# Quit mininote, then:
rm -rf /Applications/mininote.app
mv /Applications/mininote-new.app /Applications/mininote.app
open -g /Applications/mininote.app
```

The bundler signs nothing in an ordinary local build: the binary carries only the linker's ad-hoc
signature. `codesign --sign -` seals the bundle and binds it to the app identifier
(`com.mininote.desktop`). Quit with Cmd+Q, which writes every note first (ARCHITECTURE §6.6). When
the quit is scripted, do it only while the mininote window is not focused: losing focus has
already saved everything (ARCHITECTURE §8.1). The version and the tags stay as they are.

## Apple signing and notarization

The updater signature and Apple's Developer ID signature serve different purposes. The updater key
authenticates the downloaded archive; Developer ID signing and notarization let macOS open an app
downloaded from the internet without Gatekeeper warnings. The workflow leaves the Apple credentials
unset. To enable them, add these environment entries to the **Build and upload** step and provide the
matching repository secrets:

```yaml
APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
APPLE_ID: ${{ secrets.APPLE_ID }}
APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

`APPLE_CERTIFICATE` is the base64-encoded Developer ID Application `.p12`,
`APPLE_CERTIFICATE_PASSWORD` unlocks it, `APPLE_SIGNING_IDENTITY` names that identity, and
`APPLE_PASSWORD` is an app-specific password for notarization (Tauri also supports App Store Connect
API keys). Without them the updater archives are still signed by the updater key, which does not
remove Gatekeeper's checks on first launch. Windows code signing is likewise optional and documented by
Tauri.

References: [Tauri updater](https://v2.tauri.app/plugin/updater/),
[Tauri GitHub Action](https://github.com/tauri-apps/tauri-action),
[macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Windows signing](https://v2.tauri.app/distribute/sign/windows/).
