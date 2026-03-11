# Chrome Extension Guideline: LangGraph.js Agent + MCP + MCP Apps + WebMCP + Tab Tools (v3)

## 0) Goal
Build a Chrome extension with a **Gemini-like global sidebar** where users can chat with an agent that:
- Runs **LangGraph.js** in the extension UI.
- Connects to a non-WebMCP **MCP server**.
- Renders **MCP Apps** returned by the MCP server inside the sidebar.
- Provides **tab tools**: list tabs, activate tabs, create tabs, update tab URL.
- Supports **WebMCP** tools for each open tab via `navigator.modelContext`.
- **Automatically observes new tabs/pages** and dynamically discovers WebMCP tools for those pages.
- Logs **WebMCP tool discovery** events to the **developer console**.

> **Important constraint:** The extension should **not** hardcode “intent mapping” (e.g., “gmail → https://mail.google.com”).  
> The **agent** (LangGraph + LLM) decides URLs and calls tab tools accordingly.

---

## 1) Recommended Architecture
### Components
1) **Side Panel UI (React)**
   - Chat UI + MCP Apps rendering area
   - Instantiates **LangGraph agent runtime**
   - Hosts **MCP client** and **MCP Apps host/renderer**
   - Maintains a **per-tab WebMCP tool registry**
   - Implements extension-native tab tools as tool functions callable by the agent

2) **Background Service Worker (MV3)**
   - Observes tab lifecycle/navigation events
   - Triggers WebMCP discovery via content scripts
   - Relays discovery results to the side panel
   - Handles injection/registration of content scripts when needed

3) **Content Script (per tab)**
   - Bridges WebMCP from the page to the extension
   - Discovers/invokes tools exposed by `navigator.modelContext`
   - Returns discovery results and invocation outputs

4) **Options Page**
   - MCP config (endpoint/transport/auth)
   - Feature flags: enable WebMCP, enable MCP Apps, debug logging

---

## 2) Manifest (MV3) Checklist
### Permissions
Required:
- `sidePanel`
- `storage`
- `tabs`

Recommended for dynamic WebMCP observation:
- `scripting`
- `activeTab` (optional depending on host permission strategy)

### Host permissions strategy
- Use a domain allowlist (recommended) or `<all_urls>` (broad).
- If enterprise policy requires it, use runtime permission requests for additional origins.

---

## 3) Tools Exposed to LangGraph Agent

### A) Tab management tools (extension-native)
Implement these tools in the side panel (or SW) and expose them to LangGraph.

#### 1) `tabs.list`
Returns:
- `tabId`, `windowId`, `title`, `url` (if permitted), `active`, `audible`, `status`

#### 2) `tabs.activate`
Input: `{ tabId }`
Action:
- `chrome.tabs.update(tabId, { active: true })`
- optionally `chrome.windows.update(windowId, { focused: true })`

#### 3) `tabs.create`
Input: `{ url, active?: boolean }`
Action:
- `chrome.tabs.create({ url, active: true })`

#### 4) `tabs.updateUrl`
Input: `{ tabId, url }`
Action:
- `chrome.tabs.update(tabId, { url })`

> The agent uses these tools to satisfy requests like “go to my Google mail” by deciding an appropriate URL (e.g., `https://mail.google.com/`) and calling `tabs.create` or `tabs.updateUrl`.  
> The extension **does not** implement rule-based intent mapping.

---

## 4) WebMCP Support (per tab)

### A) WebMCP discovery + invocation tools
Expose a stable interface to the agent:

#### 1) `webmcp.discover`
Input: `{ tabId? }` (default = active tab)
Output:
- `{ available: boolean, tools: [{ name, description, inputSchema? }], page: { url, title }, tabId }`
- If not available: `{ available: false, error: "WEBMCP_NOT_AVAILABLE" }`

#### 2) `webmcp.invoke`
Input: `{ tabId, toolName, args }`
Output:
- `{ ok: true, result }` or `{ ok: false, error }`

### B) Tool registry (side panel state)
Maintain:
- `registry[tabId] = { url, title, discoveredAt, available, tools: [...] }`

Update registry when:
- a new tab is created
- a tab completes navigation
- active tab changes (optional “refresh if stale”)

---

## 5) Dynamic Observation: Discover WebMCP Tools on New Pages/Tabs

### A) What “observe new page” means
Detect:
- new tab created
- navigation to a new URL in an existing tab
- reload/completion events

Then trigger WebMCP discovery for that tab.

### B) Events to listen to (background service worker)
- `chrome.tabs.onCreated`
- `chrome.tabs.onUpdated`:
  - trigger when `changeInfo.url` exists (navigation started) and/or
  - when `changeInfo.status === "complete"` (page finished)
- `chrome.tabs.onActivated` (optional: discover if missing/stale)

