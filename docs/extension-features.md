# Brow Extension Feature Guide

This document describes the currently available features in the Brow Chrome extension as implemented in this repository.

It focuses on features that are present in the codebase now, not on ADR ideas that are not yet exposed as top-level user features or callable tools.

## 1. What Brow Is

Brow is a Manifest V3 Chrome extension that places an AI browser agent inside the Chrome side panel.

The extension is designed to work inside the user's real Chrome session instead of spinning up a separate automation browser. It combines:

- built-in browser reading and automation tools,
- page-local WebMCP tools discovered from tabs,
- remote MCP server tools,
- inline MCP Apps,
- configurable LLM and VLM endpoints,
- persistent conversations, recorded workflows, and reusable skills.

At a high level, Brow is both:

- a user-facing browser assistant UI, and
- an execution environment for model-driven browser operations.

## 2. User-Facing Surfaces

### 2.1 Chat Surface

The chat surface is the main working area of the extension.

It provides:

- grounded side-panel chat with streaming assistant responses,
- a stop-generation action while the agent is busy,
- a visible WebMCP status indicator in the header,
- a refresh action for WebMCP discovery,
- a `New Chat` action,
- browser-context attachment controls,
- workflow recording controls,
- request-budget visibility,
- per-message copy actions,
- and a live tool-execution timeline.

The chat composer supports more than plain text. A user can:

- attach the current tab or additional tabs as context,
- record a workflow demonstration from the preferred attached tab,
- attach staged workflow demonstrations to the next turn,
- add a skill mention as the action frame for a message,
- and send a message that consists only of attached context when needed.

### 2.2 Tools Surface

The tools surface is a tool manifest browser and runtime control panel.

It shows:

- all visible built-in tools,
- discovered WebMCP tools,
- remote MCP tools,
- tool source badges,
- argument schemas,
- optional UI-resource metadata,
- and per-tool visibility metadata.

It also lets the user:

- enable or disable individual tools,
- toggle whole tool groups,
- inspect each tool's arguments and source,
- and review which tools are considered browser automation versus read-only tools.

Automation groups are called out explicitly as potentially page-mutating.

### 2.3 MCP Surface

The MCP surface manages remote MCP server connections.

It supports:

- adding a server by name, URL, and optional auth token,
- reconnecting a server,
- removing a server,
- seeing connection state and errors,
- seeing model-visible tool counts,
- and opening discovered MCP tools directly in the Tools surface.

### 2.4 Conversations Surface

The conversations surface is the saved-session browser.

It supports:

- automatic conversation persistence,
- loading an older conversation,
- deleting a conversation,
- starting a new conversation,
- and reviewing lightweight metadata such as title, message count, and recent activity time.

Saved conversations keep not only messages, but also the workflow demonstrations and compaction state associated with that conversation.

### 2.5 Prompt And Skills Surface

The prompt surface is both a prompt editor and a skills workspace.

It contains:

- a system prompt editor with edit and preview modes,
- pending Domain Skill proposals created by the agent,
- the Domain Skill registry,
- the built-in Interaction Skill registry,
- a Domain Skill editor,
- Domain Skill import from URL,
- and Domain Skill import from local markdown file.

Users can create, edit, enable, disable, approve, reject, remove, and preview skills from this surface.

### 2.6 Config Surface

The config surface is the in-sidepanel runtime configuration editor.

It supports:

- OpenAI-mode and Claude-mode configuration,
- base URL, API key, model, and context-window settings,
- model refresh/fetch for the configured endpoint,
- recursion-limit configuration,
- VLM endpoint, key, and model configuration,
- and reconnect/apply behavior after configuration changes.

This is the main runtime LLM control surface for the agent.

### 2.7 Options Page

The extension also ships a separate options page.

That page currently focuses on extension-wide settings such as:

- a remote MCP endpoint,
- MCP transport selection,
- optional auth token,
- WebMCP feature enablement,
- MCP Apps enablement,
- and debug logging enablement.

