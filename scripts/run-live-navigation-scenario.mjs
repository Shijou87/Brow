#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import process from 'node:process';
import ts from 'typescript';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    list: false,
    complex: false,
    dryRun: false,
    browserContextFile: undefined,
    replayFile: undefined,
    baseUrl: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  };

  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--list') {
      options.list = true;
      continue;
    }
    if (value === '--complex') {
      options.complex = true;
      continue;
    }
    if (value === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (value === '--browser-context-file') {
      options.browserContextFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--replay-file') {
      options.replayFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--base-url') {
      options.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--api-key') {
      options.apiKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--model') {
      options.model = argv[index + 1];
      index += 1;
      continue;
    }
    positionals.push(value);
  }

  options.slug = positionals[0];
  return options;
}

async function loadJsonFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  return {
    absolutePath,
    data: JSON.parse(raw),
  };
}

async function loadTsModule(filePath, requireMap = {}) {
  const source = await fs.readFile(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
    fileName: filePath,
  });

  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
      return requireMap[specifier];
    }
    throw new Error(`Unsupported runtime require in ${path.relative(repoRoot, filePath)}: ${specifier}`);
  };

  const context = {
    module,
    exports: module.exports,
    require: localRequire,
    __filename: filePath,
    __dirname: dirname,
    console,
    process,
    URLSearchParams,
    Map,
    Set,
  };

  vm.runInNewContext(transpiled.outputText, context, { filename: filePath });
  return module.exports;
}

function buildBrowserTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Capture a DOM-derived browser snapshot for a tab. Use mode="full" when compact snapshot does not show the actionable control you need.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            mode: { type: 'string', enum: ['compact', 'full'] },
            maxElements: { type: 'number' },
            rootRef: { type: 'string' },
            snapshotId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_form_snapshot',
        description: 'Inspect whole-form semantics for a tab before filling forms. Returns forms, fields, Field Purpose, confidence/evidence, safe current value state, and refs that can be passed to browser_fill_form.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            maxFields: { type: 'number' },
            includeHidden: { type: 'boolean' },
            formRef: { type: 'string' },
            snapshotId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an actionable element by ref from browser_snapshot. Prefer this over selector-based tabs_click. Do not use this to re-click a form field whose requested value is already visible in the current snapshot; if the field is already correct, move to the real submit/search control or take a fuller snapshot. Returns a fresh snapshot after the action.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            ref: { type: 'string' },
            snapshotId: { type: 'string' },
            intent: { type: 'string' },
            postconditions: { type: 'array' },
            useActionMemory: { type: 'boolean' },
          },
          required: ['ref'],
          additionalProperties: true,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_type',
        description: 'Type text into an editable element by ref from browser_snapshot. Use this only when the field value still needs to change; if the current snapshot already shows the requested value, do not type again and instead move to the next control or take a fuller snapshot. Returns a fresh snapshot after typing.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            ref: { type: 'string' },
            text: { type: 'string' },
            submit: { type: 'boolean' },
            snapshotId: { type: 'string' },
            intent: { type: 'string' },
            postconditions: { type: 'array' },
            useActionMemory: { type: 'boolean' },
          },
          required: ['ref', 'text'],
          additionalProperties: true,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill_form',
        description: 'Fill multiple form fields by refs from browser_snapshot. Supports text inputs, contenteditable, selects, checkboxes, and radios. Returns a fresh snapshot after filling.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            fields: { type: 'array' },
            submit: { type: 'boolean' },
            submitRef: { type: 'string' },
            snapshotId: { type: 'string' },
            intent: { type: 'string' },
            postconditions: { type: 'array' },
          },
          required: ['fields'],
          additionalProperties: true,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_key',
        description: 'Press a key such as Enter on the current focused element or target element. Use this for submit/search only when the focused field is known to submit.',
        parameters: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            key: { type: 'string' },
            ref: { type: 'string' },
            snapshotId: { type: 'string' },
            intent: { type: 'string' },
            postconditions: { type: 'array' },
          },
          additionalProperties: true,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_tab',
        description: 'Create a new browser tab with the specified URL. The agent decides appropriate URLs.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            active: { type: 'boolean' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
  ];
}

function resolveBrowserTools(replayBundle) {
  const tools = buildBrowserTools();
  const allowedTools = replayBundle?.data?.allowedTools;
  if (!allowedTools) {
    return tools;
  }

  if (!Array.isArray(allowedTools) || allowedTools.some((toolName) => typeof toolName !== 'string')) {
    throw new Error('Replay bundle allowedTools must be an array of tool names.');
  }

  const allowedToolSet = new Set(allowedTools);
  const unknownToolNames = allowedTools.filter((toolName) => !tools.some((tool) => tool.function.name === toolName));
  if (unknownToolNames.length > 0) {
    throw new Error(`Replay bundle references unknown tools: ${unknownToolNames.join(', ')}`);
  }

  const filteredTools = tools.filter((tool) => allowedToolSet.has(tool.function.name));
  if (filteredTools.length === 0) {
    throw new Error('Replay bundle allowedTools filtered out every available tool.');
  }

  return filteredTools;
}

