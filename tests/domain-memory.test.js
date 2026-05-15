const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const outDir = path.join(repoRoot, '.tmp-domain-memory-test');
const tscBin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

execFileSync(tscBin, [
  'src/sidepanel/domain-memory.ts',
  '--outDir',
  outDir,
  '--module',
  'commonjs',
  '--target',
  'es2020',
  '--moduleResolution',
  'node',
  '--skipLibCheck',
  '--esModuleInterop',
], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const {
  buildDomainMemoryIndexContext,
  deleteDomainMemoryEntry,
  hasDisallowedDomainMemoryContent,
  loadDomainMemoryEntries,
  normalizeDomainMemoryRegistry,
  queryDomainMemoryEntries,
  saveDomainMemoryDraft,
  setDomainMemoryEnabled,
  upsertDomainMemoryEntries,
} = require('../.tmp-domain-memory-test/sidepanel/domain-memory.js');

function installMockChromeStorage() {
  const data = {};
  global.chrome = {
    storage: {
      local: {
        get(key, callback) {
          if (Array.isArray(key)) {
            callback(Object.fromEntries(key.map((item) => [item, data[item]])));
            return;
          }
          callback({ [key]: data[key] });
        },
        set(values, callback) {
          Object.assign(data, values);
          callback?.();
        },
      },
    },
  };
  return data;
}

test('normalizes Domain Memory entries and clamps confidence', () => {
  const entries = normalizeDomainMemoryRegistry([
    {
      id: 'm1',
      title: 'Search submit control',
      lesson: 'Use the real submit button instead of clicking the textbox.',
      matcher: { domain: 'Example.COM', pathPatterns: ['/search/*'] },
      tags: 'search, form',
      evidence: ['fixed failed textbox click'],
      confidence: 2,
      enabled: true,
      createdAt: 10,
      updatedAt: 20,
    },
    { title: '', lesson: 'invalid' },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher.domain, 'example.com');
  assert.deepEqual(entries[0].tags, ['search', 'form']);
  assert.equal(entries[0].confidence, 1);
});

test('merges overlapping memories and demotes confidence after failure', () => {
  const first = upsertDomainMemoryEntries([], {
    title: 'Search submit control',
    lesson: 'Click the submit button, not the search textbox.',
    matcher: { domain: 'example.com', pathPatterns: ['/search/*'] },
    evidence: ['postcondition passed after submit click'],
    confidence: 0.7,
    outcome: 'success',
  }, 100);

  assert.equal(first.merged, false);
  assert.equal(first.entry.successCount, 1);
  assert.equal(first.entry.useCount, 1);
  assert.ok(first.entry.confidence > 0.7);

  const second = upsertDomainMemoryEntries(first.entries, {
    title: 'Search submit control',
    lesson: 'Click the submit button, not the search textbox.',
    matcher: { domain: 'example.com', pathPatterns: ['/search/*'] },
    evidence: ['postcondition timed out on redesigned page'],
    outcome: 'failure',
  }, 200);

  assert.equal(second.merged, true);
  assert.equal(second.entries.length, 1);
  assert.equal(second.entry.failureCount, 1);
  assert.equal(second.entry.useCount, 2);
  assert.ok(second.entry.confidence < first.entry.confidence);
  assert.deepEqual(second.entry.evidence, [
    'postcondition passed after submit click',
    'postcondition timed out on redesigned page',
  ]);
});

test('rejects secret-ish Domain Memory content', () => {
  assert.equal(hasDisallowedDomainMemoryContent(['Use Authorization: Bearer abcdefghijklmnop']), true);
  assert.throws(() => upsertDomainMemoryEntries([], {
    title: 'Do not save auth',
    lesson: 'Use Authorization: Bearer abcdefghijklmnop',
    matcher: { domain: 'example.com' },
  }), /must not store secrets/i);
});

test('queries by domain and text while respecting disabled entries', () => {
  const base = normalizeDomainMemoryRegistry([
    {
      id: 'enabled',
      title: 'Pull request files tab',
      lesson: 'Use the Files changed tab for review comments.',
      matcher: { domain: 'github.com', pathPatterns: ['/*/*/pull/*'] },
      tags: ['github', 'review'],
      confidence: 0.8,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'disabled',
      title: 'Old pull request layout',
      lesson: 'Obsolete layout note.',
      matcher: { domain: 'github.com' },
      confidence: 0.2,
      enabled: false,
      createdAt: 1,
      updatedAt: 3,
    },
  ]);

  assert.deepEqual(queryDomainMemoryEntries(base, { domain: 'github.com', query: 'files' }).map((entry) => entry.id), ['enabled']);
  assert.deepEqual(queryDomainMemoryEntries(base, { domain: 'github.com', includeDisabled: true }).map((entry) => entry.id), ['enabled', 'disabled']);
  assert.deepEqual(queryDomainMemoryEntries(base, { id: 'disabled', includeDisabled: true }).map((entry) => entry.id), ['disabled']);
});

test('matched Domain Memory index is compact and does not inject full lessons', () => {
  const entries = normalizeDomainMemoryRegistry([
    {
      id: 'm1',
      title: 'Checkout iframe submit',
      lesson: 'Full private operational lesson that should require domain_memory_load.',
      appliesWhen: 'checkout iframe is visible',
      matcher: { domain: 'shop.example.com', pathPatterns: ['/checkout/*'] },
      tags: ['checkout', 'iframe'],
      confidence: 0.91,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ]);

  const context = buildDomainMemoryIndexContext(entries, [
    { url: 'https://shop.example.com/checkout/123', title: 'Checkout' },
  ]);

  assert.match(context, /Matched Domain Memory/);
  assert.match(context, /Checkout iframe submit/);
  assert.match(context, /id: m1/);
  assert.match(context, /domain_memory_load/);
  assert.doesNotMatch(context, /Full private operational lesson/);
});

test('persists, loads, disables, and deletes Domain Memory entries in local storage', async () => {
  installMockChromeStorage();

  const saved = await saveDomainMemoryDraft({
    title: 'Settings save button',
    lesson: 'Wait for the save toast after clicking the settings save button.',
    matcher: { domain: 'example.com', pathPatterns: ['/settings'] },
    outcome: 'success',
  });

  const loaded = await loadDomainMemoryEntries();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, saved.entry.id);

  const disabled = await setDomainMemoryEnabled(saved.entry.id, false);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(queryDomainMemoryEntries(await loadDomainMemoryEntries(), { domain: 'example.com' }), []);

  const deleted = await deleteDomainMemoryEntry(saved.entry.id);
  assert.equal(deleted, true);
  assert.deepEqual(await loadDomainMemoryEntries(), []);
});
