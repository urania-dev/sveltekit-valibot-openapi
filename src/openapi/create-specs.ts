import type { BaseIssue, BaseSchema } from 'valibot';

import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

import type {
  EndpointDef,
  EndpointResponses,
  GlobModules,
  HttpMethodLower,
  JsonSchema,
  MultiEndpointModule,
  OpenApiMediaTypeObject,
  OpenApiOptions,
  OpenApiParameterObject,
  OpenApiResponsesObject,
  OpenApiSpec,
  OperationObject,
  PathsObject,
  ResponseDef
} from './types.ts';

/**
 * Convenience alias for “any Valibot schema”.
 */
type AnySchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>;
/**
 * Converts a Valibot query schema into an array of OpenAPI `parameters`
 * in the `in: "query"` location.
 *
 * The function expects an object-shaped schema. Each top-level property is
 * turned into a separate parameter. Supported parameter schema types are:
 *
 * - string
 * - number / integer
 * - boolean
 * - enum
 *
 * Optional properties become `required: false`; required properties are
 * listed with `required: true` in the OpenAPI output.
 */
export function convertQueryToParameters(
  schema: unknown
): OpenApiParameterObject[] {
  const raw = toCleanJsonSchema(schema, 'input');

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const obj = raw as Exclude<JsonSchema, boolean>;

  const properties = obj.properties;
  if (!properties || typeof properties !== 'object') return [];

  const requiredList = Array.isArray(obj.required) ? obj.required : [];
  const requiredSet = new Set(requiredList);

  const supportedTypes = new Set(['boolean', 'integer', 'number', 'string']);

  const params: OpenApiParameterObject[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== 'object') continue;

    const typed = propSchema as Exclude<JsonSchema, boolean>;
    const typeField = typed.type;
    const enumField = typed.enum;

    const types = Array.isArray(typeField)
      ? typeField
      : typeField
      ? [typeField]
      : [];

    const hasSupportedType = types.some((t) => supportedTypes.has(t));
    const hasEnum =
      Array.isArray(enumField) &&
      enumField.length > 0 &&
      enumField.every(
        (v) =>
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          v === null
      );

    if (!hasSupportedType && !hasEnum) continue;

    params.push({
      in: 'query',
      name,
      required: requiredSet.has(name),
      schema: typed
    });
  }

  return params;
}

/**
 * Transforms an endpoint’s response definitions into the OpenAPI
 * `responses` structure.
 *
 * Each response may provide either:
 * - a single `schema` (treated as `application/json`), or
 * - a `content` map of `mediaType → Valibot schema`, or
 * - both (in which case `schema` is used as a fallback `application/json`
 *   content if that media type is not already defined).
 *
 * This allows modeling multiple media types per status code, including
 * JSON, plain text, binary formats, etc.
 */
export function convertResponses(
  responses: EndpointResponses
): OpenApiResponsesObject {
  const out: OpenApiResponsesObject = {};

  for (const [status, def] of Object.entries(
    responses
  ) as Array<[string, ResponseDef]>) {
    const base: OpenApiResponsesObject[string] = {
      description: def.description ?? ''
    };

    let content: Record<string, OpenApiMediaTypeObject> | undefined;

    if (def.content) {
      const converted = convertContentMap(
        def.content as Record<string, unknown>,
        'output'
      );
      if (Object.keys(converted).length > 0) {
        content = { ...(content ?? {}), ...converted };
      }
    }

    if (def.schema) {
      // If a single schema is provided and `application/json` is not already
      // defined via `content`, add it as a JSON response.
      const hasJson =
        content && Object.prototype.hasOwnProperty.call(content, 'application/json');

      if (!hasJson) {
        const jsonSchema = toCleanJsonSchema(def.schema, 'output');
        content = {
          ...(content ?? {}),
          'application/json': { schema: jsonSchema }
        };
      }
    }

    if (content && Object.keys(content).length > 0) {
      base.content = content;
    }

    out[status] = base;
  }

  return out;
}

/**
 * Generates an OpenAPI 3.1 specification object for all routes matched by an
 * `import.meta.glob` call.
 *
 * This helper collects endpoint metadata from the provided modules and
 * returns a Promise resolving to a complete `OpenApiSpec` object.
 *
 * The function is framework-agnostic: you can use the resulting spec in
 * SvelteKit, Express, Astro, a CLI tool, etc. All you need is a map of
 * modules that expose `_openapi` endpoint definitions.
 *
 * To expose the spec over HTTP in SvelteKit, call this function from a GET
 * handler and return the result as JSON, for example:
 *
 *   import { json } from '@sveltejs/kit';
 *
 *   export async function GET() {
 *     const spec = await createOpenApiSpec(
 *       import.meta.glob('../api/**\/+server.{ts,js}'),
 *       options
 *     );
 *
 *     return json(spec);
 *   }
 *
 * @param modules  Glob-imported API route modules
 * @param options  Optional OpenAPI metadata (title, version, servers, auth)
 * @returns        A Promise resolving to an `OpenApiSpec` object
 */
