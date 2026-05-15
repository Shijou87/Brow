import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const webpack = require('webpack');
const tscBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);

if (!fs.existsSync(tscBin)) {
  throw new Error(`TypeScript compiler not found at ${tscBin}`);
}

const fixtureBuilds = [
  { outDir: '.tmp-approval-description-test', entries: ['src/sidepanel/agent-runtime/approval-description.ts'] },
  { outDir: '.tmp-automation-tool-result-test', entries: ['src/sidepanel/agent-runtime/automation-tool-result.ts'] },
  { outDir: '.tmp-browser-context-cache-test', entries: ['src/sidepanel/agent-runtime/browser-context-cache.ts'] },
  { outDir: '.tmp-browser-context-layout-test', entries: ['src/sidepanel/agent-runtime/browser-context-layout.ts'] },
  { outDir: '.tmp-browser-key-retry-test', entries: ['src/sidepanel/tab-tools/browser-key-retry.ts'] },
  { outDir: '.tmp-click-intent-guards-test', entries: ['src/sidepanel/tab-tools/click-intent-guards.ts'] },
  {
    outDir: '.tmp-combobox-context-test',
    entries: [
      'src/shared/combobox-state.ts',
      'src/sidepanel/agent-runtime/tool-result-snapshot.ts',
    ],
  },
  {
    outDir: '.tmp-context-tab-selection-test',
    entries: ['src/sidepanel/agent-runtime/context-tab-selection.ts'],
    aliases: [['sidepanel/agent-runtime/context-tab-selection.js', 'context-tab-selection.js']],
  },
  { outDir: '.tmp-domain-memory-test', entries: ['src/sidepanel/domain-memory.ts'] },
  {
    outDir: '.tmp-form-fill-behavior-test',
    entries: ['src/sidepanel/tab-tools/form-fill-behavior.ts'],
    aliases: [['sidepanel/tab-tools/form-fill-behavior.js', 'form-fill-behavior.js']],
  },
  { outDir: '.tmp-form-snapshot-priority-test', entries: ['src/content-script/form-snapshot-priority.ts'] },
  {
    outDir: '.tmp-live-stream-test',
    entries: ['src/sidepanel/agent-runtime/live-stream.ts'],
    aliases: [['sidepanel/agent-runtime/live-stream.js', 'live-stream.js']],
  },
  { outDir: '.tmp-message-format-test', entries: ['src/sidepanel/message-format.ts'] },
  {
    outDir: '.tmp-navigation-scenarios-test',
    entries: ['src/shared/navigation-test-scenarios.ts'],
    aliases: [['shared/navigation-test-scenarios.js', 'navigation-test-scenarios.js']],
  },
  {
    outDir: '.tmp-openai-tool-schema-test',
    entries: ['src/sidepanel/agent-tools/browser-tool-schemas.ts'],
    aliases: [
      ['sidepanel/agent-tools/browser-tool-schemas.js', 'browser-tool-schemas.js'],
      ['sidepanel/agent-tools/input-schemas.js', 'input-schemas.js'],
    ],
  },
  { outDir: '.tmp-page-automation-click-test', entries: ['src/sidepanel/tab-tools/page-automation.ts'] },
  {
    outDir: '.tmp-page-automation-injection-test',
    entries: [
      'src/sidepanel/tab-tools/page-automation.ts',
      'src/sidepanel/tab-tools/page-automation/runtime/runtime-install.ts',
    ],
  },
  {
    outDir: '.tmp-request-context-debug-test',
    entries: ['src/sidepanel/agent-runtime/request-context-debug.ts'],
    aliases: [['sidepanel/agent-runtime/request-context-debug.js', 'request-context-debug.js']],
  },
  {
    outDir: '.tmp-selector-locators-test',
    entries: ['src/sidepanel/tab-tools/selector-locators.ts'],
    aliases: [['sidepanel/tab-tools/selector-locators.js', 'selector-locators.js']],
  },
  {
    outDir: '.tmp-system-prompt-guidance-test',
    entries: ['src/shared/config.ts'],
    aliases: [['shared/config.js', 'config.js']],
  },
  { outDir: '.tmp-tool-classification-test', entries: ['src/sidepanel/agent-runtime/tool-classification.ts'] },
  { outDir: '.tmp-tool-context-carry-forward-test', entries: ['src/sidepanel/agent-runtime/tool-context-carry-forward.ts'] },
  { outDir: '.tmp-tool-result-shape-test', entries: ['src/sidepanel/agent-runtime/tool-result-snapshot.ts'] },
  {
    outDir: '.tmp-type-target-selection-test',
    entries: ['src/sidepanel/tab-tools/type-target-selection.ts'],
    aliases: [['sidepanel/tab-tools/type-target-selection.js', 'type-target-selection.js']],
  },
  {
    outDir: '.tmp-ui-format-test',
    entries: ['src/sidepanel/chat-view/ui-format.ts'],
  },
  {
    outDir: '.tmp-untrusted-context-test',
    entries: [
      'src/sidepanel/agent-runtime/prompt.ts',
      'src/sidepanel/agent-runtime/untrusted-context.ts',
    ],
  },
  { outDir: '.tmp-webmcp-aftermath-test', entries: ['src/sidepanel/webmcp-tool-factory.ts'] },
  {
    outDir: '.tmp-workflow-demo-context-test',
    entries: [
      'src/shared/workflow-demonstration/context-format.ts',
      'src/sidepanel/agent-runtime/prompt.ts',
    ],
  },
];

for (const build of fixtureBuilds) {
  const outDir = path.join(repoRoot, build.outDir);
  fs.rmSync(outDir, { recursive: true, force: true });

  execFileSync(tscBin, [
    ...build.entries,
    '--outDir',
    outDir,
    '--rootDir',
    'src',
    '--module',
    'commonjs',
    '--target',
    'es2020',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--resolveJsonModule',
    '--lib',
    'ES2020,DOM,DOM.Iterable',
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  for (const [from, to] of build.aliases ?? []) {
    const sourcePath = path.join(outDir, from);
    const targetPath = path.join(outDir, to);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

await new Promise((resolve, reject) => {
  const compiler = webpack({
    mode: 'development',
    context: repoRoot,
    entry: './src/sidepanel/tab-tools/page-automation/runtime-entry.ts',
    output: {
      path: path.join(repoRoot, '.tmp-page-automation-injection-test'),
      filename: 'page-automation-runtime.js',
      clean: false,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    devtool: false,
  });
  compiler.run((error, stats) => {
    const finish = (err) => {
      compiler.close(() => {
        if (err) reject(err);
        else resolve();
      });
    };
    if (error) {
      finish(error);
      return;
    }
    if (stats?.hasErrors()) {
      finish(new Error(stats.toString({ colors: false })));
      return;
    }
    finish(undefined);
  });
});
