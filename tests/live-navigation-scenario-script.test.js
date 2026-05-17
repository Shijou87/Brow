const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function runScenarioScript(args) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-navigation-test-'));
  const stdoutPath = path.join(tempDir, 'stdout.txt');
  const stderrPath = path.join(tempDir, 'stderr.txt');
  const result = spawnSync(
    'bash',
    ['-c', [
      shellEscape(process.execPath),
      ...args.map(shellEscape),
      `>${shellEscape(stdoutPath)}`,
      `2>${shellEscape(stderrPath)}`,
    ].join(' ')],
    {
      cwd: path.resolve(__dirname, '..'),
    },
  );
  return {
    ...result,
    stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '',
    stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '',
  };
}

test('live navigation scenario runner lists the phased first-slice scenarios', () => {
  const result = runScenarioScript(['scripts/run-live-navigation-scenario.mjs', '--list']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /live-google-flights-round-trip/);
  assert.match(result.stdout, /live-youtube-watch-playback/);
  assert.match(result.stdout, /live-general-search-docs-result/);
  assert.match(result.stdout, /live-saucedemo-login/);
  assert.match(result.stdout, /runMode: manual/);
  assert.match(result.stdout, /complexReplay: sample\/live-scenarios\/google-flights-history-replay\.json/);
});

test('live navigation scenario runner can assemble a complex replay bundle without hitting the network', () => {
  const result = runScenarioScript([
    'scripts/run-live-navigation-scenario.mjs',
    'live-google-flights-round-trip',
    '--complex',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scenario, 'live-google-flights-round-trip');
  assert.equal(payload.dryRun, true);
  assert.match(payload.replayFile, /google-flights-history-replay\.json$/);
  assert.deepEqual(
    payload.toolNames.slice(0, 5),
    [
      'browser_snapshot',
      'browser_form_snapshot',
      'browser_click',
      'browser_type',
      'browser_key',
    ],
  );
  assert.equal(payload.request.messages[0].role, 'system');
  assert.equal(payload.request.messages.some((message) => message.role === 'tool'), true);
  assert.equal(payload.request.messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)), true);
  assert.deepEqual(
    payload.request.tools.map((tool) => tool.function.name),
    payload.toolNames,
  );
});

test('live navigation scenario runner can assemble the SauceDemo login benchmark without a replay bundle', () => {
  const result = runScenarioScript([
    'scripts/run-live-navigation-scenario.mjs',
    'live-saucedemo-login',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scenario, 'live-saucedemo-login');
  assert.equal(payload.dryRun, true);
  assert.equal(payload.replayFile, null);
  assert.equal(payload.toolNames.includes('browser_fill_form'), true);
  assert.equal(payload.toolNames.includes('create_tab'), true);
  assert.equal(payload.request.messages.at(-1).role, 'user');
  assert.match(payload.request.messages.at(-1).content, /saucedemo\.com/i);
});