export async function createOpenApiSpec<
  TEndpoint extends EndpointDef = EndpointDef
>(
  modules: GlobModules<TEndpoint>,
  options: OpenApiOptions = {}
): Promise<OpenApiSpec> {
  return await (async () => {
    const paths: PathsObject = {};

    for (const [file, loader] of Object.entries(modules)) {
      const loaded = await loader();
      const module = await unwrapModule<TEndpoint>(loaded);

      if (!module || !module._openapi) continue;

      for (const [, def] of Object.entries(module._openapi)) {
        if (!def) continue;

        const path = def.path ?? inferPathFromFile(file);
        if (options.basePath && !path.startsWith(options.basePath)) continue;

        const lower = toLowerHttpMethod(def.method);
        if (!paths[path]) paths[path] = {};

        const operation: OperationObject = {
          description: def.description,
          operationId: def.operationId,
          responses: convertResponses(def.responses),
          summary: def.summary,
          tags: def.tags
        };

        // Operation-level deprecation flag
        if (def.deprecated !== undefined) {
          operation.deprecated = def.deprecated;
        }

        // Attach per-operation security if defined; otherwise fall back to
        // the default top-level security from `OpenApiOptions`.
        const security = def.security ?? options.security;
        if (security && security.length > 0) {
          operation.security = security;
        }

        // Infer `in: "path"` parameters from the OpenAPI path string.
        const pathParams = inferPathParamsFromPath(path);

        // Generate query parameters (if a query schema is provided).
        const queryParams = def.query
          ? convertQueryToParameters(def.query)
          : [];

        const allParams: OpenApiParameterObject[] = [];

        if (pathParams.length > 0) {
          allParams.push(...pathParams);
        }
        if (queryParams.length > 0) {
          allParams.push(...queryParams);
        }

        if (allParams.length > 0) {
          operation.parameters = allParams;
        }

        // Generate request body for either a single schema or a multi-media
        // `content` map.
        if (def.body) {
          // Multi-media `content` map form
          if (
            typeof def.body === 'object' &&
            def.body !== null &&
            'content' in def.body
          ) {
            const { content: contentMap, required } = def.body as {
              content?: Record<string, unknown>;
              required?: boolean;
            };

            if (contentMap && Object.keys(contentMap).length > 0) {
              const content = convertContentMap(contentMap, 'input');
              if (Object.keys(content).length > 0) {
                operation.requestBody = {
                  ...(required !== undefined ? { required } : {}),
                  content
                };
              }
            }
          } else {
            // Single JSON schema convenience form → always treated as required
            const schema = toCleanJsonSchema(def.body, 'input');
            operation.requestBody = {
              content: {
                'application/json': { schema }
              },
              required: true
            };
          }
        }

        paths[path]![lower] = operation;
      }
    }

    const info: OpenApiSpec['info'] = {
      title: options.info?.title ?? 'SvelteKit API',
      version: options.info?.version ?? '1.0.0',
      ...(options.info?.description
        ? { description: options.info.description }
        : {})
    };

    const spec: OpenApiSpec = {
      info,
      openapi: '3.1.0',
      paths,
      ...(options.servers ? { servers: options.servers } : {}),
      ...(options.securitySchemes
        ? {
            components: {
              securitySchemes: options.securitySchemes
            }
          }
        : {}),
      ...(options.security ? { security: options.security } : {})
    };

    return spec
  })();
}

/**
 * Infers an OpenAPI path from a file path of a SvelteKit +server route module.
 *
 * Assumptions:
 * - Your route modules live somewhere under a “routes base” directory (e.g. "/src/routes").
 * - The file path passed in is the Vite module ID from `import.meta.glob`, e.g. "/src/routes/api/todos/[id]/+server.ts"
 *
 * How it works:
 * 1. Strips the configured baseDir prefix (default "/src/routes").
 * 2. Removes the trailing "/+server.ts" or "/+server.js" suffix.
 * 3. Converts dynamic segments like "[id]" into OpenAPI parameter notation "{id}".
 * 4. Ensures the resulting path starts with "/", or returns "/" if path is empty.
 *
 * @param file - the file path string returned by import.meta.glob
 * @param options.baseDir - optional custom base directory prefix (defaults to "/src/routes")
 * @returns OpenAPI-compatible path (e.g. "/api/todos/{id}")
 */