### C) Discovery trigger algorithm (recommended)
For each `tabId`:
1) Debounce discovery (e.g., 300–1000ms) to avoid multiple triggers on redirects.
2) Prefer discovering at `status === "complete"` to ensure page context is stable.
3) Ensure content script is present (inject if needed).
4) Send message to tab: `{ type: "WEBMCP_DISCOVER" }`
5) Receive response: `{ available, tools, page }`
6) Update registry and notify side panel.

### D) Content script responsibilities
On `{ type: "WEBMCP_DISCOVER" }`:
- Check for `navigator.modelContext`
- If absent → return `{ available: false, error: "WEBMCP_NOT_AVAILABLE" }`
- If present:
  - enumerate tools (based on API availability)
  - return `{ available: true, tools: [...] }`

On `{ type: "WEBMCP_INVOKE", toolName, args }`:
- invoke the tool in the page context and return results.

---

## 6) Developer Console Logging (WebMCP Discovery)

### A) Where logs should appear
Implement logs in:
1) **Service worker console** (primary, because discovery triggers from SW)
2) **Side panel console** (mirrors SW logs for UI debugging)

### B) What to log
For every discovery attempt:
- timestamp
- `tabId`, `url`, `title`
- `available` / error reason
- tool count and tool names
- duration (ms)

Example:
- `[WebMCP][discover] tab=123 url=https://example.com available=true tools=7 duration=42ms`
- `[WebMCP][discover] tab=124 url=https://foo.com available=false error=WEBMCP_NOT_AVAILABLE duration=5ms`

### C) Debug flag
Option: `debug.webmcpDiscoveryLogs`
- `true`: log tool schemas / richer metadata
- `false`: log only counts + names

---

## 7) MCP Connectivity (Non-WebMCP) + MCP Apps Rendering

### A) Transport decision (critical)
- HTTP/SSE/Streamable HTTP: connect directly from side panel
- stdio: provide local Node bridge/proxy; extension connects to bridge

### B) MCP Apps rendering
- If an MCP tool response contains an MCP App payload:
  - render it in a sandboxed iframe in side panel
  - validate postMessage events (origin + schema + session)
  - route UI events back to MCP server

### C) Unified output handling in UI
Normalize tool responses:
- `{ type: "text", content: "..." }`
- `{ type: "mcp_app", app: {...} }`
- `{ type: "data", json: {...} }`
- `{ type: "error", error: {...} }`

---

## 8) UX Requirements
- Side panel has:
  - chat area
  - app rendering area (for MCP Apps)
  - status indicators:
    - MCP server connection status
    - active tab
    - WebMCP availability + tool count for active tab
  - optional “Refresh WebMCP discovery” button

- User request example:
  - “Go to my Google mail”
  - Agent decides target URL and uses:
    - `tabs.create({ url, active: true })` or
    - `tabs.updateUrl({ tabId: activeTabId, url })`

No static rule-based intent mapping is implemented by the extension.

---

## 9) Acceptance Criteria
The extension is “done” when:
- User can chat with agent in side panel, persistent across tabs.
- Agent can:
  - list tabs
  - activate a tab
  - create a tab and/or update tab URL
- WebMCP discovery runs automatically when:
  - a new tab is opened
  - a tab navigates to a new page
  - a page finishes loading
- Discovery results are:
  - stored per tab
  - visible to agent via `webmcp.discover`
  - logged to developer console
- If WebMCP is available:
  - agent can invoke discovered tools
- Agent can call MCP tools; MCP Apps render and are interactive in side panel.

---

## 10) Sprint Plan
### Sprint 1: Skeleton + tab tools
- MV3 extension with side panel + options
- Implement `tabs.list`, `tabs.activate`, `tabs.create`, `tabs.updateUrl`
- LangGraph agent skeleton + tool wiring
- Logging scaffolding

### Sprint 2: WebMCP bridge + dynamic discovery
- Content script discovery + invoke
- SW listeners: onCreated/onUpdated/onActivated
- Per-tab registry + UI indicator
- Discovery logs in SW + side panel consoles

### Sprint 3: MCP client + MCP Apps rendering
- MCP transport (direct or bridge)
- Call MCP tools, display results
- Render MCP Apps in sandboxed iframe + event routing

### Sprint 4: Robustness + policy
- domain allowlist / permission UX
- debouncing + retries for discovery
- security hardening (origin checks, validation)


for the chat view & config please replicate the system in 
/home/ifdev/workspace/in-person-training-samples/src/features/radiology-copilot/radiology-copilot-view.ts


here is some materials
- webmcp : https://github.com/webmachinelearning/webmcp
- https://developer.chrome.com/blog/webmcp-epp?hl=fr
- mcp app : https://modelcontextprotocol.io/extensions/apps/overview

