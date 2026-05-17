# Brow Maintainer Architecture Guide

This guide explains how Brow is wired today for contributors who need to trace behavior through the codebase.

Use this document together with:

- [README](../README.md) for setup and top-level project framing,
- [Extension Feature Guide](./extension-features.md) for implementation-backed product features,
- [CONTEXT](../CONTEXT.md) for Brow's canonical domain language,
- and the ADRs in [docs/adr](./adr/) for design history behind major decisions.

## 1. Runtime At A Glance

Brow is a Manifest V3 extension split across three active runtimes plus shared contracts:

| Runtime | Main file | Owns |
|---|---|---|
| Side panel | [src/sidepanel/sidepanel-controller.ts](../src/sidepanel/sidepanel-controller.ts) | UI coordination, chat state, request-budget refresh, tool and server state, approval flow, workflow staging |
| Agent runtime | [src/sidepanel/agent.ts](../src/sidepanel/agent.ts) | LangGraph agent construction, streaming, tool manifest assembly, MCP/WebMCP wrapping, request execution |
| Background service worker | [src/background/index.ts](../src/background/index.ts) | Tab lifecycle observation, WebMCP discovery scheduling, message relay between side panel and tabs |
| Content script | [src/content-script/browser-snapshot-engine.ts](../src/content-script/browser-snapshot-engine.ts) and [src/content-script/workflow-demonstration-recorder.ts](../src/content-script/workflow-demonstration-recorder.ts) | Live DOM inspection, Browser Snapshot execution, workflow demonstration capture, page bridge integration |
| Shared contracts | [src/shared/types.ts](../src/shared/types.ts) and [src/shared/storage.ts](../src/shared/storage.ts) | Cross-runtime types, storage keys, normalization, persisted settings/state |

The side panel is the product surface, but most user-visible behavior is the result of coordination across all four layers.

## 2. End-To-End Request Flow

The main user turn path looks like this:

1. `SidepanelController` receives a send action from `ChatView`, keeps the visible transcript in sync, and asks the agent for a request-budget estimate.
2. `Agent` uses `createRequestBudgetRuntime()` from [src/sidepanel/agent-runtime/request-budget-runtime.ts](../src/sidepanel/agent-runtime/request-budget-runtime.ts) to assemble the request context: system prompt, selected skill mention, matched Domain Skills, matched Domain Memory, Browser Snapshot context, workflow demonstrations, and conversation history.
3. If the estimated request is too large, the same runtime compacts older conversation turns into a durable summary before the next model call.
4. `Agent` builds its tool set by combining `createBuiltinTools()`, `createWebMCPTools()`, and `createMCPServerTools()`.
5. The LangGraph agent streams assistant output and tool steps back to `SidepanelController`, which updates the chat transcript, tool timeline, and request-budget indicators in real time.
6. Tool calls that need browser state cross the extension boundary through the background worker. The background worker ensures the page bridge is ready, then relays messages into the target tab.
7. Content-script modules inspect or mutate the live page, return structured results, and the side panel stores updated conversation state in local extension storage.

When debugging a wrong answer, start in the side panel or request-budget runtime. When debugging a wrong browser action, start at the built-in tool factory or Browser Snapshot engine.

## 3. Side Panel Ownership

[src/sidepanel/sidepanel-controller.ts](../src/sidepanel/sidepanel-controller.ts) is the main coordinator for the visible product state.

Important responsibilities:

- bind `ChatView` callbacks to runtime actions,
- restore persisted configuration, tool toggles, MCP servers, and HTML app preferences,
- keep request-budget estimates and debug exports current,
- manage the live chat history used by the agent,
- route workflow recording actions to the active tab,
- and host approval-gated MCP App and HTML App rendering.

The controller should stay orchestration-heavy and policy-light. When behavior becomes reusable or stateful outside the view lifecycle, it usually belongs in a dedicated runtime helper rather than inside the controller.

## 4. Agent Assembly And Request Budgeting

[src/sidepanel/agent.ts](../src/sidepanel/agent.ts) owns the model-facing runtime.

Key entry points:

- `Agent` implements the main execution lifecycle.
- `getOrCreateAgent()` exposes the singleton agent instance used by the side panel.
- `configureAndRebuild()` updates provider settings and rebuilds the agent/tool runtime.

