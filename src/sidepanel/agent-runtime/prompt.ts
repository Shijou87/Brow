import type { MCPToolDescriptor } from '../mcp-client';
import type { SkillRegistryEntry } from '../skills-registry';
import type { WebMCPToolDescriptor } from '../../shared/types';

interface WebMCPPromptEntry {
  descriptors: WebMCPToolDescriptor[];
  url?: string;
  title?: string;
}

interface MCPPromptEntry {
  id: string;
  name: string;
  url: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools: MCPToolDescriptor[];
}

export function buildSystemPrompt(params: {
  basePrompt: string;
  skillRegistry: SkillRegistryEntry[];
  disabledTools: Set<string>;
  webmcpByTab: Map<number, WebMCPPromptEntry>;
  mcpServers: Iterable<MCPPromptEntry>;
}): string {
  const {
    basePrompt,
    skillRegistry,
    disabledTools,
    webmcpByTab,
    mcpServers,
  } = params;

  let prompt = basePrompt;

  prompt += '\n\n**Browser automation guidance:**';
  prompt += '\n- Prefer WebMCP page tools when a relevant one is available; they are the semantic page API.';
  prompt += '\n- Otherwise prefer Playwright MCP-style browser refs: use browser_snapshot, then browser_click/browser_type/browser_hover/browser_fill_form with the returned `ref` values.';
  prompt += '\n- Refs are valid for the snapshot they came from. If a ref is stale, the browser tools will safely rematch only when there is exactly one confident target; otherwise take a fresh browser_snapshot.';
  prompt += '\n- When an action is likely to repeat, pass a short stable `intent` to browser_click/browser_type/browser_hover/browser_fill_form so Brow Action Memory can replay it later. Keep secrets and dynamic values out of `intent`; put values only in tool value fields.';
  prompt += '\n- For important actions, include simple `postconditions` such as textVisible, urlIncludes, or elementVisible so Brow can detect when an action technically ran but did not complete the task.';
  prompt += '\n- browser_visual_query is perception-only. Use it to extract visual information from a ref or viewport rect, then verify actions against browser_snapshot refs.';
  prompt += '\n- Selector-based tabs_* tools remain fallback compatibility tools. If you must use them, prefer selectors returned by tabs_listInteractiveElements or simple locators like `heading="Daily Summary"`, `text="Security"`, `title="Settings"`, or `placeholder="Search"`.';

  const activeSkills = skillRegistry.filter((skill) => skill.enabled);
  if (activeSkills.length > 0) {
    prompt += '\n\n**Active reusable skills:**';
    prompt += disabledTools.has('skills_load')
      ? '\nThese are user-configured SKILL.md-style helpers currently summarized at a high level.'
      : '\nThese are user-configured SKILL.md-style helpers. If one seems relevant, call skills_load with its slug or name to inspect the full details before relying on it.';
    for (const skill of activeSkills) {
      const tags = skill.tags.length > 0 ? ` — tags: ${skill.tags.join(', ')}` : '';
      const description = skill.description || 'No description provided.';
      prompt += `\n- ${skill.name} (slug: ${skill.slug}) — ${description}${tags}`;
    }
  }

  if (webmcpByTab.size > 0) {
    prompt += '\n\n**Available WebMCP page tools (across all tabs):**';
    prompt += '\nThese are tools exposed by web pages. Call them directly by their full name (webmcp_t{tabId}_{toolName}).';

    for (const [tabId, entry] of webmcpByTab.entries()) {
      const label = entry.title || entry.url || `tab ${tabId}`;
      prompt += `\n\n_Tab ${tabId} — ${label}:_`;
      for (const descriptor of entry.descriptors) {
        const toolName = `webmcp_t${tabId}_${descriptor.name}`;
        if (disabledTools.has(toolName)) continue;
        const schema = descriptor.inputSchema
          ? ` — args: ${JSON.stringify(descriptor.inputSchema.properties ?? {})}`
          : ' — no arguments';
        prompt += `\n- ${toolName}: ${descriptor.description}${schema}`;
      }
    }

    prompt += '\n\nPrefer using these page tools directly instead of webmcp_invoke when the tool is listed above.';
  }

  const connectedServers = [...mcpServers].filter((server) => server.status === 'connected');
  if (connectedServers.length > 0) {
    prompt += '\n\n**Available MCP server tools (remote HTTP servers):**';
    prompt += '\nThese are tools provided by remote MCP servers. Call them directly by their full name (mcp_{serverId}_{toolName}).';

    for (const server of connectedServers) {
      const safeId = server.id.replace(/[^a-zA-Z0-9]/g, '');
      prompt += `\n\n_MCP Server: ${server.name} (${server.url}):_`;
      for (const tool of server.tools) {
        const toolName = `mcp_${safeId}_${tool.name}`;
        if (disabledTools.has(toolName)) continue;
        const schema = tool.inputSchema
          ? ` — args: ${JSON.stringify((tool.inputSchema as any).properties ?? {})}`
          : ' — no arguments';
        prompt += `\n- ${toolName}: ${tool.description}${schema}`;
      }
    }
  }

  return prompt;
}
