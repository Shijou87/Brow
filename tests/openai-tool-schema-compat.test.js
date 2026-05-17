const test = require('node:test');
const assert = require('node:assert/strict');

const { zodFunction } = require('openai/helpers/zod');

const {
  browserDragToolSchema,
  browserFillFormToolSchema,
} = require('../.tmp-openai-tool-schema-test/browser-tool-schemas.js');
const {
  jsonSchemaToZod,
  normalizeJsonSchemaParsedObject,
} = require('../.tmp-openai-tool-schema-test/json-schema.js');

function collectInvalidAdditionalProperties(schema, path = '#') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const findings = [];
  if (
    Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')
    && schema.additionalProperties !== false
  ) {
    findings.push(path);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      findings.push(...collectInvalidAdditionalProperties(value, `${path}/properties/${key}`));
    }
  }

  if (schema.items) {
    findings.push(...collectInvalidAdditionalProperties(schema.items, `${path}/items`));
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((value, index) => {
      findings.push(...collectInvalidAdditionalProperties(value, `${path}/anyOf/${index}`));
    });
  }

  if (schema.definitions && typeof schema.definitions === 'object') {
    for (const [key, value] of Object.entries(schema.definitions)) {
      findings.push(...collectInvalidAdditionalProperties(value, `${path}/definitions/${key}`));
    }
  }

  return findings;
}

function collectUnsupportedNotKeywords(schema, path = '#') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const findings = [];
  if (Object.prototype.hasOwnProperty.call(schema, 'not')) {
    findings.push(`${path}/not`);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      findings.push(...collectUnsupportedNotKeywords(value, `${path}/properties/${key}`));
    }
  }

  if (schema.items) {
    findings.push(...collectUnsupportedNotKeywords(schema.items, `${path}/items`));
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((value, index) => {
      findings.push(...collectUnsupportedNotKeywords(value, `${path}/anyOf/${index}`));
    });
  }

  if (schema.definitions && typeof schema.definitions === 'object') {
    for (const [key, value] of Object.entries(schema.definitions)) {
      findings.push(...collectUnsupportedNotKeywords(value, `${path}/definitions/${key}`));
    }
  }

  return findings;
}

function assertOpenAiCompatibleTool(name, schema, description) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));

  try {
    const toolDefinition = zodFunction({
      name,
      parameters: schema,
      description,
    });

    assert.deepEqual(
      warnings.filter((warning) => warning.includes('uses `.optional()` without `.nullable()`')),
      [],
    );
    assert.deepEqual(
      collectInvalidAdditionalProperties(toolDefinition.function.parameters),
      [],
    );
    assert.deepEqual(
      collectUnsupportedNotKeywords(toolDefinition.function.parameters),
      [],
    );
  } finally {
    console.warn = originalWarn;
  }
}

test('browser_fill_form schema stays OpenAI function-calling compatible', () => {
  assertOpenAiCompatibleTool(
    'browser_fill_form',
    browserFillFormToolSchema,
    'Fill multiple form fields by refs from browser_snapshot.',
  );
});

test('browser_drag schema stays OpenAI function-calling compatible', () => {
  assertOpenAiCompatibleTool(
    'browser_drag',
    browserDragToolSchema,
    'Drag from one visible target to another using current refs or Workflow Demonstration target evidence.',
  );
});

test('jsonSchemaToZod keeps optional MCP fields OpenAI function-calling compatible', () => {
  assertOpenAiCompatibleTool(
    'mcp_render_view',
    jsonSchemaToZod({
      type: 'object',
      properties: {
        requiredImageId: { type: 'string', description: 'Image identifier.' },
        vlmModel: { type: 'string', description: 'Optional VLM model.' },
        nested: {
          type: 'object',
          properties: {
            qualityPreset: { type: 'string', description: 'Optional quality preset.' },
          },
          required: [],
        },
      },
      required: ['requiredImageId'],
    }),
    'Render a view through an MCP tool.',
  );
});

test('normalizeJsonSchemaParsedObject strips null placeholders from optional MCP fields', () => {
  assert.deepEqual(
    normalizeJsonSchemaParsedObject({
      requiredImageId: 'img-1',
      vlmModel: null,
      nested: {
        qualityPreset: null,
        keep: 'lossless',
      },
      views: [
        { preset: null, id: 'axial' },
        null,
      ],
    }),
    {
      requiredImageId: 'img-1',
      nested: {
        keep: 'lossless',
      },
      views: [
        { id: 'axial' },
        null,
      ],
    },
  );
});