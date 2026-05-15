#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import ts from 'typescript';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const modulePath = path.join(repoRoot, 'src/sidepanel/agent-runtime/automation-tool-result.ts');
const snapshotModulePath = path.join(repoRoot, 'src/sidepanel/agent-runtime/tool-result-snapshot.ts');

function estimateTokens(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return 0;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(trimmed.length / 4), Math.ceil(wordCount * 0.8));
}

async function loadModule(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  });

  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require(specifier) {
      throw new Error(`Unsupported require in benchmark module: ${specifier}`);
    },
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(transpiled.outputText, context, { filename: filePath });
  return module.exports;
}

function buildFixtures() {
  return [
    {
      name: 'click-success-rich',
      primary: true,
      payload: {
        ok: true,
        action: {
          clicked: {
            selector: 'brow-ref://smp4nd84ml9wrfq/e20',
            tagName: 'select',
            text: 'Name (A to Z) Name (Z to A) Price (low to high) Price (high to low)',
            type: 'select-one',
          },
          ok: true,
        },
        resolved: {
          ok: true,
          ref: 'e20',
          snapshotId: 'smp4nd84ml9wrfq',
          selector: 'brow-ref://smp4nd84ml9wrfq/e20',
          entry: {
            ref: 'e20',
            role: 'combobox',
            name: 'Name (A to Z)Name (Z to A)Price (low to high)Price (high to low)',
            tagName: 'select',
            type: 'select-one',
            selector: 'select[data-test="product-sort-container"]',
            actionable: true,
            depth: 7,
            bounds: {
              x: 791,
              y: 69.6,
              left: 791,
              top: 69.6,
              right: 1014.4,
              bottom: 100,
              width: 223.4,
              height: 30.4,
            },
            attributes: { 'data-test': 'product-sort-container' },
          },
          recovered: false,
          preconditions: {
            visible: true,
            enabled: true,
            stable: true,
            receivesEvents: true,
            actionable: true,
            ok: true,
          },
          region: {
            source: 'ref',
            ref: 'e20',
            snapshotId: 'smp4nd84ml9wrfq',
            rect: {
              x: 791,
              y: 69.6,
              left: 791,
              top: 69.6,
              right: 1014.4,
              bottom: 100,
              width: 223.4,
              height: 30.4,
            },
            viewport: {
              width: 1050,
              height: 826,
              scrollX: 0,
              scrollY: 0,
              devicePixelRatio: 1.25,
            },
          },
          backend: 'mv3-dom',
          confidence: 100,
        },
        backend: 'mv3-dom',
        confidence: 100,
        cacheStatus: 'disabled',
        trace: {
          traceId: '3d5bbfed-e5ab-441b-ad9a-8ff3cae197c2',
          tabId: 699957115,
          actionKind: 'click',
          intent: 'Open sort dropdown',
          cacheStatus: 'disabled',
          startedAt: 1778712291492,
          backend: 'mv3-dom',
          resolvedRef: 'e20',
          originalRef: 'e20',
          snapshotId: 'smp4nd84ml9wrfq',
          confidence: 100,
          preconditions: {
            visible: true,
            enabled: true,
            stable: true,
            receivesEvents: true,
            actionable: true,
            ok: true,
          },
          execution: {
            clicked: {
              selector: 'brow-ref://smp4nd84ml9wrfq/e20',
              tagName: 'select',
              text: 'Name (A to Z) Name (Z to A) Price (low to high) Price (high to low)',
              type: 'select-one',
            },
            ok: true,
          },
          postconditions: [{ ok: true, condition: { type: 'textVisible', value: 'Price (low to high)' } }],
          completedAt: 1778712293583,
        },
        postconditions: [{ ok: true, condition: { type: 'textVisible', value: 'Price (low to high)' } }],
        repairNeeded: false,
        beforeSnapshot: {
          ok: true,
          snapshotId: 'smp4ndg7vpc20ka',
          tabId: 699957115,
          url: 'https://www.saucedemo.com/inventory.html',
          title: 'Swag Labs',
          generatedAt: 1778712291931,
          viewport: { width: 1050, height: 826, scrollX: 0, scrollY: 0, devicePixelRatio: 1.25 },
          visibleElementCount: 57,
          displayedElementCount: 15,
          omittedElementCount: 42,
        },
        snapshot: {
          ok: true,
          snapshotId: 'smp4ndhhr1a8d2f',
          tabId: 699957115,
          url: 'https://www.saucedemo.com/inventory.html',
          title: 'Swag Labs',
          generatedAt: 1778712293583,
          viewport: { width: 1050, height: 826, scrollX: 0, scrollY: 0, devicePixelRatio: 1.25 },
          visibleElementCount: 57,
          displayedElementCount: 15,
          omittedElementCount: 42,
          elements: [
            {
              ref: 'e20',
              role: 'combobox',
              name: 'Name (A to Z)Name (Z to A)Price (low to high)Price (high to low)',
              tagName: 'select',
              type: 'select-one',
              selector: 'select[data-test="product-sort-container"]',
              actionable: true,
              depth: 5,
              bounds: {
                x: 791,
                y: 69.6,
                left: 791,
                top: 69.6,
                right: 1014.4,
                bottom: 100,
                width: 223.4,
                height: 30.4,
              },
            },
            {
              ref: 'e36',
              role: 'button',
              name: 'remove-sauce-labs-backpack',
              tagName: 'button',
              type: 'submit',
              actionable: true,
              depth: 5,
              bounds: {
                x: 825,
                y: 339,
                left: 825,
                top: 339,
                right: 985,
                bottom: 373,
                width: 160,
                height: 34,
              },
            },
            {
              ref: 'e31',
              role: 'link',
              name: 'Sauce Labs Backpack',
              tagName: 'a',
              actionable: true,
              depth: 5,
              bounds: {
                x: 352,
                y: 174,
                left: 352,
                top: 174,
                right: 985,
                bottom: 194,
                width: 633,
                height: 20,
              },
            },
          ],
        },
      },
    },
    {
      name: 'repair-needed-rich',
      primary: false,
      payload: {
        ok: false,
        action: {
          clicked: {
            selector: 'brow-ref://snap/e7',
            tagName: 'button',
            text: 'Search',
            type: 'submit',
          },
          ok: false,
        },
        resolved: {
          ok: true,
          ref: 'e7',
          originalRef: 'e4',
          snapshotId: 'snap',
          recovered: true,
          matchScore: 84,
          entry: {
            ref: 'e7',
            role: 'button',
            name: 'Search',
            tagName: 'button',
            selector: 'button[type="submit"]',
            actionable: true,
            depth: 4,
            bounds: { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 44, width: 120, height: 44 },
          },
          preconditions: { visible: false, ok: false },
          repairCandidates: [
            { ref: 'e7', selector: 'button[type="submit"]', role: 'button', name: 'Search', tagName: 'button', score: 84, bounds: { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 44, width: 120, height: 44 } },
            { ref: 'e8', selector: 'button[data-test="search"]', role: 'button', name: 'Search now', tagName: 'button', score: 73, bounds: { x: 0, y: 52, left: 0, top: 52, right: 120, bottom: 96, width: 120, height: 44 } },
          ],
        },
        cacheStatus: 'stale',
        trace: {
          traceId: 'trace-1',
          tabId: 9,
          actionKind: 'click',
          cacheStatus: 'stale',
          startedAt: 1,
          memoryEntryId: 'mem-1',
          cacheKey: 'key-1',
          resolvedRef: 'e7',
          originalRef: 'e4',
          recoveryDecision: 'promoted descendant',
        },
        postconditions: [
          {
            ok: false,
            condition: { type: 'textVisible', value: 'Results' },
            actual: 'No results yet',
            error: 'Timed out waiting for text',
          },
        ],
        recoveryCandidates: [
          { ref: 'e7', selector: 'button[type="submit"]', role: 'button', name: 'Search', tagName: 'button', score: 84, bounds: { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 44, width: 120, height: 44 } },
          { ref: 'e8', selector: 'button[data-test="search"]', role: 'button', name: 'Search now', tagName: 'button', score: 73, bounds: { x: 0, y: 52, left: 0, top: 52, right: 120, bottom: 96, width: 120, height: 44 } },
        ],
        repairNeeded: true,
        error: 'Postconditions failed',
      },
    },
  ];
}

