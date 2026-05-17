# Reuse Brow's Sandboxed HTML Host For HTML App Artifacts

Brow will model Brow-authored interactive HTML as **HTML App Artifacts**, but will render them through the same sandboxed HTML host family already used for MCP Apps rather than creating a second HTML execution stack.

## Context

Brow already has a hardened MV3 sandbox path for rendering untrusted HTML inside an isolated iframe. The new HTML App Artifact feature adds a second source of executable HTML: Brow itself can now author self-contained games, previews, demos, and mini views for the user. That raises a design choice:

- create a separate Brow-only HTML rendering stack,
- or reuse the existing sandboxed HTML host mechanics while keeping the product language distinct from server-supplied MCP Apps.

The product language matters because MCP Apps are server-supplied and same-server-routed, while HTML App Artifacts are Brow-authored, conversation-scoped, and reopened from saved conversation state.

## Decision

Use **HTML App Artifact** as the domain concept and reuse Brow's sandboxed HTML host internally.

- **HTML App Artifact** is the saved Brow-authored HTML document.
- **HTML App View** is the approved live render of that artifact inline in chat or in a dedicated Brow-hosted tab.
- The rendering path reuses Brow's existing MV3 sandbox page, CSP injection, iframe isolation, and approval-based execution model.
- Brow keeps **MCP App** terminology reserved for remote server-supplied UI.
- Brow does not open raw `data:` tabs for these artifacts; the dedicated tab is an extension-hosted shell that loads the saved artifact revision into the sandbox path.

## Consequences

Brow gets one audited HTML isolation path instead of two. That keeps CSP, iframe sandboxing, and approval mechanics consistent between remote app HTML and Brow-authored HTML.

The trade-off is that the implementation has to separate product concepts from host mechanics: **HTML App Artifacts** reuse the host, but they do not inherit MCP server semantics, same-server routing, or MCP product language.
