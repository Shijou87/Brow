// ─── Options Page ───────────────────────────────────────────────────────────
// MCP config, feature flags, and debug logging settings.

import './options-style.scss';

import type { ExtensionSettings } from '../shared/types';
import { loadExtensionSettings, saveExtensionSettings } from '../shared/storage';

// ─── Build UI ──────────────────────────────────────────────────────────────

const app = document.getElementById('options-app')!;
app.innerHTML = `
  <div class="options-shell">
    <header class="options-hero">
      <div class="options-hero-copy">
        <p class="options-kicker">Chrome Extension Control Surface</p>
        <h1>Agent WebMCP Settings</h1>
        <p class="options-summary">Apply the same dark neon theme to the extension configuration surface while keeping the existing MCP and feature controls intact.</p>
      </div>
      <div class="options-hero-badge">Runtime Config</div>
    </header>

    <section class="options-section">
      <div class="section-heading">
        <h2>MCP Server</h2>
        <p>Point the extension at a remote MCP endpoint and choose the transport the agent should use.</p>
      </div>
      <div class="option-field">
        <label for="mcp-endpoint">Endpoint</label>
        <input type="text" id="mcp-endpoint" placeholder="http://localhost:3000/mcp" />
      </div>
      <div class="option-field">
        <label for="mcp-transport">Transport</label>
        <select id="mcp-transport">
          <option value="sse">SSE</option>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="http">HTTP</option>
        </select>
      </div>
      <div class="option-field">
        <label for="mcp-auth">Auth Token (optional)</label>
        <input type="password" id="mcp-auth" placeholder="Bearer token" />
      </div>
    </section>

    <section class="options-section">
      <div class="section-heading">
        <h2>Feature Flags</h2>
        <p>Toggle runtime capabilities for discovery, embedded MCP apps, and debugging.</p>
      </div>
      <div class="option-toggle">
        <label>
          <input type="checkbox" id="enable-webmcp" checked />
          <span>Enable WebMCP (per-tab tool discovery)</span>
        </label>
      </div>
      <div class="option-toggle">
        <label>
          <input type="checkbox" id="enable-mcp-apps" checked />
          <span>Enable MCP Apps rendering</span>
        </label>
      </div>
      <div class="option-toggle">
        <label>
          <input type="checkbox" id="debug-logging" checked />
          <span>Debug logging (WebMCP discovery)</span>
        </label>
      </div>
    </section>

    <div class="options-actions">
      <button id="save-btn" class="primary-btn">Save Settings</button>
      <span id="save-status" class="save-status"></span>
    </div>
  </div>
`;

// ─── Load settings ─────────────────────────────────────────────────────────

async function loadSettings(): Promise<void> {
  const settings = await loadExtensionSettings();

  const setVal = (id: string, v: string) => {
    const el = document.getElementById(id) as HTMLInputElement;
    if (el) el.value = v;
  };
  const setChecked = (id: string, v: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement;
    if (el) el.checked = v;
  };

  setVal('mcp-endpoint', settings.mcp?.endpoint ?? '');
  setVal('mcp-transport', settings.mcp?.transport ?? 'sse');
  setVal('mcp-auth', settings.mcp?.authToken ?? '');
  setChecked('enable-webmcp', settings.enableWebMCP ?? true);
  setChecked('enable-mcp-apps', settings.enableMCPApps ?? true);
  setChecked('debug-logging', settings.debugLogging ?? false);
}

// ─── Save settings ─────────────────────────────────────────────────────────

async function saveSettings(): Promise<void> {
  const getVal = (id: string): string => {
    const el = document.getElementById(id) as HTMLInputElement;
    return el?.value?.trim() ?? '';
  };
  const getChecked = (id: string): boolean => {
    const el = document.getElementById(id) as HTMLInputElement;
    return el?.checked ?? false;
  };

  const settings: Partial<ExtensionSettings> = {
    mcp: {
      endpoint: getVal('mcp-endpoint'),
      transport: getVal('mcp-transport') as 'http' | 'sse' | 'streamable-http',
      authToken: getVal('mcp-auth') || undefined,
    },
    enableWebMCP: getChecked('enable-webmcp'),
    enableMCPApps: getChecked('enable-mcp-apps'),
    debugLogging: getChecked('debug-logging'),
  };

  await saveExtensionSettings(settings);

  const status = document.getElementById('save-status')!;
  status.textContent = 'Saved!';
  status.className = 'save-status save-success';
  setTimeout(() => { status.textContent = ''; status.className = 'save-status'; }, 2000);
}

// ─── Wire events ───────────────────────────────────────────────────────────

document.getElementById('save-btn')?.addEventListener('click', saveSettings);
loadSettings();
