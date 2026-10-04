# Toolkit rules

Read `AGENTS.local.md` when present. This scaffold has no glossary or ADRs yet.
`pack.json` owns release pins. `schemas/` owns wire formats. Keep bootstrap parsing
limited to finding Node; use the schema validator once the pinned Node runs.

Tool repositories own their setup, doctors, business rules and skills. Collect
their packaged skills without rewriting them. Toolkit skills live in `skills/`.
Change adapters through the generator, then update and review the golden files.

Use `node --test` and `npm run validate`. Installer tests use local archives and
temporary homes only. Real installs run in CI on GitHub-hosted macOS and on the owner's Mac.
Keep unpublished artifacts explicit. Never infer release URLs or checksums.

Preserve unowned files and modified adapter files. Keep activation atomic and
test recovery when changing installation or ownership rules.
