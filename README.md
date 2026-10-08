# Praxity toolkit

Install Praxity's local tools for learning designers in your home folder.
On an Apple Silicon Mac, one install gives you five working tools:

- Studio edits a course in the browser or in T3's preview, and exports it as HTML or PDF.
- Check audits an exported course, including for accessibility.
- Trace writes a report on an exported HTML course.
- Print renders Markdown to PDF.
- Import converts a SCORM package into a Praxity course.

The pack also installs private Node and Typst runtimes, a `praxity` command,
T3 course actions and skills for T3, Claude Code and Codex CLI. There is no SDK
or MCP server. `pack.json` pins every archive by URL and SHA-256.

Studio reads grammar 4 courses; convert grammar 3 courses first.
Only Apple Silicon macOS has archives and an installer. The other platforms in
`pack.json` are placeholders.

Praxity's tools execute locally. The chosen host and model provider control
telemetry and what they transmit. An editor capability URL can enter the host's
tool transcript.

## Try it

On an Apple Silicon Mac, one command downloads the toolkit, installs the pack, runs
the doctor and opens Studio's editor in Safari on a copy of the sample course:

```sh
curl -fsSL https://raw.githubusercontent.com/Praxity/praxity-toolkit/main/try.sh | sh
```

Read [`try.sh`](try.sh) first if you prefer; it touches only `~/praxity-toolkit-main`,
`~/.praxity` and `~/praxity-trial-course`. Press Ctrl+C to stop Studio.

## Install

Download this repository, review `install.sh` and `pack.json`, then run the
installer from that folder on an Apple Silicon Mac:

```sh
curl -fsSL https://github.com/Praxity/praxity-toolkit/archive/refs/heads/main.tar.gz | tar xz
cd praxity-toolkit-main
sh install.sh
```

The bootstrap needs `curl`, `tar`, `awk`, `mktemp` and `shasum`. It does not
need an existing Node or administrator privileges. It installs to
`~/.praxity/toolkit/<pack-version>/` and creates `~/.praxity/bin/praxity`.
Add the line it prints to your shell configuration yourself:

```sh
export PATH="$HOME/.praxity/bin:$PATH"
```

Use `~/.praxity/bin/praxity` directly until your shell and host have the new PATH.
T3 course actions call it by that path, so they work before you edit PATH.
The doctor's `launcher.path` item says whether `praxity` is on PATH and names
the line to add. Neither the installer nor the doctor edits shell files.
The launcher selects the active pack and uses its private Node. It sets Print's
`PRAXITY_PRINT_TYPST` and Import's `PRAXITY_CLI` to absolute pack paths. Studio's
present standalone publisher still needs a supported shared-Typst option.

The reviewed checkout supplies the bootstrap and default manifest.
HTTPS manifests must match `--manifest-sha256 <reviewed-sha256>` or the SHA-256 of
that checkout's `pack.json`, checked before Node is selected.
Review local `file:///...` manifests directly; archive hashes check artifact
integrity against that trusted manifest.

```sh
~/.praxity/bin/praxity setup
~/.praxity/bin/praxity doctor --json
~/.praxity/bin/praxity version
~/.praxity/bin/praxity check ...
~/.praxity/bin/praxity trace ...
~/.praxity/bin/praxity print ...
~/.praxity/bin/praxity import ...
~/.praxity/bin/praxity studio . --no-open
```

`setup [tool]` delegates to each installed tool's setup with its consent prompts.
For example, `praxity setup check browser` forwards `setup browser` to Check.
It never adds `--yes`. Every other subcommand and its arguments reach Studio
unchanged. The toolkit reserves `setup`, `doctor`, `version`, `rollback`,
`skills`, `init`, `check`, `trace`, `print` and `import`.

## Course actions in T3 Code

