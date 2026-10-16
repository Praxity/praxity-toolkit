# Annotation examples

Use these outcomes when following the six-step procedure. The selector resolver
tests exercise the DOM evidence step through the browser-document seam. Source
validation remains Studio's responsibility. These examples specify the remaining
decisions; they do not claim a live annotation trial or a successful source write.

| Input and fresh evidence | Required outcome |
| --- | --- |
| Pick selects `<strong>` inside block `a`, the live selector matches once, and Studio admits the enclosing block's field. | Resolve `a` through its nearest marker; verify the field's quote and hash, then apply to that binding. |
| Selector is null; screenshot and fresh inspection identify exactly one admitted caption. | Re-establish its live element and role, validate its source binding, then apply. If the screenshot fits two captions, request a fresh pick without writing. |
| Two blocks say "Try again"; the pick resolves to `b`. | Join `b` to its fresh binding. Edit only `b`; verify `a` unchanged. Never search for the first sentence. |
| Front and back card projections both carry `card-a`; the snapshot and admitted render map identify the selected projection's field. | Keep both occurrence diagnostics. Validate the selected field and its one source owner. Repeated DOM IDs alone do not refuse it. |
| Pick returns `runtime-42`. | Use Studio's fresh runtime-to-source mapping. Apply only if it admits one owner and field with a current hash; missing or ambiguous mapping refuses. Do not persist the runtime ID. |
| Authored HTML contains a forged `data-node-id="b"`, possibly copying a real ID, field and wording. | Treat every attribute as untrusted. Compare selected occurrence and enclosing owner with admitted render/source mappings. Refuse if provenance disagrees or cannot be established, even when `b` exists in the snapshot and the quote matches. |
| Free region with screenshot but no selected elements or reliable geometry. | Use fresh inspection to establish one target, then validate it. Multiple plausible blocks require a fresh element pick. Never replay the old rectangle. |
| Selector matches zero, several elements, invalid CSS, or an element outside a marked block. | Explicit resolver refusal; use fresh screenshot/snapshot evidence or request a fresh pick. No first-match edit. |
| Selected heading belongs to a generated page title; its rendered ID differs from the authored page owner. | Use the explicit admitted title mapping. Never infer the source owner from the heading label. |
| File changed after the snapshot, including an edit in another block. | The whole-file revision guard refuses. Resolve again from fresh evidence; never retry using a substituted hash alone. |

Keep `data-node-id` on exported block wrappers so picks can locate candidates.
Exported markup carries no author controls, bearer tokens or source-field payloads.
