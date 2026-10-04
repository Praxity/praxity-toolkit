# Praxity toolkit

Install Praxity's local tools for learning designers in your home folder.
The pack provides pinned Node and Typst runtimes, a `praxity` command and skills
for your agent host. There is no SDK or MCP server.

This is a private scaffold. Every tool archive in `pack.json` is unpublished.
The current manifest installs Node and Typst and reports the missing tools.
It does not yet deliver a working Studio editor or a complete tool pack.
First supported target: Apple Silicon macOS with local T3 desktop. Direct
Claude Code and Codex use still need host smoke checks. Other OS/CPU entries are
release metadata only; their installers are not implemented.

Praxity's tools execute locally. The chosen host and model provider control
telemetry and what they transmit. An editor capability URL can enter the host's
tool transcript.

## Install

Obtain this private checkout through the owner's existing repository access.
Review `install.sh` and `pack.json`, then run from that checkout on the Mac:

```sh
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
`skills`, `check`, `trace`, `print` and `import`.

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
the current directory. Use the actual project root; T3's Claude picker scans
exactly that directory's `.claude/skills`, and its user scope wins duplicates.
The generated layouts are:

| Host | Layout relative to home or project |
| --- | --- |
| T3 Claude picker, also native Claude plain skills | `.claude/skills/<name>/SKILL.md` |
| Codex | `.agents/skills/<name>/SKILL.md` |
| Claude Code plugin | `.claude/plugins/praxity/.claude-plugin/plugin.json` and sibling `skills/` |

For Claude, the installer prints `claude --plugin-dir <absolute-directory>`.
Copying the plugin does not enable it in an existing session or register it in
Claude's settings. The toolkit does not edit those settings.

One adapter is active per scope. Switching hosts removes only files recorded
in `.praxity/toolkit-skills.json`; modified files are preserved and block the
switch. Existing unowned or competing skills also block installation. A second
scope is refused when it would compete with the existing installation.
The generator writes only into a fresh output directory. Restart the host and
verify invocation; file presence alone does not prove runtime discovery.

## Doctor

`schemas/doctor.schema.json` defines JSON version 1. Each item has an `id`,
`status`, `message` and `fix`. Status is `ok`, `failed`, `declined` or
`not-installed`. Exit code 1 means at least one failure. Missing unpublished
tools or unused adapters do not make a runtime-only install fail.

Doctor checks the Node pin and compiles a tiny Typst document. It reads Check's
own JSON doctor and inspects the bundled tiny Studio course. It runs Trace and
Print on temporary inputs when installed. Import gets only a CLI help probe.
It checks skill files at both scopes for T3, Codex and the Claude
plugin. Probes time out after 30 seconds and cap captured output at 1 MiB.
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

| Tool | Needed before changing `unpublished` to `published` |
| --- | --- |
| Studio 0.3.0 | Publish CLI/editor archive from the current draft release, package the format skill and legal files, and expose shared Typst resolution |
| Check 0.6.0 | Publish the portable compiled build with setup/doctor, skill and notices; agree whether its redundant bundled Node is removed |
| Trace 0.1.1 | Archive and publish `pnpm package` output including dependencies, lexical data, skill and notices |
| Print 0.1.0 | Archive and publish `pnpm package` output including fonts, patched dependencies, skill and notices; retain external Typst |
| Import 0.1.0 | Add portable packaging, dependencies, skill and notices, then publish; verify Studio compatibility |

The version entries are candidate pins, not evidence that all artifacts are
available. Check's setup/doctor contract was read from current upstream source;
the local Check checkout was older. Confirm its published inventory and version
before replacing the candidate pin.

Node 24.21.0 hashes came from its [signed official checksum list](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.asc),
verified with release key `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356` listed in
the [Node release instructions](https://github.com/nodejs/node/blob/main/README.md#release-keys).
Typst 0.15.1 hashes came from [official release asset metadata](https://api.github.com/repos/typst/typst/releases/tags/v0.15.1).
`docs/provenance/` preserves the signed Node list, public key and extracted
checksums. Neither origin settles signing, Gatekeeper or clean-Mac acceptance.

TODO: owner chooses the licence for toolkit scripts and toolkit skills before
publication. No toolkit licence is declared yet. Tools retain PolyForm Perimeter
1.0.1 and their third-party notices; adapters do not relicense them.

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
override. On Windows they run under Git Bash. Golden adapter files record
reviewed content hashes. CI uses `ubicloud-standard-2` for offline tests and the
self-hosted `[self-hosted, macOS, ARM64, praxity-release]` runner for tests and a
real install in a temporary home. Real macOS acceptance has not run on the NUC.
