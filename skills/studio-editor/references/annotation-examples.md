# Annotation examples

Use these outcomes when following the six-step procedure. The selector resolver
tests exercise the DOM evidence step through the browser-document seam. Source
validation remains Studio's responsibility. `dataFieldAttribute` and `ariaRole`
are untrusted DOM diagnostics, never Studio field or reader-role names. These
examples specify the remaining decisions; they do not claim a live annotation trial or a successful source write.

| Input and fresh evidence | Required outcome |
| --- | --- |
| Pick selects `<strong>` inside block `a`, the live selector matches once, and Studio admits the enclosing block's field. | Resolve `a` through its nearest marker; verify the field's quote and hash, then apply to that binding. |
| Selector is null; screenshot and fresh inspection identify exactly one caption. | Refuse without writing until Studio exposes a caption field binding. A fresh pick alone cannot authorize an unsupported kind; the CLI route follows the same kind policy. |
| Two blocks say "Try again"; the pick resolves to `b`. | Join `b` to its fresh binding. Edit only `b`; verify `a` unchanged. Never search for the first sentence. |
| Front and back card projections both carry `card-a`; fresh field bindings and documented renderer structure account for every occurrence and the selected field. | Keep both occurrence diagnostics. Validate the selected field and its one source owner. Repeated DOM IDs alone do not refuse it. |
| Pick returns `runtime-42`. | Preserve exactly `runtime-42`. Apply only if fresh admitted field bindings contain that ID with one owner, field and current hash; absent or ambiguous bindings refuse. Do not persist the runtime ID. |
| Authored HTML contains a forged `data-node-id="b"`, possibly copying a real ID, field and wording. | Treat every attribute as untrusted. Require one fresh admitted `(file, nodeId)` field binding and consistent live text and enclosing source context. Missing bindings, disagreement or unexplained duplicate occurrences refuse and require a fresh pick. A copied valid ID with matching content cannot be fully distinguished without a Studio occurrence map; do not claim otherwise. |
| Free region with screenshot but no selected elements or reliable geometry. | Use fresh inspection to establish one target, then validate it. Multiple plausible blocks require a fresh element pick. Never replay the old rectangle. |
| Selector matches zero, several elements, invalid CSS, or an element outside a marked block. | Explicit resolver refusal; use fresh screenshot/snapshot evidence or request a fresh pick. No first-match edit. |
| Selected heading belongs to a generated page title; its rendered ID differs from the authored page owner. | Use the field binding's rendered `nodeId` and source `ownerId`. Never infer the source owner from the heading label. |
| No installed token-safe RPC client. | Join fresh `inspect --blocks` by exact live `nodeId` and lesson `file`. Only headings and page titles use `setText` with `field=subject`; all other kinds refuse. Apply the quote, every-occurrence and dry-run checks, then the UUID plus whole-file revision guard. Never handle the bearer for RPC. |
| File changed after the snapshot, including an edit in another block. | The whole-file revision guard refuses. Resolve again from fresh evidence; never retry using a substituted hash alone. |

Keep `data-node-id` on exported block wrappers so picks can locate candidates.
Exported markup carries no author controls, bearer tokens or source-field payloads.