Run `praxity init [folder]` in a course with `course.yaml` or `.prax` lessons.
It writes a commit-ready `t3.json` with Open in Studio, Export HTML, Export PDF,
Check accessibility and Doctor actions. Exports write `course-html.zip` and
`course.pdf`; export HTML before running the accessibility check.
Other keys and scripts stay intact. Invalid JSON is refused unchanged.

Studio keeps a course port in 41700-41999, reserved in
`~/.praxity/toolkit-state/t3-actions.json`. Rerunning init keeps that port and
upgrades actions written by earlier versions.
Generated actions use relative paths and a loopback `/launch` URL, with no tokens
or machine paths. They call the launcher as `"$HOME/.praxity/bin/praxity"`,
which the shell expands on each machine, because T3 runs actions in a login
shell that may not have `~/.praxity/bin` on PATH. Open in Studio passes
`--no-open`, so the editor opens in T3's preview and not in your default
browser. Automatic editor preview needs T3 desktop and Studio's
`--port` and `/launch` support. An occupied port makes Studio fail clearly;
close the process using it before retrying.

## Convert a grammar 3 course

Keep a backup and convert a copy. The converter is archived at Studio tag
`converter-v3-to-v4`, commit `8905c116e`. It requires access to the private Studio
repository, Node 24.18.x and pnpm 10.28.2. From a Studio checkout:

```sh
git fetch origin tag converter-v3-to-v4
git worktree add --detach ../praxity-converter converter-v3-to-v4
pnpm --dir ../praxity-converter install --frozen-lockfile
pnpm --dir ../praxity-converter --filter @praxity/desktop prebuild
pnpm --dir ../praxity-converter --filter @praxity/convert convert <course-copy> --from 3 --out <new-output-directory>
```

Review the output, `conversion-report.json`, its SHA-256, the allocation manifest
and `narration-review.md`. Record the approved report hash independently, then run:

```sh
pnpm --dir ../praxity-converter --filter @praxity/convert convert --install <approved-directory> --report-sha256 <approved-hash>
```

Installation writes to the course copy recorded in the report, verifies source
and output hashes, and installs the approved identities and narration through
the course journal. Keep unchanged assets with that installed copy. Open and
export it with Studio before replacing your working course.

## Recovery

Rerun the same installer after a failed download or interruption. Complete
verified archives remain in the cache; partial downloads restart. A stale lock
is reclaimed only if the ownership ledger records its creation and its process
is dead. A live lock stops the run.
The installer writes its intended paths and hashes to `.install-ledger.tsv`
before downloading, extracting, copying or moving files. Reruns discard recorded
unfinished writes and rebuild the stage, or finish activating a verified version
that was already moved into place. Files absent from the journal are preserved
and stop recovery. Completed files with changed bytes also stop recovery.

If the journal is corrupted, close Studio and keep the reported files. Move
`~/.praxity/toolkit` and `~/.praxity/bin/praxity` to a backup folder outside
`~/.praxity`, then rerun the reviewed installer. If present, move
`~/.praxity-toolkit-bootstrap.tsv` to that backup too. Do not delete the journal
and run uninstall, since the installer would no longer know which files it owns.
Keep the backup until you have recovered any personal files from it.
Checksum failures publish no version or launcher. Installed file damage is
refused. Roll back to an intact previous pack, or use the backup procedure above
before reinstalling. A different manifest needs a new pack version.

Release candidates 1 and 2 labelled themselves 0.1.0 and installed to
`~/.praxity/toolkit/0.1.0`. When you install 0.1.0, the installer recognises
either candidate by its manifest's SHA-256, checks its files, and moves it to
`~/.praxity/toolkit/0.1.0-rc.1`. The version pointers follow it, so rollback
still reaches it. Any other manifest in that folder is refused as before.

Updates retain the previous version. Both version pointers change in one atomic
rename. Rollback checks the destination pack and keeps the outgoing pack, even
when its contents are damaged. Save and close Studio before switching or removing a pack. This scaffold
does not detect dirty editor sessions.

