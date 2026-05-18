const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOCAL_NAVIGATION_MECHANICS,
  LOCAL_NAVIGATION_SCENARIOS,
  LIVE_FAILURE_BUCKETS,
  LIVE_NAVIGATION_SCENARIOS,
  getLocalNavigationScenario,
  getLiveNavigationScenario,
} = require('../.tmp/navigation-scenarios-test/navigation-test-scenarios.js');

const repoRoot = path.resolve(__dirname, '..');

test('local navigation scenarios cover the first-slice mechanics', () => {
  const coveredMechanics = new Set(
    LOCAL_NAVIGATION_SCENARIOS.flatMap((scenario) => scenario.mechanics),
  );

  for (const mechanic of LOCAL_NAVIGATION_MECHANICS) {
    assert.equal(coveredMechanics.has(mechanic), true, `missing mechanic coverage for ${mechanic}`);
  }

  assert.equal(getLocalNavigationScenario('fixture-search-results-flow')?.family, 'search');
  assert.equal(getLocalNavigationScenario('fixture-media-watch-flow')?.family, 'media');
  assert.equal(getLocalNavigationScenario('fixture-travel-redirect-flow')?.family, 'travel');
});

test('live navigation scenarios match the phased first slice', () => {
  const slugs = LIVE_NAVIGATION_SCENARIOS.map((scenario) => scenario.slug);

  assert.deepEqual(slugs, [
    'live-google-flights-round-trip',
    'live-youtube-watch-playback',
    'live-general-search-docs-result',
    'live-saucedemo-login',
  ]);

  assert.equal(getLiveNavigationScenario('live-google-flights-round-trip')?.runMode, 'manual');
  assert.equal(getLiveNavigationScenario('live-google-flights-round-trip')?.defaultPrompt, 'search a flight from paris to rabat for 12/05/2026 to 19/05/2026 using google flight');
  assert.equal(getLiveNavigationScenario('live-youtube-watch-playback')?.usesProductionPromptAssembly, true);
  assert.equal(getLiveNavigationScenario('live-general-search-docs-result')?.modelStrategy, 'primary-model-swappable');
  assert.equal(getLiveNavigationScenario('live-saucedemo-login')?.runMode, 'manual');
  assert.deepEqual(LIVE_FAILURE_BUCKETS, [
    'planner',
    'tool-runtime',
    'snapshot-ref-resolution',
    'page-site-drift',
    'environment-backend',
  ]);
});

test('scenario fixture entry paths exist on disk', () => {
  for (const scenario of LOCAL_NAVIGATION_SCENARIOS) {
    for (const entryPath of scenario.entryPaths) {
      const absolutePath = path.join(repoRoot, entryPath);
      assert.equal(fs.existsSync(absolutePath), true, `missing fixture entry path ${entryPath}`);
    }
  }
});

test('search, media, and travel fixtures expose the intended navigation anchors', () => {
  const searchResults = fs.readFileSync(path.join(repoRoot, 'test-page/navigation/search-results.html'), 'utf8');
  assert.match(searchResults, /id="docs-result"/);
  assert.match(searchResults, /docs-target\.html/);

  const mediaResults = fs.readFileSync(path.join(repoRoot, 'test-page/navigation/media-results.html'), 'utf8');
  assert.match(mediaResults, /id="watch-result"/);
  assert.match(mediaResults, /id="channel-result"/);

  const mediaWatch = fs.readFileSync(path.join(repoRoot, 'test-page/navigation/media-watch.html'), 'utf8');
  assert.match(mediaWatch, /id="play-button"/);
  assert.match(mediaWatch, /id="playback-status"/);

  const travelRedirect = fs.readFileSync(path.join(repoRoot, 'test-page/navigation/travel-redirect.html'), 'utf8');
  assert.match(travelRedirect, /window\.location\.replace/);

  const travelResults = fs.readFileSync(path.join(repoRoot, 'test-page/navigation/travel-results.html'), 'utf8');
  assert.match(travelResults, /Reached results through redirect\./);
});
