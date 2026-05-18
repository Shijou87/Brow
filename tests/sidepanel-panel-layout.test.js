const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('tools and conversations panels keep the bordered inner shell as the scroll container host', () => {
  const sharedPanelStyles = read('src/sidepanel/styles/_config-skills-mcpapp.scss');
  const panelStyles = read('src/sidepanel/styles/_panels.scss');

  assert.match(
    sharedPanelStyles,
    /\.config-panel-inner,\s*\.tools-panel-inner,\s*\.mcp-panel-inner,\s*\.conversations-panel-inner\s*\{[\s\S]*?min-height:\s*0;/,
    'shared inner panels should not force a 100% minimum height',
  );

  assert.match(
    panelStyles,
    /\.tools-panel,\s*\.mcp-panel,\s*\.conversations-panel\s*\{[\s\S]*?overflow:\s*hidden;/,
    'body panels should clip to their visible surface instead of scrolling the outer shell',
  );

  assert.match(
    panelStyles,
    /\.tools-panel-inner,\s*\.mcp-panel-inner,\s*\.conversations-panel-inner\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/,
    'inner panel shells should stretch to the available height without overflowing it',
  );

  assert.match(
    panelStyles,
    /\.tools-groups-container,\s*\.conversations-list-container\s*\{[\s\S]*?flex:\s*1;[\s\S]*?overflow-y:\s*auto;/,
    'tools and conversations lists should scroll inside the bordered shell',
  );
});
