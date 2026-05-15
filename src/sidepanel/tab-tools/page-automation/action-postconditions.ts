import type {
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotOptions,
  BrowActionPostcondition,
  BrowPostconditionResult,
} from '../../../shared/types';

interface ActionPostconditionRuntimeDeps {
  delay: (ms: number) => Promise<void>;
  browserSnapshot: (tabId: number, options?: BrowserSnapshotOptions) => Promise<BrowserSnapshot>;
  browserResolveRef: (
    tabId: number,
    ref: string,
    snapshotId?: string,
    requireActionable?: boolean,
  ) => Promise<BrowserRefResolution>;
  waitForTabSettled: (tabId: number) => Promise<unknown>;
}

interface ClickPostconditionWaitResult {
  snapshot: BrowserSnapshot;
  results: BrowPostconditionResult[];
  waitedMs: number;
}

interface ClickNavigationFallbackResult {
  ok: boolean;
  snapshot?: BrowserSnapshot;
  postconditions?: BrowPostconditionResult[];
  error?: string;
}

const POSTACTION_SNAPSHOT_OPTIONS: BrowserSnapshotOptions = {
  mode: 'compact',
  maxElements: 80,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, janvier: 0, ene: 0, enero: 0,
  feb: 1, february: 1, février: 1, fevrier: 1,
  mar: 2, march: 2, mars: 2, marzo: 2,
  apr: 3, april: 3, avril: 3, abr: 3, abril: 3,
  may: 4, mai: 4, mayo: 4,
  jun: 5, june: 5, juin: 5, junio: 5,
  jul: 6, july: 6, juillet: 6, julio: 6,
  aug: 7, august: 7, août: 7, aout: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, septiembre: 8,
  oct: 9, october: 9, octobre: 9, octubre: 9,
  nov: 10, november: 10, novembre: 10, noviembre: 10,
  dec: 11, december: 11, décembre: 11, decembre: 11, dic: 11, diciembre: 11,
};

