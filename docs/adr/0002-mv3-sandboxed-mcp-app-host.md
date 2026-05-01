# Use An MV3 Sandbox Proxy For MCP App Views

Brow will render MCP App Views through a Manifest V3 sandbox page that creates the inner app iframe and relays MCP Apps postMessage traffic to the side panel. The side panel owns the official `AppBridge`, same-server tool/resource routing, and the per-render approval card.

## Context

MCP Apps deliver interactive HTML from MCP servers. Brow cannot treat that HTML like trusted extension UI: the app may contain arbitrary scripts, request network access declared by resource CSP metadata, and call MCP tools through the host bridge. Chrome extension pages also run under MV3 extension CSP, so direct `srcdoc` rendering in the side panel would mix untrusted app execution with privileged extension UI.

## Decision

Use a double-iframe host:

- The chat view shows an inert permission card for each requested MCP App View.
- After approval, the side panel creates `mcp-app-sandbox.html`, an MV3 sandbox page.
- The sandbox page creates the inner app iframe, applies declared iframe permissions with `allow`, injects CSP metadata into the app HTML, validates message source, and relays MCP Apps messages.
- The side panel uses `@modelcontextprotocol/ext-apps` `AppBridge` and `PostMessageTransport` rather than hand-rolling the UI protocol.
- App-initiated `tools/call` and `resources/read` are routed only to the MCP server that produced the view; tool calls must pass MCP Apps visibility metadata.

## Consequences

The sandbox proxy keeps untrusted app HTML out of Brow's extension origin and gives Brow one bridge surface to audit. It also preserves a clean chat model: approval is per render, and saved conversations retain only a placeholder instead of restoring live iframes.

The first version supports inline display only. Because extension-packaged sandbox pages cannot set per-resource HTTP response headers, Brow enforces resource CSP by injecting a CSP meta tag inside the inner iframe document and by applying iframe sandbox/permission policy controls. A future version can strengthen this with a dedicated app content origin if Brow needs OAuth callback domains or stricter per-resource headers.