```sh
~/.praxity/bin/praxity rollback
sh /absolute/path/to/praxity-toolkit/install.sh uninstall
```

Uninstall removes owned pack versions, staged downloads and its unchanged
launcher. It preserves optional tool components, generated host skills and
unrelated `~/.praxity` data. User additions inside packs, caches and stages, and modified or unowned files
are refused before removal. Host skills retain their separate ownership record.

## Skills

The toolkit owns `skills/install-praxity` and `skills/studio-editor`. Each tool
owns the skill and references shipped in its archive. The generator collects
installed tools' skill folders without rewriting them.

```sh
node scripts/build-adapters.mjs --output dist/adapters
node scripts/build-adapters.mjs --installed "$HOME/.praxity/toolkit/0.1.0" --output dist/installed-adapters
praxity skills install --host t3 --scope user
```

Choose `--host t3|claude|codex` and `--scope user|project`. Project scope means
the current directory. Install at the actual project root. There are two
adapters: `claude` and `codex`. `t3` remains an alias for `claude`.

Both adapters may coexist in one scope. Installing another adapter retains the
first. Each host gets one copy per skill. A same-host copy in the other scope,
a legacy Codex skill in `.codex/skills`, or an unowned Praxity plugin blocks a
competing installation. Unowned skills for a different host are preserved.
The toolkit does not edit host settings, shell profiles or AGENTS files.

Ownership and recovery intents live in `.praxity/toolkit-skills.json`. Existing
single-host records migrate automatically. The former owned Claude plugin moves
to plain skills, and its unchanged files are removed. Modified or unowned files
are preserved and stop migration or removal. Stop active host sessions before
migrating the plugin, then start a new session without its old `--plugin-dir`.
The generator emits only the two current layouts into a fresh output directory.

Installing a new pack runs `praxity skills refresh --scope user`. It regenerates
only the adapters recorded in `~/.praxity/toolkit-skills.json`, so new tool
skills appear and unowned skills stay as they are. Refresh project-scope
adapters yourself with `praxity skills refresh --scope project` in the project.

Remove one adapter with `praxity skills uninstall --host claude --scope user`
or `--host codex`. The other adapter remains installed. `--host t3` removes the
shared Claude adapter. Pack uninstall still preserves host skills.

### T3 Code

For T3's Claude provider:

```sh
praxity skills install --host t3 --scope user
```

Files land in `~/.claude/skills/<name>/SKILL.md`, also used by Claude Code.
For T3's Codex provider, additionally run
`praxity skills install --host codex --scope user`. Those files land in
`~/.agents/skills/<name>/SKILL.md`, also used by Codex CLI. Project scope uses
the corresponding folders under the current project.

Start a new thread with each provider. Type `$` in the composer, select
`install-praxity` or `studio-editor`, and confirm the thread can use it.
T3's [Claude provider docs](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md)
describe its skill folders; its [Codex provider](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexProvider.ts)
asks the Codex app server for the project's skill inventory. With a custom
provider home or a remote server, install where that provider runs. If your
T3 version misses project skills in the picker, use user scope and check again.

### Codex CLI

```sh
praxity skills install --host codex --scope user
```

Files land in `~/.agents/skills/<name>/SKILL.md`. With `--scope project`, they
land in `.agents/skills` under the current project. Codex also scans parent
folders up to the repository root. Start Codex in the project, run `/skills`
or type `$`, and confirm both toolkit skill names appear. Ask it to list the
available Praxity skills before invoking one. See [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills).

### Claude Code

```sh
praxity skills install --host claude --scope user
```