## 3. Core Browser Automation Model

Brow is built around browser-native context gathering and safe browser execution patterns.

### 3.1 DOM-Derived Browser Snapshots

Brow captures compact, ref-based browser snapshots from the live DOM in the user's current tab.

These snapshots:

- expose semantic elements and stable refs,
- prioritize actionable targets over decorative DOM,
- let the model plan with current-page structure,
- and avoid requiring Chrome debugger permission.

This is the backbone of Brow's browser interaction model.

### 3.2 Element Refs And Fresh-Context Execution

Most high-confidence browser actions operate on refs returned by `browser_snapshot` rather than raw selectors.

The model is expected to:

- take a snapshot,
- locate the correct ref,
- act using that ref,
- and reacquire context after mutation.

This reduces brittle selector guessing and stale-target errors.

### 3.3 Whole-Form Semantics

Brow exposes whole-form semantics through `browser_form_snapshot`.

This feature goes beyond visible inputs and includes:

- hidden and offscreen field metadata,
- field purposes,
- safe current values,
- validation cues,
- combobox selection state,
- popup-option refs when available,
- and submit semantics.

The point is to let the model plan a form fill as a form, not as a loose sequence of unrelated textbox operations.

### 3.4 Canonical Field Purpose Vocabulary

Form fields are normalized into a Brow-specific field-purpose vocabulary rather than only echoing raw HTML autocomplete or label text.

This gives the model:

- stable planning categories,
- evidence-backed ambiguity handling,
- and a safer way to distinguish unknown fields from known ones.

### 3.5 Postconditions And Recovery Signals

Brow's browser actions support a verification-oriented workflow.

The model can attach postconditions so Brow can tell whether an action actually produced the intended page state.

The runtime also surfaces structured recovery signals such as:

- failed postconditions,
- repair-needed states,
- repair candidates,
- and helper-required states.

### 3.6 Brow Action Memory

Brow includes an intent-based action memory concept for repeatable browser operations.

The idea is:

- successful ref resolutions can be keyed by a stable, non-secret intent,
- the agent can reuse that intent on repeated tasks,
- and Brow can attempt stable action repair without storing sensitive data.

### 3.7 Helper-Aware Automation Boundaries

The extension is MV3-first, but it is explicit about the limits of pure extension automation.

The runtime is designed to surface when a stronger local helper backend is needed for things like:

- native file picking,
- stronger drag/drop fidelity,
- native dialogs,
- cross-origin frame automation,
- and harder surface-like interactions.

This means Brow does not treat those harder cases as silent successes.

## 4. Built-In Tool Families

Brow ships a large built-in toolset. The easiest way to understand it is by tool family.

| Tool Family | Main Tools | What The Family Does |
|---|---|---|
| Tab and session awareness | `tabs_list`, `tabs_getActive`, `tabs_activate`, `tabs_create`, `tabs_updateUrl` | Enumerates tabs, identifies the active tab, switches tabs, opens tabs, and navigates tabs. |
| Page reading and inspection | `tabs_getContent`, `tabs_listInteractiveElements`, `browser_snapshot`, `browser_form_snapshot` | Reads page content, finds interactive elements, captures semantic snapshots, and inspects forms. |
| Ref-based interaction | `browser_click`, `browser_hover`, `browser_type`, `browser_fill_form` | Performs high-confidence UI interactions using snapshot refs. |
| Selector or locator fallback | `tabs_click`, `tabs_highlight`, `tabs_hover`, `tabs_type`, `tabs_fillForm` | Provides compatibility and fallback behavior when ref-based interaction is not the chosen path. |
| Rich browser mechanics | `browser_drag`, `browser_scroll`, `browser_key`, `browser_wait_for`, `browser_upload_file`, `browser_download_wait`, `browser_handle_dialog` | Covers drag/drop, scroll, key input, state waiting, uploads, downloads, and dialog handling. |
| Visual perception | `browser_visual_query`, `tab_screenshot_vlm` | Uses the configured VLM for perception-only analysis of tabs or regions. |
| Browser data and network access | `bookmarks_getAll`, `bookmarks_search`, `history_search`, `http_fetch` | Reads bookmarks, searches history, and performs curl-like HTTP requests. |
| WebMCP support tools | `webmcp_discover`, `webmcp_invoke` | Discovers and invokes page-local WebMCP tools. |
| Skill tools | `skills_load`, `skills_propose` | Loads skill details and saves pending Domain Skill proposals for review. |

