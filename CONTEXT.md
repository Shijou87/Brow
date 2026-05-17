# Brow Browser Automation

Brow is a browser-side agent that observes the user's current Chrome tabs and helps operate visible web pages through page tools, browser snapshots, and visual analysis.

## Language

**Browser Snapshot**:
A compact, role-oriented view of a browser tab that exposes visible page objects with refs the agent can use.
_Avoid_: DOM dump, page text, screenshot

**Form Snapshot**:
A form-oriented semantic view that groups fields, labels, autocomplete hints, current safe values, validation cues, and submit controls for form automation.
_Avoid_: Browser Snapshot, form DOM dump, identity

**Field Purpose**:
Brow's inferred user-visible purpose for a form field, backed by evidence and confidence so ambiguous fields can remain unknown.
_Avoid_: label, autocomplete token, identity key

**Safe Field Value**:
A non-secret current form value Brow may expose for verification or editing while omitting passwords, files, tokens, credit-card-like values, and other sensitive inputs.
_Avoid_: raw value, autofill value, identity value

**Full-Spectrum Browser Automation**:
Brow's automation goal of operating the visible browser across controls, forms, drawing surfaces, keyboard flows, drag/drop, dialogs, uploads, downloads, frames, and shadow DOM.
_Avoid_: form bot, click bot, page macro

**Element Ref**:
A short identifier from a **Browser Snapshot** that points to one visible page object within that snapshot lifecycle.
_Avoid_: CSS selector, XPath, locator

**Actionable Ref**:
An **Element Ref** that resolves to a page object Brow is allowed to click, hover, type into, or fill.
_Avoid_: clickable selector, target string

**Visual Region**:
A viewport-bounded part of the page that can be cropped and sent to the configured VLM for perception-only extraction.
_Avoid_: coordinate click target, screenshot

**Region Snapshot**:
A region-oriented semantic view for canvas, SVG, video, map, board, or other surface-like controls that describes geometry, coordinate spaces, subtargets when available, and helper needs.
_Avoid_: screenshot, raw coordinates, visual query

**Brow Action Memory**:
A local, non-secret cache of successful **Actionable Ref** resolutions keyed by stable intent and page pattern so Brow can replay and repair repeatable browser actions.
_Avoid_: Stagehand cache, Playwright trace, saved form data

**Domain Memory**:
Agent-managed, local operational knowledge scoped to a domain or page pattern, used to remember reusable site mechanics such as flows, selectors, waits, quirks, safe API hints, and failure fixes.
_Avoid_: Brow Action Memory, Domain Skill, user profile, account memory, saved page content

**Experience Learning**:
Brow's agent-decided practice of saving non-secret operational lessons after a browser attempt fails, is understood, or is repaired, so Brow can avoid repeating the same mistake later.
_Avoid_: automatic telemetry, hidden prompt note, user profile, transcript memory

**Workflow Demonstration**:
A conversation-scoped artifact that captures a user-demonstrated workflow as structured replay evidence: page context, stable targets, selectors, key attributes, and safe concrete values Brow can later replay adaptively or promote into a **Domain Skill** proposal.
_Avoid_: macro, exact script, Brow Action Memory entry

**Staged Demonstration**:
A recorded **Workflow Demonstration** the user has chosen to attach to the next chat message as replay evidence for Brow.
_Avoid_: pending workflow, draft recording, queued demonstration

**Pointer Evidence**:
Target-relative and viewport-relative pointer data captured for a **Workflow Demonstration** step so Brow can replay clicks inside region-like controls such as canvas or SVG surfaces.
_Avoid_: raw coordinate macro, screenshot click target

**Target Evidence**:
Role, name, text, selector, attribute, and optional frame or shadow context captured for a target so Brow can resolve a fresh **Element Ref** on the current page.
_Avoid_: old ref, CSS-only locator, semantic snapshot

**Domain Skill**:
A user-managed durable Brow skill that captures reusable site knowledge for a domain, optionally narrowed by path or page pattern.
_Avoid_: Domain Memory, Brow Action Memory entry, one-off run note, interaction tactic

**Interaction Skill**:
A Brow-built reusable skill for cross-site browser mechanics such as dialogs, iframes, shadow DOM, uploads, and tab switching.
_Avoid_: site-specific recipe, Brow Action Memory entry, page tool

