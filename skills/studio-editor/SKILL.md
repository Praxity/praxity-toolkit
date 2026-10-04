---
name: studio-editor
description: Open or restart a local Praxity Studio browser editor and hand its fresh authenticated ready URL to the user's preview or browser.
---

Use the local project folder as the working directory. Launch the absolute
`~/.praxity/bin/praxity studio . --no-open` command as a background process through
the host's process tool. Keep its process handle and stdout in the active session.
Do not redirect output to a file or launch a second editor for the same folder.

Capture the complete ready URL from stdout, including `#session=...`. Wait for
readiness rather than guessing a port. Treat the fragment as a capability token.
Never write the URL or token to files, project settings, shell history or logs.
The host's tool transcript may retain the capability; explain this if relevant.

In T3 desktop, use its authenticated `preview_open` or `preview_navigate` tool
with the exact URL and `open: true`. If unavailable or refused, open the exact URL
in the user's local browser with the host's browser-opening tool, or give the URL
to the user in the active conversation. Do not put Studio in an iframe or weaken
its origin checks. Remote hosts need their own supported loopback access.

Keep the editor process alive while the user works. On cancellation, process
death or a failed preview, report the error and preserve the course files. Before
an intentional restart, let the user save and stop the old process. Launch again,
capture a fresh URL, and navigate again with `open: true`. Discard the old URL.
Stop the owned process when the user is done. Use Studio's packaged format skill
for course edits; this skill only manages the editor process and preview.