### 4.1 Compatibility Alias Tools

The extension also ships alias tools for compatibility and ergonomic prompting.

These include names such as:

- `click`, `click_element`,
- `highlight`, `highlight_element`,
- `hover`, `hover_element`,
- `type`, `type_text`,
- `fill_form`, `fill_form_fields`,
- `list_interactive_elements`,
- `get_active_tab`, `list_tabs`, `get_content`,
- `activate_tab`, `create_tab`, `navigate`.

These do not add new execution capabilities. They map onto the primary built-in tools.

## 5. WebMCP Features

WebMCP is Brow's page-local tool discovery system.

### 5.1 Per-Tab Tool Discovery

The extension can discover tools exposed directly by web pages via the WebMCP protocol.

That discovery is:

- per tab,
- reflected in the header status indicator,
- mirrored between background and sidepanel state,
- and refreshable from the sidepanel header.

### 5.2 Dynamic Tool Wiring

Discovered page tools are converted into callable agent tools dynamically.

The generated names are tab-scoped so that:

- tools discovered on one tab do not silently apply to another,
- page tools can coexist with built-in and remote MCP tools,
- and the agent can prefer page-local semantics over DOM automation when appropriate.

### 5.3 Aftermath Capture For Mutating Page Tools

When a WebMCP tool appears to mutate page state, Brow can capture a post-invocation aftermath snapshot so the agent sees the resulting page state rather than treating the tool call as an opaque black box.

## 6. Remote MCP Server Features

Remote MCP support is one of the extension's largest capabilities.

### 6.1 Remote Server Connectivity

Brow supports connecting to remote MCP servers over HTTP-oriented transports.

The repository exposes support for:

- HTTP,
- SSE,
- and streamable HTTP.

Server connection details can include an optional auth token.

### 6.2 Persistent Server Registry

Connected servers are persisted in local extension storage so the server list survives across browser sessions.

### 6.3 Tool Discovery And Inspection

For connected servers, Brow discovers tools and exposes them through:

- the MCP panel,
- the Tools surface,
- and the compiled agent tool manifest.

Tool cards expose:

- source,
- technical name,
- arguments,
- visibility metadata,
- and app-related UI metadata when present.

### 6.4 Model Visibility Versus Execution Permission

The design deliberately separates:

- what the model can see for planning,
- and what is actually executable based on user enablement or approval.

This lets the model plan more intelligently without giving automation unrestricted default power.

## 7. MCP App Features

MCP Apps are interactive HTML app views supplied by MCP servers.

### 7.1 Inline App Rendering In Chat

Brow can render approved app-backed MCP tool results inline in the chat stream.

This means MCP integration is not limited to text tool output. A server can also provide a richer embedded UI.

### 7.2 Per-Render Approval Model

App rendering is approval-based.

The user sees an approval card before an app view is rendered, rather than Brow automatically trusting arbitrary remote HTML.

### 7.3 MV3 Sandboxed App Host

App views are rendered through an MV3 sandbox page rather than directly inside privileged extension UI.

That gives Brow:

- isolation from untrusted app HTML,
- clearer message-bridge routing,
- and a safer place to apply permission and CSP controls.

### 7.4 Same-Server Routing

App-originated MCP operations are constrained to the MCP server that produced the UI resource.

This keeps app execution bound to its source server rather than giving the app broad cross-server reach.

