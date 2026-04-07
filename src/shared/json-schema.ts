import { z, type ZodTypeAny } from 'zod';

export function jsonSchemaPropertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string | undefined;

  switch (type) {
    case 'string': {
      if (Array.isArray(prop.enum)) {
        return z.enum(prop.enum as [string, ...string[]]);
      }
      return z.string();
    }
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = prop.items as Record<string, unknown> | undefined;
      return items ? z.array(jsonSchemaPropertyToZod(items)) : z.array(z.unknown());
    }
    case 'object': {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      return nested ? jsonSchemaToZod(prop) : z.record(z.unknown());
    }
    default:
      return z.unknown();
  }
}

export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<any> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || Object.keys(properties).length === 0) return z.object({});

  const requiredFields = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema);
    const description = propSchema.description as string | undefined;
    if (description) zodType = zodType.describe(description);
    if (!requiredFields.has(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }

  return z.object(shape);
}