The agent is responsible for:

- loading or reconfiguring the LLM,
- assembling built-in tools, WebMCP page tools, and remote MCP server tools,
- streaming LangGraph output,
- surfacing structured tool-step events,
- handling approval-gated automation,
- and emitting render requests for MCP Apps and Brow-authored HTML App Artifacts.

Request sizing and conversation compaction are intentionally delegated to [src/sidepanel/agent-runtime/request-budget-runtime.ts](../src/sidepanel/agent-runtime/request-budget-runtime.ts), not inlined into `Agent`.

That runtime has three core jobs:

- `assembleQueryContext()` builds the actual model-facing context.
- `estimateRequestBudget()` estimates how much of the configured context window the next turn will consume.
- `compactConversationIfNeeded()` summarizes older history when the request would otherwise exceed the configured budget.

If you are changing prompt assembly, add the behavior in the request-budget or prompt helper layers first and keep `Agent` focused on runtime coordination.

## 5. Tooling Layers

### 5.1 Built-In Tools

[src/sidepanel/agent-tools/builtin-tools.ts](../src/sidepanel/agent-tools/builtin-tools.ts) is the main agent-visible tool factory.

`createBuiltinTools()` defines the built-in tool inventory exposed to the model. These tools are schema-backed and mostly delegate their real work to tab-tool helpers, domain-memory helpers, or HTML artifact handlers.

This file is the best place to answer:

- what tools the agent can currently call,
- what arguments the model sees,
- which tool names are stable public surface area,
- and which built-in tools attach fresh Browser Snapshot context after mutation.

### 5.2 WebMCP Page Tools

[src/sidepanel/webmcp-tool-factory.ts](../src/sidepanel/webmcp-tool-factory.ts) wraps per-tab page tools discovered through WebMCP.

Important behavior in this layer:

- tool names are tab-scoped,
- mutating tools can trigger heuristic aftermath capture,
- and page-local semantics can be preferred over DOM automation when both exist.

If a page tool result looks stale after execution, this is one of the first places to inspect.

### 5.3 Remote MCP Server Tools

[src/sidepanel/mcp-client.ts](../src/sidepanel/mcp-client.ts) handles remote MCP connectivity, tool discovery, resource reads, and app-backed tool metadata.

Important exported surfaces include:

- `mcpConnect()` for server initialization and tool discovery,
- `mcpCallTool()` for tool execution,
- `mcpReadResource()` and `mcpListResources()` for MCP resources,
- and `createMCPServerTools()` for wrapping server tools into the agent runtime.

This module also centralizes visibility rules such as model-visible versus app-visible tool metadata.

## 6. Browser Execution Path

The Browser Snapshot execution path is the core Brow automation layer.

[src/content-script/browser-snapshot-engine.ts](../src/content-script/browser-snapshot-engine.ts) is responsible for:

- generating `BrowserSnapshot` structures from the live DOM,
- generating `BrowserFormSnapshot` structures with field-purpose inference and safe-value handling,
- maintaining the per-tab ref registry used for ref-based execution,
- and executing `BrowserSnapshotOperation` requests through `runBrowserSnapshotOperation()`.

The important mental model is:

- the side panel and agent reason about refs and structured snapshots,
- the content script resolves those refs against the current DOM,
- and mutating operations are expected to reacquire fresh context rather than trusting stale refs.

If a change affects click fidelity, form semantics, hidden-field behavior, or ref freshness, start here and in the surrounding tab-tool helpers.

## 7. Background And Page Bridge Coordination

[src/background/index.ts](../src/background/index.ts) is the extension's routing hub.

It watches tab lifecycle events and handles runtime messages for:

- registry reads,
- forced or bulk WebMCP discovery,
- WebMCP tool invocation,
- Browser Snapshot operations,
- and workflow recording start/stop/status requests.

The background worker does not own DOM semantics. Its job is to ensure the right bridge scripts are present, route the message to the right tab, and return structured results to the side panel.

For page-local discovery itself, the content-script bridge in [src/content-script/page-bridge-runtime.ts](../src/content-script/page-bridge-runtime.ts) talks directly to `navigator.modelContext` and returns WebMCP tool descriptors/results.