### 7.5 Conversation-Safe Persistence Behavior

Saved conversations do not restore live iframes as active app views. They retain placeholders rather than rehydrating untrusted app HTML automatically.

## 8. Workflow Demonstration Features

Workflow Demonstrations are conversation-scoped recorded workflows.

### 8.1 Recording

From the chat surface, the user can start and stop workflow recording on the preferred attached tab.

The recording flow:

- chooses the preferred context tab,
- generates a default title such as `demo1`, `demo2`, and so on,
- captures typed values,
- and turns the recording into a structured workflow artifact when stopped.

### 8.2 Captured Replay Evidence

A demonstration stores structured evidence such as:

- tab context,
- target evidence,
- selectors,
- safe recorded values,
- and pointer evidence for harder click targets.

It is not treated as a dumb macro.

### 8.3 Staging And Attachment

After recording, the workflow demonstration is staged in the composer and attached to the next user turn.

The associated browser tab is also kept in context so the demonstration remains grounded.

### 8.4 Detail Inspection

The user can open a detail overlay for a recorded workflow demonstration and inspect the generated context representation used by the system.

### 8.5 Conversation Persistence

Workflow demonstrations are saved with the conversation they belong to. They are not yet treated as a single global library.

### 8.6 Context-First Behavior

The current prompt behavior treats an attached workflow demonstration as context first.

That means the agent can:

- explain what the user did,
- answer questions about the workflow,
- or adapt the workflow when the user asks,

without being forced to replay it on every turn.

## 9. Skills Features

Brow supports two different skill systems.

### 9.1 Domain Skills

Domain Skills are user-managed, reusable site knowledge.

Each Domain Skill can include:

- display name,
- slug,
- description,
- tags,
- optional domain matchers,
- optional path matchers,
- optional page-pattern matchers,
- and markdown content.

Users can:

- create new Domain Skills,
- edit existing ones,
- remove them,
- enable or disable them,
- import them from URL,
- and import them from a local markdown file.

### 9.2 Interaction Skills

Interaction Skills are built-in, read-only Brow mechanics for cross-site behavior.

The shipped built-in Interaction Skills include:

- Iframe Navigation,
- Shadow DOM Controls,
- Dialogs And Overlays,
- Uploads And Pickers,
- Tabs And Windows.

These are always available as packaged capabilities rather than user-authored skills.

### 9.3 Skill Mention Flow

The composer supports selecting a skill mention for the current message. That lets a single message be framed around one specific skill.

### 9.4 Agent-Generated Domain Skill Proposals

The agent can create pending Domain Skill proposals via `skills_propose` when it discovers durable site knowledge.

Those proposals:

- do not become active automatically,
- appear in the Prompt and Skills surface,
- and require explicit human approval or rejection.

## 10. Request Budget, Compaction, And Debugging Features

Brow includes unusually strong prompt observability for a browser extension.

### 10.1 Request Budget Indicator

The chat surface shows an estimated request budget indicator for the next assembled model request.

It reflects:

- estimated token usage,
- the configured context window,
- and a percentage-style usage indicator.

### 10.2 Copy Context Debug

The `Copy Context` button exports a structured debug view of the request context.

That exported text includes:

- the current query,
- estimated tokens,
- raw carried history,
- the exact prompt surface passed to the agent,
- request-shape breakdowns,
- timing breakdowns,
- and live turn updates when present.

This is useful both for debugging and for auditing what the model actually received.

### 10.3 Conversation Compaction

When a conversation becomes too large for the available request budget, Brow can compact earlier turns into a durable summary while keeping more recent turns verbatim.

That feature is designed to:

- preserve usable long-running context,
- avoid silent truncation,
- and keep request growth under control.

### 10.4 Tool Execution Timeline

The chat UI shows a live, collapsible tool-step tracker.

It includes:

- per-step labels,
- running/completed/error states,
- duration summaries,
- raw details toggles,
- and approval actions for gated steps.

