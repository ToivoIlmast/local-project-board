# ADR-0023: Agent-written HTML is served sandboxed and offline

Status: accepted (2026-09-23)

## Context

Reports, and documents named `*.html`, are written by AI agents through the API and then read
back in the browser from the board's own origin. A report is useful when it is interactive — a
dependency audit draws charts — so refusing all scripts would make the feature pointless. But the
same page must never reach the board's DOM, its session token or its API, and it must not be able
to send what it has read anywhere.

## Decision

- Every HTML body the API serves (`GET /reports/:id`, `GET /tasks/:id/documents/*.html`) carries
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none';
frame-ancestors 'self'` and `X-Content-Type-Options: nosniff`.
- `allow-same-origin` is never granted: the document gets an opaque origin of its own, so it
  cannot read the board's page, its storage or its token even when framed by it.
- A markdown report is served as `text/markdown`, never as HTML.
- The response is safe on its own, so the UI's `<iframe sandbox>` (§15) is a second layer, not
  the only one: opening the URL directly in a tab is equally contained.

## Consequences

- A report cannot load a script, a font or an image from the network, and cannot call home; it
  must carry what it needs inline or as a `data:` URI.
- A report that needs `eval` (some chart libraries) will not run: `'unsafe-eval'` is not granted.
  Loosening this is a decision to take on its own, not a patch to a header.

## Amendment (2026-09-23, implemented in phase 11)

The UI now renders this content, which fixes how:

- An HTML report or an `.html` document is shown in an `<iframe sandbox="allow-scripts">`
  pointed at the board's own URL for it, so the server's headers apply as well. The page never
  inlines that HTML, and `allow-same-origin` appears nowhere.
- Markdown — task descriptions, `.md` documents, `.md` reports — is rendered to React
  elements, not to HTML: raw HTML inside markdown is not parsed and never reaches the DOM.
  That is why the page needs no HTML sanitizer to be safe.