Files land in `~/.claude/skills/<name>/SKILL.md`. With `--scope project`, they
land in `.claude/skills` under the current project. Start a new Claude session
in the project, type `/` and look for `install-praxity` and `studio-editor`,
or ask which skills it can see. Plain skills load automatically; no plugin
flag is needed. See [Claude Code skill discovery](https://code.claude.com/docs/en/skills).

File presence in doctor proves the adapter was copied. Verify the inventory
and invocation in the host to confirm runtime discovery.

## Doctor

`schemas/doctor.schema.json` defines JSON version 1. Each item has an `id`,
`status`, `message` and `fix`. Status is `ok`, `failed`, `declined`,
`not-installed` or `partial`. Exit code 1 means at least one failure. Missing
tools, unused adapters, partial adapters and a missing PATH entry do not fail it.

Doctor checks the Node pin and compiles a tiny Typst document. It reads Check's
own JSON doctor and inspects the bundled tiny Studio course. It runs Trace and
Print on temporary inputs when installed, and has Import convert its shipped
SCORM fixture. It checks the shared Claude and Codex skill folders at both
scopes, with `host.claude` and `host.codex` items. An adapter missing some of
this pack's skills, or holding changed copies, is `partial`; its message names
those skills and its fix is the `praxity skills install` command that refreshes
them. `launcher.path` reports whether `praxity` is on PATH.
Probes time out after 30 seconds and cap captured output at 1 MiB.
Temporary probe documents are removed. It does not launch an editor or run a
full Check audit.

Check currently exposes refusal in setup text rather than persistent doctor
state. The toolkit records Check's explicit refusal line from setup run through
`praxity` in `~/.praxity/toolkit-state/declined.json`, outside pack folders.
This per-user state survives updates, rollback and uninstall. It cannot see a refusal from Check run on its own.
A component that works counts as ok, even if you refused it earlier.

## Release contract

`schemas/pack.schema.json` owns artifact formats. A published archive needs an
official URL, SHA-256, format and root stripping count. Its entry and notices
paths are relative to the extracted root. The manifest selects Node-script or
executable launchers. Tar archives must not escape their artifact root.
Keep licences, Required Notices, dependencies and inventories in the payload.

All five tool archives are published for darwin-arm64 as assets of this
repository's releases, each with its SHA-256 in `pack.json`. Their other
platform entries stay `unpublished`, with the reason recorded beside each.

Node 24.21.0 hashes came from its [signed official checksum list](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.asc),
verified with release key `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356` listed in
the [Node release instructions](https://github.com/nodejs/node/blob/main/README.md#release-keys).
Typst 0.15.1 hashes came from [official release asset metadata](https://api.github.com/repos/typst/typst/releases/tags/v0.15.1).
`docs/provenance/` preserves the signed Node list, public key and extracted
checksums. Neither origin settles signing, Gatekeeper or clean-Mac acceptance.

The toolkit's own scripts, skills and adapters are MIT-licensed (see `LICENSE`).
The tools it installs keep their own licences: Studio, Check, Trace, Print and
Import are under PolyForm Perimeter 1.0.1, with their third-party notices inside
each archive. Installing or adapting a tool does not relicense it.

## Paste into your agent

> Use the reviewed Praxity toolkit checkout to install its pinned manifest on
> this Apple Silicon Mac. Read its install-praxity skill first. Show the concrete
> downloads, licences and unpublished blockers and obtain consent. Run only its
> reviewed bootstrap. Keep tool setup consent prompts visible, run doctor, and
> install the adapter for my host and scope. Preserve my shell and AGENTS files.
> Show PATH and recovery commands. Use the absolute launcher if PATH is stale.

## Development

Use Node >=24.18 and <25. There are no package dependencies.

```sh
npm run validate
node --test
```

Offline installer tests use fake archives, temporary homes and a platform
override. On Windows, invoke the checks from PowerShell. Installer subprocesses
use Git Bash. Golden adapter files record
reviewed content hashes. CI runs the offline tests on GitHub-hosted Ubuntu, and the
tests plus a real install in a temporary home on GitHub-hosted Apple Silicon macOS.
No self-hosted machine runs code from this public repository's pull requests.
