#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import ts from 'typescript';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const modulePath = path.join(repoRoot, 'src/sidepanel/agent-runtime/tool-context-carry-forward.ts');

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

function buildSnapshotText(title, refs) {
  return [
    `Browser snapshot snapshotId=s-${title.toLowerCase().replace(/\s+/g, '-')}`,
    `title="${title}"`,
    'url=https://www.saucedemo.com/',
    'viewport=1280x720',
    ...refs.map((ref, index) => `- ${ref.role} "${ref.name}" [ref=e${index + 1}] [bounds=${ref.bounds}]`),
  ].join('\n');
}

function buildFixtureScenarios() {
  const loginSuccess = [
    {
      label: 'Create tab',
      toolName: 'create_tab',
      status: 'completed',
      inputText: '{"url":"https://www.saucedemo.com/","active":true}',
      resultText: '{"ok":true,"tabId":91,"url":"https://www.saucedemo.com/"}',
    },
    {
      label: 'Browser snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      inputText: '{"tabId":91,"mode":"compact","maxElements":80}',
      resultText: buildSnapshotText('Swag Labs', [
        { role: 'textbox', name: 'Username', bounds: '152,184,328x40' },
        { role: 'textbox', name: 'Password', bounds: '152,244,328x40' },
        { role: 'button', name: 'Login', bounds: '152,304,328x48' },
      ]),
    },
    {
      label: 'Browser type',
      toolName: 'browser_type',
      status: 'completed',
      inputText: '{"tabId":91,"ref":"e1","text":"standard_user","snapshotId":"s-login"}',
      resultText: buildSnapshotText('Swag Labs', [
        { role: 'textbox', name: 'Username', bounds: '152,184,328x40' },
        { role: 'textbox', name: 'Password', bounds: '152,244,328x40' },
        { role: 'button', name: 'Login', bounds: '152,304,328x48' },
      ]),
    },
    {
      label: 'Browser type',
      toolName: 'browser_type',
      status: 'completed',
      inputText: '{"tabId":91,"ref":"e2","text":"secret_sauce","snapshotId":"s-login-typed-user"}',
      resultText: buildSnapshotText('Swag Labs', [
        { role: 'textbox', name: 'Username', bounds: '152,184,328x40' },
        { role: 'textbox', name: 'Password', bounds: '152,244,328x40' },
        { role: 'button', name: 'Login', bounds: '152,304,328x48' },
      ]),
    },
    {
      label: 'Browser click',
      toolName: 'browser_click',
      status: 'completed',
      inputText: '{"tabId":91,"ref":"e3","snapshotId":"s-login-ready","intent":"submit login"}',
      resultText: buildSnapshotText('Products', [
        { role: 'heading', name: 'Products', bounds: '36,128,180x40' },
        { role: 'button', name: 'Open Menu', bounds: '24,24,32x32' },
        { role: 'button', name: 'Add to cart Sauce Labs Backpack', bounds: '24,412,296x40' },
      ]),
    },
    {
      label: 'Browser snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      inputText: '{"tabId":91,"mode":"compact","maxElements":80}',
      resultText: buildSnapshotText('Products', [
        { role: 'heading', name: 'Products', bounds: '36,128,180x40' },
        { role: 'button', name: 'Open Menu', bounds: '24,24,32x32' },
        { role: 'button', name: 'Add to cart Sauce Labs Backpack', bounds: '24,412,296x40' },
        { role: 'button', name: 'Add to cart Sauce Labs Bike Light', bounds: '24,684,296x40' },
      ]),
    },
  ];

  const repairMixed = [
    {
      label: 'Browser snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      inputText: '{"tabId":91,"mode":"compact","maxElements":80}',
      resultText: buildSnapshotText('Flights', [
        { role: 'combobox', name: 'From', bounds: '128,200,260x48' },
        { role: 'combobox', name: 'To', bounds: '404,200,260x48' },
      ]),
    },
    {
      label: 'Browser click',
      toolName: 'browser_click',
      status: 'error',
      inputText: '{"tabId":91,"ref":"e12","snapshotId":"s-flight","intent":"click search button"}',
      errorText: 'Resolved click target is an editable field, but the click intent looks like submit/search. Do not use browser_click on textboxes or comboboxes as a stand-in for search or submit.',
    },
    {
      label: 'Browser form snapshot',
      toolName: 'browser_form_snapshot',
      status: 'completed',
      inputText: '{"tabId":91,"snapshotId":"s-flight"}',
      resultText: '{"ok":true,"fieldCount":14,"fillTargetCount":4,"submitRefs":["e41"]}',
    },
    {
      label: 'Browser click',
      toolName: 'browser_click',
      status: 'completed',
      inputText: '{"tabId":91,"ref":"e41","snapshotId":"s-flight-form","intent":"submit search"}',
      resultText: '{"ok":true,"postconditions":[{"ok":true,"condition":{"type":"urlIncludes","value":"/search"}}]}',
    },
  ];

  return [
    { name: 'login-success', primary: true, steps: loginSuccess },
    { name: 'repair-mixed', primary: false, steps: repairMixed },
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
  const { buildToolContextCarryForwardMessage } = await loadModule(modulePath);
  const scenarios = buildFixtureScenarios().map((scenario) => {
    const summary = buildToolContextCarryForwardMessage(scenario.steps);
    const sectionCount = (summary?.match(/^\d+\. /gm) ?? []).length;
    const lastStep = scenario.steps.at(-1);
    return {
      name: scenario.name,
      primary: scenario.primary,
      completedStepCount: scenario.steps.filter((step) => step.status === 'completed' || step.status === 'error').length,
      summaryChars: summary?.length ?? 0,
      estimatedTokens: estimateTokens(summary ?? ''),
      sectionCount,
      containsLatestStep: Boolean(lastStep && summary?.includes(`${lastStep.label} (${lastStep.toolName}) [${lastStep.status}]`)),
      containsErrorText: scenario.steps.some((step) => step.status === 'error')
        ? scenario.steps.filter((step) => step.status === 'error').every((step) => summary?.includes(step.errorText ?? '') ?? false)
        : true,
      summaryPreview: summary ? summary.slice(0, 400) : null,
    };
  });

  const output = {
    benchmark: 'tool-context-carry-forward',
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