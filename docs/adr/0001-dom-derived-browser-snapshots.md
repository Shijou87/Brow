# Use DOM-Derived Browser Snapshots For Brow Automation

Brow will generate Playwright MCP-style snapshots from the page DOM inside the user's current Chrome tab, rather than attaching through Chrome CDP/debugger or delegating to an external Playwright MCP browser. This keeps Brow operating in the user's real browser session without adding the intrusive debugger permission or drifting into a separate automation browser, while still giving the agent ref-based, refreshed automation targets and regional VLM perception.

## Considered Options

- DOM-derived snapshots in the extension tab context.
- Chrome CDP accessibility snapshots through `chrome.debugger`.
- An external Playwright MCP server controlling a separate browser/session.

## Consequences

DOM-derived snapshots are an approximation of an accessibility tree, so they need careful role/name inference and safe stale-ref recovery. In exchange, v1 preserves Chrome session continuity, avoids debugger UX friction, and keeps automation deployable as a normal MV3 extension capability.