export function inferPathFromFile(
  file: string,
  options?: { baseDir?: string }
): string {
  const baseDir = options?.baseDir ?? '/src/routes';

  let path = file;

  if (path.startsWith(baseDir)) {
    path = path.slice(baseDir.length);
  } else {
    // Warning: file path does not start with baseDir; fallback to full path
    console.warn(
      `inferPathFromFile: file path "${file}" does not start with baseDir "${baseDir}".`
    );
  }

  // Remove suffix
  path = path.replace(/\/\+server\.(ts|js)$/, '');

  // Replace dynamic segments
  path = path.replace(/\[([^\]]+)\]/g, '{$1}');

  // Guarantee leading slash
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  return path;
}

/**
 * Infers `in: "path"` parameters from an OpenAPI-style path string,
 * e.g. `/api/todos/{id}` → parameter named "id".
 *
 * Each inferred parameter:
 * - is marked `required: true` (as required by OpenAPI for path params)
 * - uses `{ type: "string" }` as a default schema
 */
export function inferPathParamsFromPath(
  path: string
): OpenApiParameterObject[] {
  const params: OpenApiParameterObject[] = [];
  const seen = new Set<string>();

  const re = /{([^}]+)}/g;
  let match: null | RegExpExecArray;

  while ((match = re.exec(path)) !== null) {
    const name = match[1]?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    params.push({
      in: 'path',
      name,
      required: true,
      schema: { type: 'string' }
    });
  }

  return params;
}

/**
 * Transforms a map of Valibot schemas keyed by media type into an OpenAPI
 * `content` object. Each schema is converted to JSON Schema using
 * `@valibot/to-json-schema` (via `toCleanJsonSchema`).
 */
function convertContentMap(
  content: Record<string, unknown>,
  typeMode: 'input' | 'output'
): Record<string, OpenApiMediaTypeObject> {
  const out: Record<string, OpenApiMediaTypeObject> = {};

  for (const [mediaType, schema] of Object.entries(content)) {
    if (!schema) continue;

    const jsonSchema = toCleanJsonSchema(schema, typeMode);
    out[mediaType] = { schema: jsonSchema };
  }

  return out;
}

/**
 * Runtime check: is this a Valibot schema object?
 */
function isValibotSchema(schema: unknown): schema is AnySchema {
  return (
    !!schema &&
    typeof schema === 'object' &&
    (schema as { kind?: unknown }).kind === 'schema'
  );
}

/**
 * Recursively normalizes a Valibot schema so that it can always be
 * converted by `@valibot/to-json-schema`.
 *
 * - Replaces any `date()` node with `string()` (good enough for OpenAPI).
 * - Removes any `never()` node:
 *   - top-level → returns `undefined`
 *   - inside objects → drops that property
 *   - inside optional/nullable → drops the whole optional field
 *
 * It does **not** mutate the original Valibot schema; whenever a change is
 * needed, it returns a new plain object with the same shape and updated
 * children.
 */