### 10.5 Copy Message Actions

Each rendered message bubble includes a copy action so the user can quickly copy message content from the chat transcript.

## 11. Conversation And Persistence Features

Brow stores substantial working state locally.

Persisted data includes:

- saved conversations,
- rendered conversation messages,
- raw chat history for replay into the agent,
- workflow demonstrations,
- staged workflow-demonstration IDs,
- conversation compaction state,
- MCP server definitions,
- skill registry entries,
- pending Domain Skill proposals,
- editor state for config and prompt surfaces,
- system prompt changes,
- and extension settings.

The persistence model is centered around `chrome.storage.local`.

## 12. Security, Trust, And Permission Features

The extension has an explicit trust model.

### 12.1 Tool Visibility Is Separate From Execution Permission

Automation tools can be visible for planning while still requiring enablement or user approval before they are actually executed.

### 12.2 Automation Tools Default To A Safer Posture

The codebase defines a default-disabled set for automation-oriented tools, which supports a safer initial execution posture without hiding the tools from the model entirely.

### 12.3 No Chrome Debugger Permission Requirement

Brow's primary snapshot strategy avoids relying on `chrome.debugger`, which reduces permission friction and keeps the agent inside the user's real browsing session.

### 12.4 MCP App Sandboxing

Untrusted app HTML is isolated through the MV3 sandbox host rather than being mixed directly into privileged extension UI.

### 12.5 Explicit Browser Permissions

The extension currently declares support for permissions including:

- side panel,
- storage,
- tabs,
- scripting,
- active tab,
- bookmarks,
- history,
- downloads,
- and host access on all URLs.

These permissions line up with the feature set described above.

## 13. Internal Architecture Summary

The extension is organized into several major runtime components.

### 13.1 Side Panel

The side panel owns:

- the chat UI,
- runtime agent configuration,
- skills and prompt editing,
- tool manifests,
- conversations UI,
- and MCP App rendering approval flow.

### 13.2 Background Service Worker

The background worker handles extension lifecycle responsibilities and registry-style coordination such as WebMCP state propagation.

### 13.3 Content Script And Page Bridge

The content script side owns page-coupled capabilities such as:

- page observation,
- DOM-derived snapshot generation,
- WebMCP discovery support,
- and workflow recording.

### 13.4 Options Page

The options page provides extension-wide settings outside the main sidepanel workflow.

## 14. What This Guide Intentionally Does Not Claim

Some ADRs discuss richer semantic surfaces such as dedicated region snapshots or frame snapshots as first-class tools.

Those ideas are useful design context, but they are not listed here as shipped top-level features unless they are clearly exposed in the current repository's runtime surfaces or tool inventory.

## 15. Related Repository Documents

- [README](../README.md)
- [CONTEXT](../CONTEXT.md)
- [ADR 0001: DOM-Derived Browser Snapshots](./adr/0001-dom-derived-browser-snapshots.md)
- [ADR 0002: MV3 Sandboxed MCP App Host](./adr/0002-mv3-sandboxed-mcp-app-host.md)
- [ADR 0003: Workflow Demonstration Artifact Module](./adr/0003-workflow-demonstration-artifact-module.md)
- [ADR 0005: Specialized Semantic Browser Tools](./adr/0005-specialized-semantic-browser-tools.md)
- [ADR 0006: Whole-Form Semantic Snapshots](./adr/0006-whole-form-semantic-snapshots.md)
- [ADR 0007: Canonical Field Purpose Vocabulary](./adr/0007-canonical-field-purpose-vocabulary.md)
- [ADR 0008: Region Snapshots As Interaction Maps](./adr/0008-region-snapshots-as-interaction-maps.md)
- [ADR 0009: Helper For Cross-Origin Frame Automation](./adr/0009-helper-for-cross-origin-frame-automation.md)
- [ADR 0010: Separate Tool Visibility From Execution Permission](./adr/0010-separate-tool-visibility-from-execution-permission.md)