function printList(scenarios) {
  for (const scenario of scenarios) {
    console.log(`${scenario.slug}`);
    console.log(`  label: ${scenario.label}`);
    console.log(`  website: ${scenario.website}`);
    console.log(`  runMode: ${scenario.runMode}`);
    console.log(`  budget: turns<=${scenario.budget.maxTurns}, toolCalls<=${scenario.budget.maxToolCalls}, repairs<=${scenario.budget.maxRepairActions}`);
    console.log(`  prompt: ${scenario.defaultPrompt}`);
    if (scenario.complexReplayPath) {
      console.log(`  complexReplay: ${scenario.complexReplayPath}`);
    }
  }
}

function printUsage() {
  console.log('Usage: node scripts/run-live-navigation-scenario.mjs --list');
  console.log('   or: node scripts/run-live-navigation-scenario.mjs <scenario-slug> [--complex] [--replay-file path] [--browser-context-file path] [--dry-run] [--base-url url] [--api-key key] [--model model]');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const navigationScenarios = await loadTsModule(path.join(repoRoot, 'src/shared/navigation-test-scenarios.ts'));
  const htmlAppGuidance = await loadTsModule(path.join(repoRoot, 'src/shared/html-app-artifact-guidance.ts'));
  const config = await loadTsModule(path.join(repoRoot, 'src/shared/config.ts'), {
    './html-app-artifact-guidance': htmlAppGuidance,
  });
  const promptModule = await loadTsModule(
    path.join(repoRoot, 'src/sidepanel/agent-runtime/prompt.ts'),
    {
      '../../shared/html-app-artifact-guidance': htmlAppGuidance,
      '../skills-registry': {
        formatDomainSkillMatcherSummary: () => '',
      },
    },
  );

  const liveScenarios = navigationScenarios.LIVE_NAVIGATION_SCENARIOS;

  if (options.list) {
    printList(liveScenarios);
    return;
  }

  if (!options.slug) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const scenario = navigationScenarios.getLiveNavigationScenario(options.slug);
  if (!scenario) {
    console.error(`Unknown scenario slug: ${options.slug}`);
    process.exitCode = 1;
    return;
  }

  let replayBundle;
  let replayFilePath = options.replayFile;
  if (options.complex) {
    if (!scenario.complexReplayPath) {
      console.error(`Scenario ${scenario.slug} does not declare a complex replay bundle.`);
      process.exitCode = 1;
      return;
    }
    replayFilePath = scenario.complexReplayPath;
  }

  if (replayFilePath) {
    replayBundle = await loadJsonFile(replayFilePath);
  }

  if (!options.dryRun && (!options.baseUrl || !options.model)) {
    console.error('Missing --base-url/--model or OPENAI_BASE_URL/OPENAI_MODEL environment variables.');
    process.exitCode = 1;
    return;
  }

  const browserContextText = options.browserContextFile
    ? await fs.readFile(path.resolve(process.cwd(), options.browserContextFile), 'utf8')
    : undefined;

  const systemPrompt = promptModule.buildSystemPrompt({
    basePrompt: config.DEFAULT_SYSTEM_PROMPT,
    domainSkillRegistry: [],
    interactionSkillRegistry: [],
    disabledTools: new Set(),
    webmcpByTab: new Map(),
    mcpServers: [],
  });

  const messages = [{ role: 'system', content: systemPrompt }];
  if (browserContextText) messages.push({ role: 'system', content: browserContextText });
  if (replayBundle?.data?.systemMessages) {
    for (const message of replayBundle.data.systemMessages) {
      messages.push({ role: 'system', content: String(message) });
    }
  }
  if (Array.isArray(replayBundle?.data?.messages) && replayBundle.data.messages.length > 0) {
    messages.push(...replayBundle.data.messages);
  } else {
    messages.push({ role: 'user', content: scenario.defaultPrompt });
  }

  const tools = resolveBrowserTools(replayBundle);

  const requestBody = {
    model: options.model,
    temperature: 0,
    tool_choice: 'required',
    tools,
    messages,
  };

  if (options.dryRun) {
    console.log(JSON.stringify({
      scenario: scenario.slug,
      dryRun: true,
      replayFile: replayBundle?.absolutePath ?? null,
      toolNames: tools.map((tool) => tool.function.name),
      request: requestBody,
    }, null, 2));
    return;
  }

  const headers = {
    'content-type': 'application/json',
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    console.error(`Request failed: ${response.status} ${response.statusText}`);
    console.error(await response.text());
    process.exitCode = 1;
    return;
  }

  const payload = await response.json();
  const message = payload.choices?.[0]?.message;
  console.log(JSON.stringify({
    scenario: scenario.slug,
    model: options.model,
    baseUrl: options.baseUrl,
    browserContextFile: options.browserContextFile ?? null,
    replayFile: replayBundle?.absolutePath ?? null,
    toolNames: tools.map((tool) => tool.function.name),
    result: message,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