function normalizeSchema(schema: unknown): AnySchema | undefined {
  if (!isValibotSchema(schema)) {
    // Not a Valibot schema (or we can't recognize it) → return as-is.
    // This keeps behaviour identical to before for non-Valibot usages.
    return schema as AnySchema;
  }

  const base = schema as AnySchema;
  const type = (base as { type?: string }).type;

  if (!type) return base;

  // --- Leaf transforms -------------------------------------------------

  // Drop `never()` everywhere.
  if (type === 'never') {
    return undefined;
  }

  // Map `date()` → simple string schema for docs.
  if (type === 'date') {
    return v.string() as AnySchema;
  }

  // --- Containers ------------------------------------------------------

  // object({ ...entries })
  if (type === 'object') {
    const entries = (base as unknown as { entries?: Record<string, unknown> })
      .entries;

    if (!entries || typeof entries !== 'object') {
      return base;
    }

    let changed = false;
    const nextEntries: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(entries)) {
      const normalizedChild = normalizeSchema(value);

      if (normalizedChild === undefined) {
        // Property is effectively “never” → drop from object
        changed = true;
        continue;
      }

      if (normalizedChild !== value) {
        changed = true;
      }

      nextEntries[key] = normalizedChild;
    }

    if (!changed) {
      return base;
    }

    const clone: Record<string, unknown> = {
      ...base,
      entries: nextEntries
    };

    return clone as unknown as AnySchema
  }

  // array(item)
  if (type === 'array') {
    const item = (base as unknown as { item?: unknown }).item;
    if (!item) return base;

    const normalizedItem = normalizeSchema(item);

    if (!normalizedItem) {
      // array<never> is useless; for docs we loosen it so OpenAPI stays valid
      const loose = v.array(v.string());
      return loose as AnySchema;
    }

    if (normalizedItem === item) return base;

    const clone: Record<string, unknown> = {
      ...base,
      item: normalizedItem
    };

     return clone as unknown as AnySchema
  }

  // optional(wrapped) / nullable(wrapped)
  if (type === 'optional' || type === 'nullable') {
    const wrapped = (base as unknown as { wrapped?: unknown }).wrapped;
    if (!wrapped) return base;

    const normalizedWrapped = normalizeSchema(wrapped);

    if (!normalizedWrapped) {
      // optional(never) / nullable(never) → drop entirely
      return undefined;
    }

    if (normalizedWrapped === wrapped) return base;

    const clone: Record<string, unknown> = {
      ...base,
      wrapped: normalizedWrapped
    };

     return clone as unknown as AnySchema
  }

  // union([...options])
  if (type === 'union') {
    const options = (base as unknown as { options?: unknown[] }).options;
    if (!options || !Array.isArray(options)) return base;

    let changed = false;
    const nextOptions: unknown[] = [];

    for (const opt of options) {
      const normalizedOpt = normalizeSchema(opt);
      if (!normalizedOpt) {
        changed = true;
        continue;
      }
      if (normalizedOpt !== opt) changed = true;
      nextOptions.push(normalizedOpt);
    }

    if (!changed) return base;

    const clone: Record<string, unknown> = {
      ...base,
      options: nextOptions
    };

    return clone as unknown as AnySchema
  }

  // For all other schema types (string, number, boolean, literal, etc.)
  // we don't need any changes for OpenAPI purposes.
  return base;
}

/**
 * Helper to convert a Valibot schema into JSON Schema and strip the
 * top-level `$schema` keyword.
 *
 * Steps:
 * 1. Normalize the schema (remove `never`, map `date` → `string`).
 * 2. Run `@valibot/to-json-schema`.
 * 3. Strip `$schema` to avoid conflicts with OpenAPI meta-schema.
 * 4. On failure, fall back to a generic object schema while logging an error.
 */
function toCleanJsonSchema(
  schema: unknown,
  typeMode: 'input' | 'output'
): JsonSchema {
  const prepared = normalizeSchema(schema);

  if (!prepared) {
    // Entire schema collapsed to “never” → represent as an impossible schema.
    return { not: {} } as JsonSchema;
  }

  let raw: JsonSchema;

  try {
    raw = toJsonSchema(
      prepared as BaseSchema<unknown, unknown, BaseIssue<unknown>>,
      { typeMode }
    ) as JsonSchema;
  } catch (err) {
    console.error('Failed to convert Valibot schema to JSON Schema:', err);

    // Fallback: keep OpenAPI valid, even if we lose exact typing.
    return {
      description:
        'Failed to derive JSON Schema from Valibot schema. See server logs for details.',
      type: 'object'
    };
  }

  if (typeof raw === 'boolean') return raw;

  // Strip top-level $schema if present
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...rest } = raw as {
    $schema?: string;
  } & Exclude<JsonSchema, boolean>;

  return rest;
}

/**
 * Converts an uppercase HTTP method (as used in SvelteKit handlers) to the
 * lowercase format required by OpenAPI.
 */
function toLowerHttpMethod(method: EndpointDef['method']): HttpMethodLower {
  return method.toLowerCase() as HttpMethodLower;
}

/**
 * Recursively resolves modules produced by `import.meta.glob`.
 *
 * Vite and SvelteKit may return:
 * - the module object directly
 * - a function returning the module
 * - multiple nested loader functions
 *
 * This function resolves any of those forms until it reaches a module
 * containing an `_openapi` export, which holds the endpoint metadata.
 */
async function unwrapModule<TEndpoint extends EndpointDef>(
  maybe: unknown,
  depth = 0
): Promise<MultiEndpointModule<TEndpoint> | null> {
  if (depth > 5) return null;

  if (maybe && typeof maybe === 'object') {
    const obj = maybe as Record<string, unknown>;

    if (
      '_openapi' in obj &&
      obj._openapi &&
      typeof obj._openapi === 'object'
    ) {
      return {
        _openapi: obj._openapi as Partial<
          Record<EndpointDef['method'], TEndpoint>
        >
      };
    }
  }

  if (typeof maybe === 'function') {
    try {
      const next = await (maybe as () => Promise<unknown>)();
      return unwrapModule(next, depth + 1);
    } catch {
      return null;
    }
  }

  return null;
}
