---
name: install-praxity
description: Install or recover the local Praxity toolkit, then check its tools and install the selected host adapter.
---

Use the reviewed toolkit checkout and its `pack.json`. The first supported path
is local T3 desktop on Apple Silicon macOS. If the checkout or reviewed bootstrap
is unavailable, stop and obtain it from the owner. Do not invent a download URL.

1. Read the checkout's README and manifest. Show the pack version, each published
   download's purpose, version, URL and licence, and the unpublished tool reasons.
   Explain the per-user version directory and launchers. Obtain consent for these
   concrete downloads before running `sh /absolute/path/to/toolkit/install.sh`.
2. Read the result. On failure, use the reported recovery command. Do not change
   installation steps, escalate privileges or disable OS protections. A manifest
   override is a trust decision; use only the user's reviewed manifest.
3. Run `~/.praxity/bin/praxity setup` for installed tools. Each tool owns optional
   component consent. Let its prompts reach the user. Never pass `--yes` silently.
   Respect a refusal and report the unavailable capability.
4. Run `~/.praxity/bin/praxity doctor --json`. Explain failed and not-installed
   items separately from declined components. Report fixes from doctor.
5. Ask which host and scope the user uses if unknown. Run
   `~/.praxity/bin/praxity skills install --host t3 --scope user`, replacing only
   the host and scope with the user's choice. `t3` and `claude` share plain Claude
   skills. Add the `codex` adapter for T3's Codex provider or Codex CLI; both
   adapters may coexist. Preserve files the installer does not own. Plain Claude
   skills need no plugin flag. Restart the host and verify invocation as well as
   picker visibility.
6. For a course opened in T3, run `~/.praxity/bin/praxity init <course-folder>`.
   The folder must contain `course.yaml` or `.prax` lessons. It merges five
   course actions into `t3.json`, preserving other keys and scripts. Commit that
   file with the course. Studio's port is stable; its private registry stays in
   `~/.praxity/toolkit-state/t3-actions.json`. Export HTML to `course-html.zip`
   before running Check accessibility. Automatic editor preview needs T3 desktop
   and a Studio build supporting `--port` and `/launch`. Refused JSON stays
   unchanged; resolve the reported error and rerun init.

Use the absolute launcher when PATH is stale. Show the printed PATH line for the
user to add; never edit shell profiles or AGENTS files. Praxity tools run locally;
the host and model provider control what they transmit.

Recovery commands, after resolving the reported cause:

- Retry: `sh /absolute/path/to/toolkit/install.sh`. Verified downloads are reused.
- Revert an update: `~/.praxity/bin/praxity rollback`.
- Remove the toolkit: `sh /absolute/path/to/toolkit/install.sh uninstall`.

Close Studio and save work before switching or removing a pack. A live editor
must finish before its runtime directory is removed.
