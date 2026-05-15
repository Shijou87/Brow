#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import ts from 'typescript';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const modulePath = path.join(repoRoot, 'src/sidepanel/agent-runtime/browser-context-layout.ts');

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

function makeSnapshotText({ snapshotId, tabId, title, url, summary }) {
  return `Browser snapshot snapshotId=${snapshotId} tabId=${tabId} title="${title}" url=${url} viewport=1280x720\n${summary}`;
}

function buildScenarios() {
  return [
    {
      name: 'selected-active-and-secondary',
      primary: true,
      input: {
        totalTabCount: 6,
        listedTabs: [
          { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
          { tabId: 77, title: 'Docs', url: 'https://example.com/docs', active: false, status: 'complete' },
          { tabId: 63, title: 'Search', url: 'https://example.com/search?q=browser+snapshot', active: false, status: 'complete' },
          { tabId: 58, title: 'Cart', url: 'https://www.saucedemo.com/cart.html', active: false, status: 'complete' },
          { tabId: 41, title: 'Checkout', url: 'https://www.saucedemo.com/checkout-step-one.html', active: false, status: 'complete' },
          { tabId: 38, title: 'Settings', url: 'https://example.com/settings', active: false, status: 'complete' },
        ],
        extraTabCount: 0,
        visibleTabId: 91,
        activeTab: { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
        selectedTabCount: 2,
        omittedAttachedTabCount: 0,
        attachedSnapshotBlocks: [
          {
            tabId: 91,
            title: 'Products',
            url: 'https://www.saucedemo.com/inventory.html',
            active: true,
            snapshotText: makeSnapshotText({
              snapshotId: 's-products',
              tabId: 91,
              title: 'Products',
              url: 'https://www.saucedemo.com/inventory.html',
              summary: '- heading "Products" [ref=e1]\n- button "Add to cart Sauce Labs Backpack" [ref=e7]',
            }),
          },
          {
            tabId: 58,
            title: 'Cart',
            url: 'https://www.saucedemo.com/cart.html',
            active: false,
            snapshotText: makeSnapshotText({
              snapshotId: 's-cart',
              tabId: 58,
              title: 'Cart',
              url: 'https://www.saucedemo.com/cart.html',
              summary: '- heading "Your Cart" [ref=e1]\n- button "Checkout" [ref=e4]',
            }),
          },
        ],
      },
    },
    {
      name: 'no-attached-tabs',
      primary: false,
      input: {
        totalTabCount: 2,
        listedTabs: [
          { tabId: 11, title: 'Search', url: 'https://example.com/search', active: true, status: 'complete' },
          { tabId: 12, title: 'Docs', url: 'https://example.com/docs', active: false, status: 'complete' },
        ],
        extraTabCount: 0,
        visibleTabId: 11,
        activeTab: { tabId: 11, title: 'Search', url: 'https://example.com/search', active: true, status: 'complete' },
        selectedTabCount: 0,
        omittedAttachedTabCount: 0,
        attachedSnapshotBlocks: [],
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
  const { buildBrowserContextSnapshotLayout } = await loadModule(modulePath);

  const scenarios = buildScenarios().map((scenario) => {
    const result = buildBrowserContextSnapshotLayout(scenario.input);
    const text = result.text;
    return {
      name: scenario.name,
      primary: scenario.primary,
      chars: text.length,
      estimatedTokens: estimateTokens(text),
      frameChars: result.metrics.frameChars,
      openTabsSectionChars: result.metrics.openTabsSectionChars,
      activeTabSectionChars: result.metrics.activeTabSectionChars,
      attachedSnapshotsSectionChars: result.metrics.attachedSnapshotsSectionChars,
      attachedBlockCount: scenario.input.attachedSnapshotBlocks.length,
      containsActiveSection: text.includes('Current visible/selected tab:'),
      containsPrimarySnapshotTitle: text.includes('title="Products"'),
      containsSecondarySnapshotTitle: scenario.name === 'selected-active-and-secondary'
        ? text.includes('title="Cart"')
        : true,
      containsNoAttachedMessage: scenario.name === 'no-attached-tabs'
        ? text.includes('Attached tab ref snapshots: none selected for this message.')
        : true,
      preview: text.slice(0, 500),
    };
  });

  const output = {
    benchmark: 'browser-context-layout',
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