export function createActionPostconditionRuntime(deps: ActionPostconditionRuntimeDeps) {
  async function snapshotAfterAction(tabId: number): Promise<BrowserSnapshot> {
    await deps.delay(180);
    await deps.waitForTabSettled(tabId);
    return deps.browserSnapshot(tabId, POSTACTION_SNAPSHOT_OPTIONS);
  }

  async function waitForClickPostconditions(
    tabId: number,
    snapshot: BrowserSnapshot,
    postconditions: BrowActionPostcondition[] | undefined,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<ClickPostconditionWaitResult> {
    let currentSnapshot = snapshot;
    let results = await evaluatePostconditions(tabId, currentSnapshot, postconditions);

    if (postconditionsPassed(results) || !postconditions || postconditions.length === 0) {
      return { snapshot: currentSnapshot, results, waitedMs: 0 };
    }

    const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 1800), 5000));
    const pollMs = Math.max(100, Math.min(Math.floor(options.pollMs ?? 250), 1000));
    const startedAt = Date.now();

    while (!postconditionsPassed(results) && Date.now() - startedAt < timeoutMs) {
      await deps.delay(pollMs);
      currentSnapshot = await deps.browserSnapshot(tabId, POSTACTION_SNAPSHOT_OPTIONS);
      results = await evaluatePostconditions(tabId, currentSnapshot, postconditions);
    }

    return {
      snapshot: currentSnapshot,
      results,
      waitedMs: Date.now() - startedAt,
    };
  }

  async function evaluatePostconditions(
    tabId: number,
    snapshot: BrowserSnapshot,
    postconditions: BrowActionPostcondition[] | undefined,
  ): Promise<BrowPostconditionResult[]> {
    if (!postconditions || postconditions.length === 0) return [];

    const results: BrowPostconditionResult[] = [];
    for (const condition of postconditions) {
      try {
        if (condition.type === 'urlIncludes') {
          const actual = snapshot.url;
          results.push({ ok: actual.includes(condition.value), condition, actual });
          continue;
        }
        if (condition.type === 'urlMatches') {
          const actual = snapshot.url;
          results.push({ ok: new RegExp(condition.value).test(actual), condition, actual });
          continue;
        }
        if (condition.type === 'titleIncludes') {
          const actual = snapshot.title;
          results.push({ ok: actual.toLowerCase().includes(condition.value.toLowerCase()), condition, actual });
          continue;
        }
        if (condition.type === 'textVisible') {
          results.push({ ok: snapshotContainsText(snapshot, condition.value), condition });
          continue;
        }
        if (condition.type === 'textAbsent') {
          results.push({ ok: !snapshotContainsText(snapshot, condition.value), condition });
          continue;
        }
        if (condition.type === 'elementVisible') {
          const resolution = await deps.browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
          results.push({ ok: resolution.ok && Boolean(resolution.region), condition, actual: resolution.entry?.name });
          continue;
        }
        if (condition.type === 'elementHidden') {
          const resolution = await deps.browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
          results.push({ ok: !resolution.ok || !resolution.region, condition, actual: resolution.entry?.name });
          continue;
        }
        if (condition.type === 'valueEquals') {
          const resolution = await deps.browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
          const actual = resolution.entry?.text ?? resolution.entry?.name ?? '';
          const normalizedActual = actual.replace(/\s+/g, ' ').trim().toLowerCase();
          const normalizedExpected = (condition.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
          const matched = actual === condition.value
            || normalizedActual === normalizedExpected
            || normalizedActual.includes(normalizedExpected)
            || normalizedExpected.includes(normalizedActual)
            || valuesMatchAfterReformat(normalizedExpected, normalizedActual);
          results.push({ ok: matched, condition, actual });
          continue;
        }
        if (condition.type === 'downloadAppeared') {
          const download = await recentDownloadAppeared(condition.value);
          results.push({ ok: download.ok, condition, actual: download.actual, error: download.error });
          continue;
        }
        if (condition.type === 'dialogClosed') {
          const normalized = (condition.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
          const openDialog = snapshot.elements.some((element) => {
            if (element.role !== 'dialog' && element.attributes?.['aria-modal'] !== 'true') return false;
            if (!normalized) return true;
            return `${element.name ?? ''} ${element.text ?? ''}`.toLowerCase().includes(normalized);
          });
          results.push({ ok: !openDialog, condition, actual: openDialog ? 'dialog still visible' : 'closed' });
          continue;
        }
        if (condition.type === 'mediaState') {
          const media = await readMediaState(tabId);
          results.push({ ok: media.ok && media.actual === condition.value, condition, actual: media.actual, error: media.error });
        }
      } catch (err: any) {
        results.push({ ok: false, condition, error: err?.message ?? 'Postcondition check failed' });
      }
    }

    return results;
  }

  function postconditionsPassed(results: BrowPostconditionResult[]): boolean {
    return results.every((result) => result.ok);
  }

  function getSuccessfulNavigationWarning(params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
    postconditions: BrowPostconditionResult[];
  }): string | undefined {
    const clickedHref = (params.action as any)?.clicked?.href as string | undefined;
    const beforeUrl = params.beforeSnapshot?.url;
    const afterUrl = params.snapshot.url;

    if (!clickedHref || !beforeUrl || !afterUrl) return undefined;
    if (normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl)) return undefined;
    if (!urlsMatchAfterNavigation(afterUrl, clickedHref)) return undefined;
    if (!hasOnlyTextPostconditionFailures(params.postconditions)) return undefined;

    return 'Click navigated to the clicked href, but the requested text postconditions did not match the destination page. Continue from the returned snapshot or prefer urlIncludes/elementVisible for page-opening clicks.';
  }

  function getExpectedClickNavigationHref(
    action: unknown,
    beforeSnapshot?: BrowserSnapshot,
  ): string | undefined {
    const clickedHref = (action as any)?.clicked?.href as string | undefined;
    const beforeUrl = beforeSnapshot?.url;
    if (!clickedHref || !beforeUrl) return undefined;

    try {
      const parsedHref = new URL(clickedHref);
      if (!['http:', 'https:'].includes(parsedHref.protocol)) return undefined;
      const normalizedHref = normalizeNavigatedUrl(parsedHref.toString());
      const normalizedBefore = normalizeNavigatedUrl(beforeUrl);
      if (!normalizedHref || !normalizedBefore || normalizedHref === normalizedBefore) return undefined;
      return parsedHref.toString();
    } catch {
      return undefined;
    }
  }

  function shouldRetryProgrammaticClickForNavigation(params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
  }): boolean {
    const expectedHref = getExpectedClickNavigationHref(params.action, params.beforeSnapshot);
    const beforeUrl = params.beforeSnapshot?.url;
    const afterUrl = params.snapshot.url;
    if (!expectedHref || !beforeUrl || !afterUrl) return false;
    if (urlsMatchAfterNavigation(afterUrl, expectedHref)) return false;
    return normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl);
  }

  function getMissedClickNavigationError(params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
  }): string | undefined {
    const expectedHref = getExpectedClickNavigationHref(params.action, params.beforeSnapshot);
    const beforeUrl = params.beforeSnapshot?.url;
    const afterUrl = params.snapshot.url;
    if (!expectedHref || !beforeUrl || !afterUrl) return undefined;
    if (urlsMatchAfterNavigation(afterUrl, expectedHref)) return undefined;
    if (normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl)) {
      return 'Click targeted a navigable link, but the page stayed on the current URL instead of opening the clicked href.';
    }
    return 'Click targeted a navigable link, but the page did not reach the clicked href.';
  }

  async function navigateTabToClickedHref(
    tabId: number,
    href: string,
    postconditions: BrowActionPostcondition[] | undefined,
  ): Promise<ClickNavigationFallbackResult> {
    try {
      await chrome.tabs.update(tabId, { url: href });
      let snapshot = await snapshotAfterAction(tabId);
      let results = await evaluatePostconditions(tabId, snapshot, postconditions);
      if (!postconditionsPassed(results)) {
        const waited = await waitForClickPostconditions(tabId, snapshot, postconditions);
        snapshot = waited.snapshot;
        results = waited.results;
      }
      return {
        ok: true,
        snapshot,
        postconditions: results,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message ?? 'Failed to open the clicked href via tab navigation fallback',
      };
    }
  }

  return {
    snapshotAfterAction,
    waitForClickPostconditions,
    evaluatePostconditions,
    postconditionsPassed,
    getSuccessfulNavigationWarning,
    getExpectedClickNavigationHref,
    shouldRetryProgrammaticClickForNavigation,
    getMissedClickNavigationError,
    navigateTabToClickedHref,
    recentDownloadAppeared,
  };
}

