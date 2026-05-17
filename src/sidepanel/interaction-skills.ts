import type { InteractionSkillEntry } from '../shared/types';
import {
  BROW_HTML_APP_THEME_MARKDOWN,
  BROW_HTML_APP_THEME_SKILL_DESCRIPTION,
  BROW_HTML_APP_THEME_SKILL_ID,
  BROW_HTML_APP_THEME_SKILL_NAME,
  BROW_HTML_APP_THEME_SKILL_SLUG,
} from '../shared/html-app-artifact-guidance';

const BUILT_AT = Date.UTC(2026, 4, 2);

const INTERACTION_SKILLS: ReadonlyArray<InteractionSkillEntry> = [
  {
    id: BROW_HTML_APP_THEME_SKILL_ID,
    name: BROW_HTML_APP_THEME_SKILL_NAME,
    slug: BROW_HTML_APP_THEME_SKILL_SLUG,
    description: BROW_HTML_APP_THEME_SKILL_DESCRIPTION,
    tags: ['interaction', 'html-app', 'artifacts', 'theme'],
    content: BROW_HTML_APP_THEME_MARKDOWN,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-iframes',
    name: 'Iframe Navigation',
    slug: 'iframe-navigation',
    description: 'Use Browser Snapshots and fresh refs when controls are nested in iframe boundaries.',
    tags: ['interaction', 'iframe', 'browser-snapshot'],
    content: `# Iframe Navigation

- Start with browser_snapshot so Brow can resolve Element Refs inside the currently visible frame tree.
- After a mutating action, take a fresh Browser Snapshot before trusting old refs again.
- Prefer WebMCP Page Tools over iframe automation when the page exposes one.
- Use browser_visual_query only when the success condition is visual or the frame boundary hides structural cues.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-shadow-dom',
    name: 'Shadow DOM Controls',
    slug: 'shadow-dom-controls',
    description: 'Treat Browser Snapshot refs as the stable action channel for controls hidden behind shadow roots.',
    tags: ['interaction', 'shadow-dom', 'browser-snapshot'],
    content: `# Shadow DOM Controls

- Prefer Browser Snapshot refs over handwritten selectors because shadow boundaries make selector reuse brittle.
- If a ref goes stale after expansion, take a fresh snapshot instead of guessing a nested selector.
- Store repeatable actions in Brow Action Memory with a stable intent, never with raw secrets.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-dialogs',
    name: 'Dialogs And Overlays',
    slug: 'dialogs-and-overlays',
    description: 'Use selective verification when transient overlays or modal state can hide the true task outcome.',
    tags: ['interaction', 'dialog', 'overlay', 'verification'],
    content: `# Dialogs And Overlays

- Add postconditions when dismissing a dialog so Brow can confirm the overlay is gone or the next state is visible.
- Prefer visual verification for ambiguous overlay state, animation-heavy menus, and destructive confirmation flows.
- If the page exposes a WebMCP Page Tool for the action, use that instead of clicking through the modal UI.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-uploads',
    name: 'Uploads And Pickers',
    slug: 'uploads-and-pickers',
    description: 'Treat uploads, file choosers, and native pickers as high-friction browser mechanics that need explicit handling.',
    tags: ['interaction', 'uploads', 'picker'],
    content: `# Uploads And Pickers

- Prefer semantic tools if the page exposes an upload-capable WebMCP Page Tool.
- When browser automation is required, target the actionable control from the latest Browser Snapshot and verify the selected file state structurally when possible.
- Use selective visual verification only when the UI does not expose an obvious structural postcondition.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-current-tab-app-adaptation',
    name: 'Current Tab App Adaptation',
    slug: 'current-tab-app-adaptation',
    description: 'When a user wants a new app inspired by the current tab, recover the current tab code or structure first, then adapt it.',
    tags: ['interaction', 'current-tab', 'app', 'adaptation'],
    content: `# Current Tab App Adaptation

- If the user wants a new app, prototype, or HTML artifact inspired by the current tab, start from the active tab context instead of recreating the UI from memory.
  - Recommended procedure:
  - Use tabs_getActive to make the current tab explicit before recovering code or assets.
  - Use tabs_getContent with format="html" to recover the page's HTML/source skeleton from the current tab.
  - Use browser_snapshot to recover the visible structure, interactive regions, labels, and layout semantics that raw HTML may not express clearly.
  - If the page links external stylesheets, scripts, or other reusable resources that the user is authorized to adapt, use http_fetch on those resource URLs to inspect the linked source.
- When the current tab is the user's app or code they are authorized to reuse, advise recovering the current tab's HTML/CSS/JS or component structure first, then adapt it to the new request.
  - Prefer reusing recovered CSS and TypeScript patterns, component structure, tokens, and layout logic when the user is authorized to reuse them, rather than rewriting the app from scratch.
  - When direct reuse is not appropriate, link back to the recovered resource URLs or cite them as reference material, then adapt the structure and behavior into new code.
- If direct source recovery is unavailable or the current tab is third-party, extract structure, layout, copy hierarchy, and interaction patterns from the tab, then build an adapted version instead of a verbatim clone.
- Reuse only code and assets the user is authorized to adapt. Do not copy proprietary third-party code, branding, or assets verbatim without permission.
- After recovering the relevant structure, prefer html_artifact_upsert when an interactive artifact is the best deliverable.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
  {
    id: 'interaction-tabs-and-windows',
    name: 'Tabs And Windows',
    slug: 'tabs-and-windows',
    description: 'Keep cross-tab work explicit: activate the right tab, then refresh Browser Snapshot context before acting.',
    tags: ['interaction', 'tabs', 'windows'],
    content: `# Tabs And Windows

- Use tabs_getActive, tabs_list, and tabs_activate to make tab context explicit before mutating page state.
- After tab activation or navigation, take a fresh Browser Snapshot before relying on prior Element Refs.
- Prefer page-local WebMCP tools when a tab exposes them; do not assume tools discovered on one tab apply to another.`,
    createdAt: BUILT_AT,
    updatedAt: BUILT_AT,
  },
];

export function getInteractionSkillRegistry(): InteractionSkillEntry[] {
  return INTERACTION_SKILLS.map((skill) => ({
    ...skill,
    tags: [...skill.tags],
  }));
}
