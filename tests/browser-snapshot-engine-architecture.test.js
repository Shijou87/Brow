const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('browser-snapshot-engine delegates ref and target resolution to BrowserSnapshotResolutionRuntime', () => {
  const engineSource = read('src/content-script/browser-snapshot-engine.ts');
  const resolutionSource = read('src/content-script/browser-snapshot-resolution.ts');

  assert.match(engineSource, /import\s+\{\s*createBrowserSnapshotResolutionRuntime\s*\}\s+from\s+'\.\/browser-snapshot-resolution';/);
  assert.match(engineSource, /const\s+\{\s*[\s\S]*resolveMemory[\s\S]*resolveTarget[\s\S]*resolveRef[\s\S]*\}\s*=\s*createBrowserSnapshotResolutionRuntime\(/);

  for (const delegatedHelper of [
    'resolveMemory',
    'resolveTarget',
    'resolveRef',
    'scoreRecoveryCandidate',
    'scoreTargetEvidenceCandidate',
    'recoverRef',
  ]) {
    assert.equal(
      engineSource.includes(`function ${delegatedHelper}(`),
      false,
      `browser-snapshot-engine.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(resolutionSource, /export function createBrowserSnapshotResolutionRuntime/);
  assert.match(resolutionSource, /function resolveMemory\(/);
  assert.match(resolutionSource, /function resolveTarget\(/);
  assert.match(resolutionSource, /function resolveRef\(/);
});