function parseArgs(argv) {
  const options = { output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') {
      options.output = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { compactAutomationToolResult, formatAutomationToolResultText } = await loadModule(modulePath);
  const { attachToolSnapshotFields } = await loadModule(snapshotModulePath);

  const scenarios = buildFixtures().map((fixture) => {
    const baselineJson = JSON.stringify(attachToolSnapshotFields(fixture.payload), null, 2);
    const compacted = attachToolSnapshotFields(compactAutomationToolResult(fixture.payload));
    const compactedText = formatAutomationToolResultText(compacted, fixture.name.includes('click') ? 'browser_click' : 'browser_type');
    return {
      name: fixture.name,
      primary: fixture.primary,
      baselineChars: baselineJson.length,
      compactedChars: compactedText.length,
      baselineEstimatedTokens: estimateTokens(baselineJson),
      compactedEstimatedTokens: estimateTokens(compactedText),
      deltaCharsPercent: Number((((compactedText.length - baselineJson.length) / baselineJson.length) * 100).toFixed(1)),
      deltaEstimatedTokensPercent: Number((((estimateTokens(compactedText) - estimateTokens(baselineJson)) / estimateTokens(baselineJson)) * 100).toFixed(1)),
      removedTrace: !('trace' in compacted),
      keptSnapshot: compacted.snapshot !== undefined,
      keptBeforeSnapshot: compacted.beforeSnapshot !== undefined,
      compactedPreview: compactedText.slice(0, 600),
    };
  });

  const output = {
    benchmark: 'automation-tool-result',
    generatedAt: new Date().toISOString(),
    scenarios,
  };

  const serialized = JSON.stringify(output, null, 2);
  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(process.cwd(), options.output)), { recursive: true });
    await fs.writeFile(path.resolve(process.cwd(), options.output), serialized);
  }
  console.log(serialized);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});