## 8. Workflow Demonstrations

Workflow Demonstrations span content-script capture and shared artifact shaping.

[src/content-script/workflow-demonstration-recorder.ts](../src/content-script/workflow-demonstration-recorder.ts) owns the live page capture boundary:

- listen to DOM events,
- recover target evidence,
- capture pointer or keyboard evidence,
- and normalize values before they enter the shared workflow artifact pipeline.

The shared shaping logic lives under [src/shared/workflow-demonstration](../src/shared/workflow-demonstration/), especially:

- `step-builder.ts` for structured step creation,
- `context-format.ts` for prompt-facing formatting,
- `normalization.ts` for storage/runtime normalization,
- and `value-capture.ts` for safe value capture behavior.

If a recorded workflow replays with the wrong target or stores the wrong evidence, inspect the recorder first and the shared workflow pipeline second.

## 9. Storage And Persistence Boundaries

[src/shared/storage.ts](../src/shared/storage.ts) is the shared entry point for persisted configuration and durable extension state.

It centralizes:

- storage keys,
- normalization of provider and sidepanel config,
- load/save helpers for extension settings,
- disabled tool state,
- and HTML App execution preferences.

Other features build on top of this storage layer, but the shared module is where cross-runtime normalization rules should live.

State you will commonly trace here includes conversations, MCP server definitions, Domain Memory, Domain Skill proposals, and Brow Action Memory.

## 10. Shared Contracts To Learn Early

The most useful shared types for new contributors live in [src/shared/types.ts](../src/shared/types.ts):

- `BrowserSnapshot` and `BrowserSnapshotElement`
- `BrowserFormSnapshot` and related field-purpose/value contracts
- `BrowserSnapshotOperation`
- `WorkflowDemonstration` and its evidence types
- `DomainMemoryEntry`
- `InteractionSkillEntry`

If you keep the wording in your code and docs aligned with these contracts and with [CONTEXT](../CONTEXT.md), the rest of the repository becomes much easier to navigate.

## 11. Good Entry Points For Common Changes

Use this routing shortcut when starting work:

| Change you want | Start here |
|---|---|
| Chat flow, request budget, approvals, transcript state | [src/sidepanel/sidepanel-controller.ts](../src/sidepanel/sidepanel-controller.ts) and [src/sidepanel/agent.ts](../src/sidepanel/agent.ts) |
| Prompt assembly or conversation compaction | [src/sidepanel/agent-runtime/request-budget-runtime.ts](../src/sidepanel/agent-runtime/request-budget-runtime.ts) |
| Built-in tool arguments or behavior | [src/sidepanel/agent-tools/builtin-tools.ts](../src/sidepanel/agent-tools/builtin-tools.ts) |
| WebMCP discovery or invocation | [src/background/index.ts](../src/background/index.ts), [src/content-script/page-bridge-runtime.ts](../src/content-script/page-bridge-runtime.ts), and [src/sidepanel/webmcp-tool-factory.ts](../src/sidepanel/webmcp-tool-factory.ts) |
| Browser Snapshot capture or ref-based execution | [src/content-script/browser-snapshot-engine.ts](../src/content-script/browser-snapshot-engine.ts) |
| Workflow recording and replay evidence | [src/content-script/workflow-demonstration-recorder.ts](../src/content-script/workflow-demonstration-recorder.ts) and [src/shared/workflow-demonstration](../src/shared/workflow-demonstration/) |
| Remote MCP servers or MCP Apps | [src/sidepanel/mcp-client.ts](../src/sidepanel/mcp-client.ts) and [src/sidepanel/mcp-app-host.ts](../src/sidepanel/mcp-app-host.ts) |
| Persistence or normalization bugs | [src/shared/storage.ts](../src/shared/storage.ts) and [src/shared/types.ts](../src/shared/types.ts) |

## 12. Documentation Boundaries

This guide is intentionally maintainer-oriented.

- It explains where behavior lives and how it crosses runtime boundaries.
- It does not replace the feature inventory in [Extension Feature Guide](./extension-features.md).
- It does not replace the canonical product vocabulary in [CONTEXT](../CONTEXT.md).
- It does not try to restate every ADR.

When updating docs, keep those three layers distinct: feature inventory, maintainer architecture, and domain language.