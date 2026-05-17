export const LOCAL_NAVIGATION_MECHANICS = [
  'tab-switching',
  'same-tab-navigation',
  'same-tab-redirect',
  'results-to-detail',
  'back-forward-history',
  'stale-ref-recovery',
] as const;

export const LIVE_FAILURE_BUCKETS = [
  'planner',
  'tool-runtime',
  'snapshot-ref-resolution',
  'page-site-drift',
  'environment-backend',
] as const;

export type LocalNavigationMechanic = (typeof LOCAL_NAVIGATION_MECHANICS)[number];
export type LiveFailureBucket = (typeof LIVE_FAILURE_BUCKETS)[number];

export interface LocalNavigationScenario {
  slug: string;
  label: string;
  family: 'search' | 'media' | 'travel' | 'reliability';
  entryPaths: string[];
  mechanics: LocalNavigationMechanic[];
  primaryAssertions: string[];
}

export interface LiveScenarioBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxRepairActions: number;
}

export interface LiveScenario {
  slug: string;
  label: string;
  kind: 'travel' | 'media' | 'search' | 'commerce';
  website: string;
  runMode: 'manual';
  usesProductionPromptAssembly: true;
  modelStrategy: 'primary-model-swappable';
  defaultPrompt: string;
  successCriteria: string[];
  budget: LiveScenarioBudget;
  complexReplayPath?: string;
}

export const LOCAL_NAVIGATION_SCENARIOS: LocalNavigationScenario[] = [
  {
    slug: 'fixture-search-results-flow',
    label: 'Fixture search to docs result',
    family: 'search',
    entryPaths: ['test-page/navigation/search-home.html'],
    mechanics: ['same-tab-navigation', 'results-to-detail', 'back-forward-history'],
    primaryAssertions: [
      'Submits a query into a search home fixture.',
      'Navigates to a results page in the same tab.',
      'Chooses the documentation result and lands on the docs target page.',
    ],
  },
  {
    slug: 'fixture-media-watch-flow',
    label: 'Fixture media search to watch page',
    family: 'media',
    entryPaths: ['test-page/navigation/media-home.html'],
    mechanics: ['same-tab-navigation', 'results-to-detail', 'back-forward-history'],
    primaryAssertions: [
      'Submits a media query into the home fixture.',
      'Navigates to results that contain both watch and channel destinations.',
      'Opens the watch page and verifies playback state can switch to playing.',
    ],
  },
  {
    slug: 'fixture-travel-redirect-flow',
    label: 'Fixture travel search with redirect',
    family: 'travel',
    entryPaths: ['test-page/navigation/travel-search.html'],
    mechanics: ['same-tab-navigation', 'same-tab-redirect', 'results-to-detail'],
    primaryAssertions: [
      'Fills a structured travel search form with route and dates.',
      'Submits through an intermediate redirect page.',
      'Lands on a results page that preserves the requested route and dates.',
    ],
  },
  {
    slug: 'fixture-tab-switch-and-stale-ref',
    label: 'Fixture multi-tab switch and stale ref recovery',
    family: 'reliability',
    entryPaths: [
      'test-page/navigation/search-home.html',
      'test-page/navigation/media-home.html',
      'test-page/reliability-fixture.html',
    ],
    mechanics: ['tab-switching', 'stale-ref-recovery', 'back-forward-history'],
    primaryAssertions: [
      'Opens multiple fixture tabs and keeps the active-tab context aligned.',
      'Uses the reliability fixture to validate renamed or moved targets after a snapshot becomes stale.',
      'Returns to earlier pages using browser history without reusing invalid refs.',
    ],
  },
];

export const LIVE_NAVIGATION_SCENARIOS: LiveScenario[] = [
  {
    slug: 'live-google-flights-round-trip',
    label: 'Google Flights round-trip search',
    kind: 'travel',
    website: 'Google Flights',
    runMode: 'manual',
    usesProductionPromptAssembly: true,
    modelStrategy: 'primary-model-swappable',
    defaultPrompt: 'search a flight from paris to rabat for 12/05/2026 to 19/05/2026 using google flight',
    successCriteria: [
      'The route remains Paris to Rabat.',
      'The outbound and return dates remain 12/05/2026 and 19/05/2026.',
      'The agent moves to the real search/results step instead of looping on satisfied fields.',
    ],
    budget: {
      maxTurns: 8,
      maxToolCalls: 14,
      maxRepairActions: 3,
    },
    complexReplayPath: 'sample/live-scenarios/google-flights-history-replay.json',
  },
  {
    slug: 'live-youtube-watch-playback',
    label: 'YouTube search to watch page playback',
    kind: 'media',
    website: 'YouTube',
    runMode: 'manual',
    usesProductionPromptAssembly: true,
    modelStrategy: 'primary-model-swappable',
    defaultPrompt: 'search youtube for a video, open the watch page result instead of a channel page, and play it',
    successCriteria: [
      'The selected destination is a watch page rather than a channel page.',
      'Playback reaches mediaState playing.',
      'The run avoids broad-container misclicks and redundant navigation.',
    ],
    budget: {
      maxTurns: 7,
      maxToolCalls: 12,
      maxRepairActions: 2,
    },
  },
  {
    slug: 'live-general-search-docs-result',
    label: 'General search to reference domain',
    kind: 'search',
    website: 'DuckDuckGo-like public search',
    runMode: 'manual',
    usesProductionPromptAssembly: true,
    modelStrategy: 'primary-model-swappable',
    defaultPrompt: 'use a public search engine to search for browser snapshot docs, open the intended documentation or reference result, and stop on the target page',
    successCriteria: [
      'The query reaches a public search results page.',
      'The chosen result lands on a documentation or reference domain.',
      'The run uses the correct result instead of stopping at results only.',
    ],
    budget: {
      maxTurns: 6,
      maxToolCalls: 10,
      maxRepairActions: 2,
    },
  },
  {
    slug: 'live-saucedemo-login',
    label: 'SauceDemo login to inventory page',
    kind: 'commerce',
    website: 'SauceDemo',
    runMode: 'manual',
    usesProductionPromptAssembly: true,
    modelStrategy: 'primary-model-swappable',
    defaultPrompt: 'go to saucedemo.com, log in with username standard_user and password secret_sauce, and stop once the inventory page is clearly verified',
    successCriteria: [
      'The run reaches the SauceDemo inventory page after logging in.',
      'The agent verifies success using inventory page state instead of continuing deeper into checkout.',
      'The run stops once login success is established.',
    ],
    budget: {
      maxTurns: 5,
      maxToolCalls: 8,
      maxRepairActions: 2,
    },
  },
];

export function getLocalNavigationScenario(slug: string): LocalNavigationScenario | undefined {
  return LOCAL_NAVIGATION_SCENARIOS.find((scenario) => scenario.slug === slug);
}

export function getLiveNavigationScenario(slug: string): LiveScenario | undefined {
  return LIVE_NAVIGATION_SCENARIOS.find((scenario) => scenario.slug === slug);
}