**Skill Mention**:
A visible per-message reference to one **Domain Skill** or **Interaction Skill** whose full content is injected into that user turn.
_Avoid_: slash command, prompt tag, skill attachment

**Request Budget**:
The estimated share of the configured LLM context window consumed by Brow's next assembled agent request, including earlier conversation state, current browser context, skills, demonstrations, and the pending user turn.
_Avoid_: browser context, token count, model quota

**Conversation Compaction**:
The act of replacing older chat turns with a durable running summary so Brow can preserve earlier task state while keeping the next request within the available **Request Budget**.
_Avoid_: transcript deletion, browser snapshot compression, silent truncation

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

**HTML App Artifact**:
A Brow-authored, conversation-scoped, self-contained HTML document with inline CSS and JavaScript that Brow can save, reopen, render, download, and revise.
_Avoid_: MCP App, remote website, code block, data URL tab

**HTML App Revision**:
One saved revision of an **HTML App Artifact** that captures a specific HTML source snapshot and render hint.
_Avoid_: live tab state, MCP resource version, diff patch

**HTML App View**:
One user-approved live render of an **HTML App Artifact**, shown either inline in Brow chat or in a dedicated Brow-hosted browser tab.
_Avoid_: MCP App View, restored live iframe, raw browser tab

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
- A **Form Snapshot** uses **Element Refs** from the current page but presents fields as form tasks rather than standalone visible elements.
- A **Region Snapshot** uses an **Element Ref** or explicit **Visual Region** as its subject and presents surface interaction semantics rather than page structure.
- A **Form Snapshot** may include hidden or offscreen fields as form metadata, while only safe actionable fields become fill targets.
- A **Form Snapshot** may assign one **Field Purpose** to each field; low-confidence or conflicting evidence should produce an unknown purpose.
- A **Form Snapshot** may expose **Safe Field Values** for verification and editing, but sensitive current values are omitted.
- A **Form Snapshot** should feed batched form execution with verification rather than encouraging the agent to fill fields one-by-one.
- A **Form Snapshot** describes form structure independently of any value source; choosing or storing values belongs to a separate flow.
- **Full-Spectrum Browser Automation** uses the best available execution path for each interaction family rather than forcing every task through a single click/fill primitive.
- An **Actionable Ref** is a subset of **Element Ref**.
- A **Visual Region** may be identified by an **Element Ref** or by an explicit viewport rectangle.
- **Brow Action Memory** stores stable element signatures and post-action trace metadata, not typed secrets or raw dynamic field values.
- **Brow Action Memory** is attempted before fresh **Actionable Ref** execution when a stable action intent is provided.
- A **Workflow Demonstration** persists with a saved conversation in v1 rather than a global library.
- A **Staged Demonstration** becomes a message-attached **Workflow Demonstration** when the user sends the message.
- A **Workflow Demonstration** is distinct from **Brow Action Memory**: it stores user-demonstrated replay evidence, not a low-level replay cache or coordinate macro.
- A **Workflow Demonstration** may store normal non-secret typed and selected values when the user records a workflow; passwords, files, and picker-only values are omitted or manual.
- **Pointer Evidence** belongs to a **Workflow Demonstration** step and must be applied to a fresh live target rather than replayed as a standalone coordinate macro.
- **Pointer Evidence** prefers target-relative fractions for repeatability, then target-relative offsets, with viewport coordinates as the least stable fallback.
- **Target Evidence** can be captured by a **Workflow Demonstration** and used later to find a current **Element Ref** when historical refs are stale.
- **Target Evidence** is evidence for resolving a target, not permission to execute an action without a fresh **Browser Snapshot**.
- A **Workflow Demonstration** may support a **Domain Skill** proposal, but it does not activate durable site knowledge by itself.
- **Experience Learning** lets Brow decide what is worth saving as its own memory, but durable site-specific lessons should still be stored as **Domain Memory**.
- **Experience Learning** should save lessons only when they describe reusable operational mechanics, not secrets, account content, private page data, raw dynamic values, or a full chat transcript.
- A **Domain Skill** is distinct from **Brow Action Memory**: it stores durable site knowledge, not low-level replay traces.
- A **Domain Skill** may match a whole domain or narrow itself with optional path and page patterns.
- An **Interaction Skill** is product-curated and applies across sites rather than belonging to one domain.
- A **Skill Mention** belongs to one user message and references exactly one **Domain Skill** or **Interaction Skill**.
- A **Skill Mention** stores display metadata in saved conversations; only newly sent turns inject the current skill content.
- **Request Budget** measures Brow's next assembled agent request, not just saved chat history or current browser state.
- **Conversation Compaction** summarizes older chat turns while leaving newer turns verbatim and preserving the full visible transcript.
- A **WebMCP Page Tool** is preferred before browser-level **Actionable Ref** automation when both can satisfy the same task.
- A **Browser Snapshot** refreshes after mutating automation so old **Element Refs** are not trusted indefinitely.
- An **App-backed MCP Tool** is discovered from an MCP server, not from the current web page.
- An **MCP Server Card** contains zero or more **MCP Tool Cards**.
- An **MCP Tool Card** may represent an **App-backed MCP Tool** when its descriptor points at a **UI Resource**.
- An **MCP App View** may call app-visible tools and read resources only through the same MCP server that supplied its **UI Resource**.
- An **HTML App Artifact** is Brow-authored and conversation-scoped; it is not supplied by an MCP server.
- An **HTML App Artifact** may have many **HTML App Revisions**, and the latest revision is the default reopen target.
- An **HTML App View** reuses Brow's sandboxed HTML host internally, but it is distinct from an **MCP App View** in product language and permissions.
- A **WebMCP Page Tool** belongs to a tab page; an **MCP App View** belongs to a chat render and is not restored as live HTML from saved conversations.
- A saved conversation may retain **HTML App Artifact** data and placeholder references, but it should not auto-run an **HTML App View** on load.

