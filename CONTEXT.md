# Brow Browser Automation

Brow is a browser-side agent that observes the user's current Chrome tabs and helps operate visible web pages through page tools, browser snapshots, and visual analysis.

## Language

**Browser Snapshot**:
A compact, role-oriented view of a browser tab that exposes visible page objects with refs the agent can use.
_Avoid_: DOM dump, page text, screenshot

**Element Ref**:
A short identifier from a **Browser Snapshot** that points to one visible page object within that snapshot lifecycle.
_Avoid_: CSS selector, XPath, locator

**Actionable Ref**:
An **Element Ref** that resolves to a page object Brow is allowed to click, hover, type into, or fill.
_Avoid_: clickable selector, target string

**Visual Region**:
A viewport-bounded part of the page that can be cropped and sent to the configured VLM for perception-only extraction.
_Avoid_: coordinate click target, screenshot

**Brow Action Memory**:
A local, non-secret cache of successful **Actionable Ref** resolutions keyed by stable intent and page pattern so Brow can replay and repair repeatable browser actions.
_Avoid_: Stagehand cache, Playwright trace, saved form data

**WebMCP Page Tool**:
A semantic tool exposed by the page itself through WebMCP for Brow to invoke on that tab.
_Avoid_: browser automation tool, extension command

**MCP App**:
An interactive UI application supplied by an MCP server through the MCP Apps extension.
_Avoid_: WebMCP app, embedded website, page tool

**UI Resource**:
A `ui://` MCP resource that contains `text/html;profile=mcp-app` HTML for an **MCP App View**.
_Avoid_: iframe URL, widget HTML, template string

**MCP App View**:
One user-approved live iframe instance of an **MCP App** rendered inline in Brow chat.
_Avoid_: persistent trusted app, restored iframe, tab content

**App-backed MCP Tool**:
An MCP server tool whose descriptor points at a **UI Resource** through `_meta.ui.resourceUri` or the deprecated `_meta["ui/resourceUri"]`.
_Avoid_: WebMCP Page Tool, browser automation action

**MCP Server Card**:
A sidepanel card that summarizes one configured remote MCP server, its connection state, and its discovered tools.
_Avoid_: server chip, connection row, MCP app card

**MCP Tool Card**:
A compact expandable sidepanel card that summarizes one tool discovered from an MCP server.
_Avoid_: tool chip, raw descriptor, WebMCP Page Tool

## Relationships

- A **Browser Snapshot** contains many **Element Refs**.
- An **Actionable Ref** is a subset of **Element Ref**.
- A **Visual Region** may be identified by an **Element Ref** or by an explicit viewport rectangle.
- **Brow Action Memory** stores stable element signatures and post-action trace metadata, not typed secrets or raw dynamic field values.
- **Brow Action Memory** is attempted before fresh **Actionable Ref** execution when a stable action intent is provided.
- A **WebMCP Page Tool** is preferred before browser-level **Actionable Ref** automation when both can satisfy the same task.
- A **Browser Snapshot** refreshes after mutating automation so old **Element Refs** are not trusted indefinitely.
- An **App-backed MCP Tool** is discovered from an MCP server, not from the current web page.
- An **MCP Server Card** contains zero or more **MCP Tool Cards**.
- An **MCP Tool Card** may represent an **App-backed MCP Tool** when its descriptor points at a **UI Resource**.
- An **MCP App View** may call app-visible tools and read resources only through the same MCP server that supplied its **UI Resource**.
- A **WebMCP Page Tool** belongs to a tab page; an **MCP App View** belongs to a chat render and is not restored as live HTML from saved conversations.

## Example Dialogue

> **Dev:** "Should Brow click the Submit selector?"
> **Domain expert:** "No, Brow should use the Submit **Actionable Ref** from the latest **Browser Snapshot**. If the page changed, take a fresh snapshot."

## Flagged Ambiguities

- "reference" was used to mean both selectors and Playwright-style refs; resolved: the canonical term is **Element Ref**, and selectors are fallback implementation details.
- "VLM automation" could mean visual extraction or coordinate control; resolved: VLM use is **Visual Region** perception only, not coordinate-driven action.
- "Stagehand logic" means **Brow Action Memory** and Browser Snapshot repair in Brow's MV3-native extension context, not a direct Stagehand SDK dependency.
- "MCP app" can sound like a page-exposed WebMCP tool; resolved: **MCP App** means server-supplied MCP Apps UI, while **WebMCP Page Tool** means page-supplied tab capability.
- "tool card" can refer to page tools or MCP server tools; resolved: **MCP Tool Card** means a sidepanel card for a tool discovered from a configured remote MCP server.
