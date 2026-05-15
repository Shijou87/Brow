const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('agent delegates request budget assembly and compaction to RequestBudgetRuntime', () => {
  const agentSource = read('src/sidepanel/agent.ts');
  const runtimeSource = read('src/sidepanel/agent-runtime/request-budget-runtime.ts');

  assert.match(agentSource, /import\s+\{\s*[\s\S]*buildRequestContextDebugSnapshot[\s\S]*createRequestBudgetRuntime[\s\S]*\}\s+from\s+'\.\/agent-runtime\/request-budget-runtime';/);
  assert.match(agentSource, /private readonly requestBudgetRuntime: ReturnType<typeof createRequestBudgetRuntime>;/);
  assert.match(agentSource, /this\.requestBudgetRuntime = createRequestBudgetRuntime\(/);
  assert.match(agentSource, /await this\.requestBudgetRuntime\.compactConversationIfNeeded\(/);
  assert.match(agentSource, /await this\.requestBudgetRuntime\.assembleQueryContext\(/);
  assert.match(agentSource, /return await this\.requestBudgetRuntime\.estimateRequestBudget\(/);

  for (const delegatedHelper of [
    'getEffectiveConversationCompactionState',
    'buildCompactionSummaryMessage',
    'buildEffectiveHistoryMessages',
    'estimateProjectedSummaryTokens',
    'getNextCompactionTargetTurnCount',
    'compactConversationIfNeeded',
    'assembleQueryContext',
  ]) {
    assert.equal(
      new RegExp(`(?:private|public|async|function)\\s+${delegatedHelper}\\s*\\(`).test(agentSource),
      false,
      `agent.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(runtimeSource, /export function createRequestBudgetRuntime/);
  assert.match(runtimeSource, /async function assembleQueryContext\(/);
  assert.match(runtimeSource, /async function estimateRequestBudget\(/);
  assert.match(runtimeSource, /async function compactConversationIfNeeded\(/);
  assert.match(runtimeSource, /export function buildRequestContextDebugSnapshot/);
});