## Example Dialogue

> **Dev:** "Should Brow click the Submit selector?"
> **Domain expert:** "No, Brow should use the Submit **Actionable Ref** from the latest **Browser Snapshot**. If the page changed, take a fresh snapshot."

## Flagged Ambiguities

- "reference" was used to mean both selectors and Playwright-style refs; resolved: the canonical term is **Element Ref**, and selectors are fallback implementation details.
- "automation" could mean only buttons and forms; resolved: Brow targets **Full-Spectrum Browser Automation**, including drawing and region-like interactions.
- "VLM automation" could mean visual extraction or coordinate control; resolved: VLM use is **Visual Region** perception only, not coordinate-driven action.
- "Stagehand logic" means **Brow Action Memory** and Browser Snapshot repair in Brow's MV3-native extension context, not a direct Stagehand SDK dependency.
- "recording" could mean raw event capture or a reusable conversation artifact; resolved: record is the UI verb, while the persisted artifact is a **Workflow Demonstration**.
- "recording data" could mean an executable macro or replay evidence; resolved: a **Workflow Demonstration** is replay evidence that Brow must translate onto the current page state.
- "semantic within the snapshot" could mean larger page text or reusable target identity; resolved: the reusable target identity concept is **Target Evidence**.
- "field meaning" could mean raw label text or an inferred semantic role; resolved: the canonical term is **Field Purpose**.
- "current values" could mean all DOM field values; resolved: only **Safe Field Values** may be exposed by form semantics.
- "identity" came up while discussing forms; resolved: identity storage or identity-based filling is out of scope for the current automation pipeline design.
- "skill" used to blur site knowledge and browser mechanics; resolved: **Domain Skill** means reusable site knowledge, while **Interaction Skill** means a Brow-built cross-site browser mechanic.
- "slash skill" could mean a command, attachment, or prompt edit; resolved: **Skill Mention** means the visible per-message skill reference selected from the leading slash picker.
- "MCP app" can sound like a page-exposed WebMCP tool; resolved: **MCP App** means server-supplied MCP Apps UI, while **WebMCP Page Tool** means page-supplied tab capability.
- "HTML app" could blur Brow-authored artifacts and server-supplied app UI; resolved: **HTML App Artifact** means Brow-authored saved HTML, while **MCP App** remains server-supplied UI.
- "tool card" can refer to page tools or MCP server tools; resolved: **MCP Tool Card** means a sidepanel card for a tool discovered from a configured remote MCP server.