function snapshotContainsText(snapshot: BrowserSnapshot, needle: string): boolean {
  const normalizedNeedle = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedNeedle) return true;
  return snapshot.elements.some((element) =>
    `${element.name ?? ''} ${element.text ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase().includes(normalizedNeedle),
  );
}

async function recentDownloadAppeared(needle?: string): Promise<{ ok: boolean; actual?: string; error?: string }> {
  try {
    if (!chrome.downloads?.search) {
      return { ok: false, error: 'chrome.downloads permission/API is unavailable' };
    }
    const downloads = await chrome.downloads.search({
      limit: 25,
      orderBy: ['-startTime'],
      startedAfter: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const normalizedNeedle = (needle ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const match = downloads.find((item) => {
      const haystack = `${item.filename ?? ''} ${item.url ?? ''} ${item.finalUrl ?? ''}`.toLowerCase();
      return !normalizedNeedle || haystack.includes(normalizedNeedle);
    });
    return {
      ok: Boolean(match),
      actual: match?.filename ?? match?.url,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to inspect downloads' };
  }
}

async function readMediaState(tabId: number): Promise<{ ok: boolean; actual?: string; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const media = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))
          .filter((element) => element.offsetWidth > 0 || element.offsetHeight > 0);
        const target = media[0];
        if (!target) return { ok: false, error: 'No visible media element found' };
        return { ok: true, actual: target.paused ? 'paused' : 'playing' };
      },
    });
    return (results?.[0]?.result as { ok: boolean; actual?: string; error?: string } | undefined)
      ?? { ok: false, error: 'No response while reading media state' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to read media state' };
  }
}

function extractDateParts(value: string): { day: number; month: number; year?: number } | null {
  const slashDot = value.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (slashDot) {
    const [, a, b, c] = slashDot;
    const n1 = Number(a);
    const n2 = Number(b);
    const n3 = Number(c);
    const year = n3 < 100 ? n3 + 2000 : n3;
    if (n1 <= 31 && n2 >= 1 && n2 <= 12) return { day: n1, month: n2 - 1, year };
    if (n1 >= 1 && n1 <= 12 && n2 <= 31) return { day: n2, month: n1 - 1, year };
  }
  const isoDash = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDash) {
    return { day: Number(isoDash[3]), month: Number(isoDash[2]) - 1, year: Number(isoDash[1]) };
  }

  const words = value.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const word of words) {
    const num = Number(word);
    if (Number.isFinite(num) && num >= 1 && num <= 31 && day === undefined) {
      day = num;
      continue;
    }
    if (Number.isFinite(num) && num >= 1900 && num <= 2100) {
      year = num;
      continue;
    }
    const monthIndex = MONTH_NAMES[word.toLowerCase()];
    if (monthIndex !== undefined) {
      month = monthIndex;
    }
  }
  if (day !== undefined && month !== undefined) return { day, month, year };
  return null;
}

function valuesMatchAfterReformat(expected: string, actual: string): boolean {
  const expectedParts = extractDateParts(expected);
  const actualParts = extractDateParts(actual);
  if (!expectedParts || !actualParts) return false;
  if (expectedParts.day !== actualParts.day || expectedParts.month !== actualParts.month) return false;
  if (
    expectedParts.year !== undefined
    && actualParts.year !== undefined
    && expectedParts.year !== actualParts.year
  ) {
    return false;
  }
  return true;
}

function normalizeNavigatedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.toString();
  } catch {
    return value.trim() || undefined;
  }
}

function urlsMatchAfterNavigation(actualUrl: string | undefined, expectedUrl: string | undefined): boolean {
  const normalizedActual = normalizeNavigatedUrl(actualUrl);
  const normalizedExpected = normalizeNavigatedUrl(expectedUrl);
  if (!normalizedActual || !normalizedExpected) return false;
  return normalizedActual === normalizedExpected;
}

function hasOnlyTextPostconditionFailures(results: BrowPostconditionResult[]): boolean {
  const failed = results.filter((result) => !result.ok);
  return failed.length > 0
    && failed.every((result) => result.condition.type === 'textVisible' || result.condition.type === 'textAbsent');
}
