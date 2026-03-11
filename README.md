# Agent WebMCP

Chrome extension (Manifest V3) that runs a **LangGraph.js React agent** in the browser side-panel with support for:

- **MCP Servers** – connect to remote MCP (Model Context Protocol) HTTP servers, discover their tools, and invoke them from the agent
- **WebMCP** – dynamically discover tools exposed by the active tab via the WebMCP page-level protocol
- **Tab Tools** – built-in browser automation tools (click, type, navigate, screenshot, …)
- **Configurable LLM** – switch between OpenAI-compatible endpoints from the options page

## Architecture

```
┌──────────────┐     ┌───────────────┐     ┌────────────────┐
│  Side Panel  │◄───►│  Background   │◄───►│ Content Script │
│  (agent UI)  │     │  (service wkr)│     │  (page bridge) │
└──────────────┘     └───────────────┘     └────────────────┘
       │                                          │
       ▼                                          ▼
  LangGraph.js                              WebMCP discovery
  React Agent                               on active tab
       │
       ├─► Built-in tab tools
       ├─► WebMCP page tools
       └─► MCP server tools (HTTP / SSE)
```

| Directory | Purpose |
|---|---|
| `src/sidepanel/` | Agent, chat UI, MCP client, tool factories |
| `src/background/` | Service worker – side-panel lifecycle, tab messaging |
| `src/content-script/` | Content script + page bridge for WebMCP discovery |
| `src/options/` | Options page for LLM configuration |
| `src/shared/` | Shared types and logger |
| `test-page/` | Local HTML page that exposes sample WebMCP tools |

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

## Getting Started

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build

# Clean build output
npm run clean
```

## Loading the Extension

1. Run `npm run build` (or `npm run dev` for watch mode).
2. Open **chrome://extensions** in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/` folder.
5. Click the extension icon to open the side panel.

## Configuration

Open the extension **Options** page (right-click extension icon → *Options*) to configure:

- **LLM endpoint** – base URL, API key, model name
- **Tool toggles** – enable / disable individual tools

MCP servers can be added directly from the side panel via the server management button (stack icon next to the tools wrench).

## MCP Server Support

The extension supports connecting to remote [MCP](https://modelcontextprotocol.io) servers over HTTP (Streamable HTTP / SSE transport).

1. Click the **server stack icon** in the side-panel header.
2. Enter a name, URL and optional auth token.
3. Click **Connect** – the server's tools are discovered and added to the agent automatically.
4. Connected servers and their tools persist across sessions via `chrome.storage.local`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Webpack watch build (development) |
| `npm run build` | Webpack production build → `dist/` |
| `npm run clean` | Remove `dist/` |

## Tech Stack

- TypeScript 5
- Webpack 5
- LangGraph.js / LangChain
- MCP SDK (`@modelcontextprotocol/sdk`)
- SCSS
- Chrome Extensions Manifest V3
