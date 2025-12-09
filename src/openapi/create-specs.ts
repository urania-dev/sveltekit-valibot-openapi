import type { BaseIssue, BaseSchema, BaseSchemaAsync } from 'valibot';

import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

import type {
	AnySchema,
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
	QueryParameterDocs,
	ResponseDef
} from './types.ts';

import { getLogger, setOpenApiLogger, shortenFilePath } from './logger.js';
import {
	assertValibotSchema,
	hasWrapped,
	isValibotSchema,
	isValidMediaType,
	sanitizeOpenApiModule,
	VALIBOT_SUPPORTED_TYPES
} from './validation.js';

const schemaCache = new WeakMap<object, JsonSchema>();
const normalizedSchemaCache = new WeakMap<object, AnySchema | undefined>();
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_UNION_OPTIONS = 32;
const MAX_ARRAY_NESTING = 16;

interface SchemaTraversalBudget {
	arrayDepth: number;
	depth: number;
	nodeCount: number;
}

/**
 * Converts a Valibot object schema into OpenAPI `in: "query"` parameters.
 *
 * - Each *top-level* property becomes one OpenAPI parameter. Nested objects
 *   are intentionally ignored: query parameters are flat by design.
 *
 * - Required → `required: true`.
 * - Supported scalar types for direct conversion:
 *     string, number, integer, boolean
 *
 * - Enum fields produce OpenAPI `enum` arrays. Non-scalar enums are rejected.
 *
 * - If `docs` is provided, it overrides auto-generated descriptions and
 *   examples per-parameter. This allows a schema to remain purely technical
 *   while documentation stays human-readable.
 *
 * - If the input is not an object schema (e.g., a union, array, pipe),
 *   the function returns an empty array: query parameters must map 1:1
 *   with object properties, not arbitrary shapes.
 *
 * Output is deterministic: no ordering side-effects.
 */
export function convertQueryToParameters(
	schema: unknown,
	docs?: QueryParameterDocs
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

		const types = Array.isArray(typeField) ? typeField : typeField ? [typeField] : [];

		const hasSupportedType = types.some((t) => supportedTypes.has(t));
		const hasEnum =
			Array.isArray(enumField) &&
			enumField.length > 0 &&
			enumField.every(
				(v) =>
					typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
			);

		if (!hasSupportedType && !hasEnum) continue;

		const param: OpenApiParameterObject = {
			in: 'query',
			name,
			required: requiredSet.has(name),
			schema: typed
		};

		const override = docs?.[name];
		if (override) {
			if (override.description !== undefined) {
				param.description = override.description;
			}
			if (override.example !== undefined) {
				param.example = override.example;
			}
			if (override.examples !== undefined) {
				param.examples = override.examples;
			}
		}

		params.push(param);
	}

	return params;
}

/**
 * Converts endpoint response definitions into an OpenAPI 3.1 `responses` object.
 *
 * ResponseDef rules:
 * - You may define *either*:
 *     { content: { "media/type": schema, ... } }
 *   or
 *     { schema: someValibotSchema }
 *   or both.
 *
 * - If both exist:
 *     - `content` takes priority.
 *     - `schema` acts only as a fallback for `application/json` when
 *       `content["application/json"]` is missing.
 *
 * - Each schema is normalized, validated, and converted. Unsupported
 *   media types throw immediately — this prevents silently wrong specs.
 *
 * - The final shape is strictly OpenAPI: no Valibot-specific metadata leaks,
 *   no `$schema` keyword, no transforms.
 */
export function convertResponses(responses: EndpointResponses): OpenApiResponsesObject {
	const out: OpenApiResponsesObject = {};

	for (const [status, def] of Object.entries(responses) as Array<[string, ResponseDef]>) {
		const base: OpenApiResponsesObject[string] = {
			description: def.description ?? ''
		};

		let content: Record<string, OpenApiMediaTypeObject> | undefined;

		if (def.content) {
			const converted = convertContentMap(def.content as Record<string, unknown>, 'output');
			if (Object.keys(converted).length > 0) {
				content = { ...(content ?? {}), ...converted };
			}
		}

		if (def.schema) {
			const hasJson = content && Object.prototype.hasOwnProperty.call(content, 'application/json');

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
 * Responsibilities:
 * - Load arbitrary module shapes from Vite/SK (`object`, `function`, nested loaders).
 * - Extract `_openapi` metadata from each module. Modules without `_openapi`
 *   are ignored without complaint.
 *
 * - Build the OpenAPI `paths` table:
 *     routes → methods → operations
 *
 * - Infer path parameters (`{id}`) and convert them.
 * - Convert query parameters.
 * - Normalize request bodies (content map or shorthand schema).
 * - Convert all response schemas.
 *
 * - Security is merged from:
 *     - endpoint-level `security`
 *     - global `options.security`
 *
 * - Produces a fully spec-compliant OpenAPI 3.1 document usable by Scalar,
 *   Redoc, Swagger UI, and generators.
 *
 *
 * This function performs *documentation conversion*, not runtime validation:
 * it will not execute async Valibot transforms, only document their structure.
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
export async function createOpenApiSpec<TEndpoint extends EndpointDef = EndpointDef>(
	modules: GlobModules,
	options: OpenApiOptions = {}
): Promise<OpenApiSpec> {
	if (options.logger) {
		setOpenApiLogger(options.logger);
	}

	const paths: PathsObject = {};
	const logger = getLogger();

	for (const [file, loader] of Object.entries(modules)) {
		const loaded = await loader();
		const module = await unwrapModule<TEndpoint>(loaded);

		if (!module || !module._openapi) continue;

		for (const [method, def] of Object.entries(module._openapi) as Array<
			[string, TEndpoint | undefined]
		>) {
			if (!def) continue;

			try {
				const path = def.path ?? inferPathFromFile(file);
				if (options.basePath && !path.startsWith(options.basePath)) continue;

				const lower = toLowerHttpMethod(def.method);
				if (!paths[path]) paths[path] = {};

				const operation: OperationObject = {
					description: def.description,
					operationId: def.operationId,
					responses: convertResponses(def.responses as EndpointResponses),
					summary: def.summary,
					tags: def.tags
				};

				if (def.deprecated !== undefined) {
					operation.deprecated = def.deprecated;
				}

				const security = def.security ?? options.security;
				if (security && security.length > 0) {
					operation.security = security;
				}

				const pathParams = inferPathParamsFromPath(path);

				const queryParams = def.query
					? convertQueryToParameters(def.query, def.queryParams as QueryParameterDocs | undefined)
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

				if (def.body) {
					if (typeof def.body === 'object' && def.body !== null && 'content' in def.body) {
						const {
							content: contentMap,
							description,
							required
						} = def.body as {
							content?: Record<string, unknown>;
							description?: string;
							required?: boolean;
						};

						if (contentMap && Object.keys(contentMap).length > 0) {
							const content = convertContentMap(contentMap, 'input');
							if (Object.keys(content).length > 0) {
								operation.requestBody = {
									...(description !== undefined ? { description } : {}),
									...(required !== undefined ? { required } : {}),
									content
								};
							}
						}
					} else {
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
			} catch (err) {
				const context = {
					file: shortenFilePath(file),
					message: err instanceof Error ? err.message : String(err),
					method
				};

				logger.error(
					'[openapi] Failed to build OpenAPI operation from endpoint definition',
					context
				);

				continue;
			}
		}
	}

	const info: OpenApiSpec['info'] = {
		title: options.info?.title ?? 'SvelteKit API',
		version: options.info?.version ?? '1.0.0',
		...(options.info?.description ? { description: options.info.description } : {})
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

	return spec;
}

/**
 * inferPathFromFile:
 *
 * Converts a filesystem route path like:
 *   "/src/routes/api/users/[id]/+server.ts"
 * to:
 *   "/api/users/{id}"
 *
 * Steps:
 * 1. Strip baseDir (default `/src/routes`). If the file is outside this root,
 *    log a warning — means the user misconfigured glob or baseDir.
 *
 * 2. Remove the "+server.ts|js" suffix — endpoint files produce HTTP verbs.
 *
 * 3. Replace SvelteKit `[id]` with OpenAPI `{id}`. Only the syntactic change.
 *    Validation of the parameter type happens elsewhere.
 *
 * 4. Guarantee leading slash.
 *
 * Assumptions:
 * - File paths come from `import.meta.glob`, so they’re absolute or rooted.
 * - No attempt is made to understand nested `+page.server` semantics.

* @param file - the file path string returned by import.meta.glob
 * @param options.baseDir - optional custom base directory prefix (defaults to "/src/routes")
 * @returns OpenAPI-compatible path (e.g. "/api/todos/{id}")
 */
export function inferPathFromFile(file: string, options?: { baseDir?: string }): string {
	const baseDir = options?.baseDir ?? '/src/routes';

	let path = file;

	if (path.startsWith(baseDir)) {
		path = path.slice(baseDir.length);
	} else {
		getLogger().warn(
			'[openapi] inferPathFromFile: file path does not start with configured baseDir.',
			{ baseDir, file: shortenFilePath(file) }
		);
	}

	path = path.replace(/\/\+server\.(ts|js)$/, '');
	path = path.replace(/\[([^\]]+)\]/g, '{$1}');

	if (!path.startsWith('/')) {
		path = `/${path}`;
	}

	return path;
}

/**
 * Extracts all `{param}` segments from a final OpenAPI path.
 *
 * Rules:
 * - All path params are `required: true` (OpenAPI mandate).
 * - All are typed `string` — OpenAPI path parameters are always text; if
 *   further typing is desired, you document it but cannot enforce coercion.
 *
 * - Duplicate param names (e.g., erroneous `{id}/{id}`) are ignored after
 *   the first occurrence.
 *
 * - Does *not* validate naming conventions. If the user names `{user-id}`,
 *   that is passed through exactly.
 */
export function inferPathParamsFromPath(path: string): OpenApiParameterObject[] {
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
 * Converts a record:
 *   { "media/type": valibotSchema, ... }
 * into OpenAPI content entries:
 *   { "media/type": { schema: JSONSchema } }
 *
 * Strict rules:
 * - Media types must be syntactically valid. No silent fallback.
 * - Each schema is validated as a Valibot schema; invalid inputs trigger a
 *   precise error pointing to the offending media type.
 *
 * - Normalisation includes async → sync stripping, date → string, removing
 *   `never`, and budget checks (node count, depth).
 *
 * - Output is deterministic; ordering matches Object.entries ordering.
 */
function convertContentMap(
	content: Record<string, unknown>,
	typeMode: 'input' | 'output'
): Record<string, OpenApiMediaTypeObject> {
	const out: Record<string, OpenApiMediaTypeObject> = {};

	for (const [mediaType, schema] of Object.entries(content)) {
		if (typeof mediaType !== 'string' || !isValidMediaType(mediaType)) {
			throw new Error(`[openapi] Invalid media type: "${mediaType}"`);
		}
		if (!schema) continue;

		assertValibotSchema(schema, `content["${mediaType}"]`);

		const jsonSchema = toCleanJsonSchema(schema, typeMode);
		out[mediaType] = { schema: jsonSchema };
	}

	return out;
}

/**
 * Detects if a Valibot schema is async (`schema.async === true`).
 */
function isAsyncSchema(
	schema: unknown
): schema is BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>> {
	if (!isValibotSchema(schema)) return false;

	const s = schema as { async?: unknown };
	return s.async === true;
}

/**
 * normalizeAsync:
 *
 * Valibot async schemas cannot be converted by @valibot/to-json-schema.
 * They often wrap fully static structure behind async transforms, so the
 * correct approach is to *erase async behavior* while keeping the shape.
 *
 * What this does:
 * - objectAsync → object
 * - arrayAsync → array
 * - unionAsync → union
 * - optionalAsync / nullableAsync → optional / nullable
 * - pipeAsync → unwrap to inner schema
 *
 * What this does NOT do:
 * - execute async logic
 * - preserve async transformation semantics
 * - evaluate default values or server-side validation rules
 *
 */
function normalizeAsync(
	_schema: unknown,
	depth = 0
): BaseSchema<unknown, unknown, BaseIssue<unknown>> {
	if (!isAsyncSchema(_schema)) {
		return _schema as BaseSchema<unknown, unknown, BaseIssue<unknown>>;
	}

	if (depth > MAX_SCHEMA_DEPTH) {
		return v.object({}) as BaseSchema<unknown, unknown, BaseIssue<unknown>>;
	}

	const schema = _schema as BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>;
	const { type } = schema;

	if (type === 'object') {
		const entries =
			('entries' in schema && (schema as { entries?: Record<string, unknown> }).entries) || {};
		const converted: Record<string, BaseSchema<unknown, unknown, BaseIssue<unknown>>> = {};

		for (const [k, vSchema] of Object.entries(entries)) {
			converted[k] = normalizeAsync(vSchema, depth + 1);
		}
		return v.object(converted) as BaseSchema<unknown, unknown, BaseIssue<unknown>>;
	}

	if (type === 'array' && 'item' in schema) {
		const item = (schema as { item?: unknown }).item;
		return v.array(normalizeAsync(item, depth + 1)) as BaseSchema<
			unknown,
			unknown,
			BaseIssue<unknown>
		>;
	}

	if (type === 'optional' && 'wrapped' in schema) {
		const wrapped = (schema as { wrapped?: unknown }).wrapped;
		return v.optional(normalizeAsync(wrapped, depth + 1)) as BaseSchema<
			unknown,
			unknown,
			BaseIssue<unknown>
		>;
	}

	if (type === 'nullable' && 'wrapped' in schema) {
		const wrapped = (schema as { wrapped?: unknown }).wrapped;
		return v.nullable(normalizeAsync(wrapped, depth + 1)) as BaseSchema<
			unknown,
			unknown,
			BaseIssue<unknown>
		>;
	}

	if (type === 'union' && 'options' in schema) {
		const options = (schema as { options?: unknown[] }).options ?? [];
		const normalized = options.map((o) => normalizeAsync(o, depth + 1));
		return v.union(normalized) as BaseSchema<unknown, unknown, BaseIssue<unknown>>;
	}

	if (type === 'pipe') {
		const inner =
			('inner' in schema && (schema as { inner?: unknown }).inner) ??
			('value' in schema && (schema as { value?: unknown }).value) ??
			schema;

		return normalizeAsync(inner, depth + 1);
	}

	return schema as unknown as BaseSchema<unknown, unknown, BaseIssue<unknown>>;
}

/**
 * Deep structural normalization for Valibot → JSON Schema conversion.
 *
 * Enforces global safety constraints:
 * - MAX_SCHEMA_NODES: prevents memory bombs and pathological recursion.
 * - MAX_SCHEMA_DEPTH: prevents infinite cycles or excessively nested shapes.
 * - MAX_OBJECT_PROPERTIES: prevents schema explosion.
 * - MAX_ARRAY_NESTING: OpenAPI tools choke on unbounded nested arrays.
 * - MAX_UNION_OPTIONS: unions must stay enumerable.
 *
 * Behavior:
 * - Async schemas → sync via normalizeAsync.
 * - Unsupported Valibot types throw immediately with explicit messages.
 *
 * - `date()` is mapped to `string()` strictly — OpenAPI has no native date
 *   primitive; users must apply format manually if desired.
 *
 * - `never()` is treated as "not documentable". At top-level → fail. Inside
 *   objects → property removed. Inside wrappers → wrapper is removed.
 *
 * - The function is *structurally persistent*: if children do not change,
 *   original nodes are cached and reused. Reduces JSON-schema churn and
 *   respects Valibot object identity.
 *
 * - Returns `undefined` when a node is fundamentally non-documentable,
 *   forcing callers to reject the schema rather than silently emitting
 *   garbage.
 */
function normalizeSchema(schema: unknown, budget: SchemaTraversalBudget): AnySchema | undefined {
	if (budget.nodeCount++ > MAX_SCHEMA_NODES) {
		throw new Error('[openapi] Schema node limit exceeded');
	}
	if (budget.depth > MAX_SCHEMA_DEPTH) {
		throw new Error('[openapi] Schema depth limit exceeded');
	}

	if (isAsyncSchema(schema)) {
		schema = normalizeAsync(schema, budget.depth);
	}

	if (!isValibotSchema(schema)) return undefined;

	const key = schema as object;
	const cached = normalizedSchemaCache.get(key);
	if (cached !== undefined) return cached;

	const base = schema as AnySchema;
	const type = (base as { type?: string }).type;
	if (!type || !VALIBOT_SUPPORTED_TYPES.has(type)) {
		throw new Error(`[openapi] Unsupported Valibot schema type "${type ?? 'unknown'}"`);
	}

	if (type === 'date') {
		const mapped = v.string() as AnySchema;
		normalizedSchemaCache.set(key, mapped);
		return mapped;
	}

	if (type === 'never') {
		normalizedSchemaCache.set(key, undefined);
		return undefined;
	}
if (type === 'optional' || type === 'nullable') {
  if (!hasWrapped(base)) {
    normalizedSchemaCache.set(key, undefined);
    return undefined;
  }

  const norm = normalizeSchema(base.wrapped, {
    ...budget,
    depth: budget.depth + 1
  });

  if (!norm) {
    normalizedSchemaCache.set(key, undefined);
    return undefined;
  }

  if (norm === base.wrapped) {
    normalizedSchemaCache.set(key, base);
    return base;
  }

  const clone = { ...base, wrapped: norm } 
  normalizedSchemaCache.set(key, clone);
  return clone;
}


// PIPE WRAPPER
if (type === 'pipe') {
  const inner =
    (base as { inner?: unknown }).inner ??
    (base as { value?: unknown }).value;

  if (!inner) {
    normalizedSchemaCache.set(key, undefined);
    return undefined;
  }

  const norm = normalizeSchema(inner, {
    ...budget,
    depth: budget.depth + 1
  });

  if (!norm) {
    normalizedSchemaCache.set(key, undefined);
    return undefined;
  }

  normalizedSchemaCache.set(key, norm);
  return norm;
}
	if (type === 'object') {
		const entries = (base as { entries?: Record<string, unknown> }).entries;
		if (!entries || typeof entries !== 'object') {
			throw new Error('[openapi] object schema missing entries');
		}

		const nextEntries: Record<string, unknown> = {};
		const keys = Object.keys(entries);
		if (keys.length > MAX_OBJECT_PROPERTIES) {
			throw new Error('[openapi] object schema has too many properties');
		}

		let changed = false;
		for (const [keyName, value] of Object.entries(entries)) {
			const child = normalizeSchema(value, {
				...budget,
				depth: budget.depth + 1
			});
			if (!child) {
				changed = true;
				continue;
			}
			if (child !== value) changed = true;
			nextEntries[keyName] = child;
		}

		if (!changed) {
			normalizedSchemaCache.set(key, base);
			return base;
		}

		const clone = {
			...base,
			entries: nextEntries
		} as unknown as AnySchema;

		normalizedSchemaCache.set(key, clone);
		return clone;
	}

	if (type === 'array') {
		if (budget.arrayDepth > MAX_ARRAY_NESTING) {
			throw new Error('[openapi] array nesting depth exceeded');
		}

		const item = (base as { item?: unknown }).item;
		if (!item) {
			throw new Error('[openapi] array schema missing item');
		}

		const normalizedItem = normalizeSchema(item, {
			...budget,
			arrayDepth: budget.arrayDepth + 1,
			depth: budget.depth + 1
		});

		if (!normalizedItem) {
			normalizedSchemaCache.set(key, undefined);
			return undefined;
		}

		if (normalizedItem === item) {
			normalizedSchemaCache.set(key, base);
			return base;
		}

		const clone = {
			...base,
			item: normalizedItem
		} as unknown as AnySchema;

		normalizedSchemaCache.set(key, clone);
		return clone;
	}

	if (type === 'union') {
		const options = (base as { options?: unknown[] }).options;
		if (!options || !Array.isArray(options)) {
			throw new Error('[openapi] union schema missing options');
		}
		if (options.length > MAX_UNION_OPTIONS) {
			throw new Error('[openapi] union schema has too many options');
		}

		let changed = false;
		const nextOptions: unknown[] = [];

		for (const opt of options) {
			const child = normalizeSchema(opt, {
				...budget,
				depth: budget.depth + 1
			});
			if (!child) {
				changed = true;
				continue;
			}
			if (child !== opt) changed = true;
			nextOptions.push(child);
		}
		if (nextOptions.length === 0) {
			normalizedSchemaCache.set(key, undefined);
			return undefined;
		}
		if (!changed) {
			normalizedSchemaCache.set(key, base);
			return base;
		}

		const clone = {
			...base,
			options: nextOptions
		} as unknown as AnySchema;

		normalizedSchemaCache.set(key, clone);
		return clone;
	}

	normalizedSchemaCache.set(key, base);
	return base;
}

/**
 * Final conversion pipeline from Valibot → OpenAPI JSON Schema.
 *
 * Pipeline:
 * 1. normalizeSchema: sanitize shape, enforce budgets, remove async/never.
 * 2. toJsonSchema: call Valibot's converter (throws on errors).
 * 3. Strip `$schema` to avoid OpenAPI meta-schema conflict.
 * 4. Cache final JSON to avoid repeated heavy conversions.
 *
 * Failure semantics:
 * - Logs the *originating* error message (not a generic one).
 * - Throws immediately; no fallback to an "any" schema or loose object.
 *
 * TypeMode:
 * - `"input"` vs `"output"` passes through to @valibot/to-json-schema so
 *   required/optional logic is correct for the direction.
 *
 * Guarantee:
 * - Output is always OpenAPI-compatible JSON Schema.
 * - Never returns Valibot-specific annotation.
 */
function toCleanJsonSchema(schema: unknown, typeMode: 'input' | 'output'): JsonSchema {
	const budget: SchemaTraversalBudget = {
		arrayDepth: 0,
		depth: 0,
		nodeCount: 0
	};

	const prepared = normalizeSchema(schema, budget);

	if (!prepared) {
		throw new Error('[openapi] Non-convertible schema encountered');
	}

	const key = prepared as object;
	const cached = schemaCache.get(key);
	if (cached) return cached;

	let raw: JsonSchema;
	try {
		raw = toJsonSchema(prepared as BaseSchema<unknown, unknown, BaseIssue<unknown>>, {
			typeMode
		}) as JsonSchema;
	} catch (err) {
		const message =
			err instanceof Error ? err.message : 'Unknown error during Valibot → JSON Schema conversion';

		getLogger().error('[openapi] Failed to convert Valibot schema to JSON Schema', {
			message,
			typeMode
		});

		throw err instanceof Error ? err : new Error(message);
	}

	if (typeof raw === 'boolean') {
		schemaCache.set(key, raw);
		return raw;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { $schema, ...rest } = raw as {
		$schema?: string;
	} & Exclude<JsonSchema, boolean>;

	schemaCache.set(key, rest);
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
 * import.meta.glob modules have inconsistent shapes:
 * - direct objects
 * - functions returning modules
 * - nested functions created by bundlers
 *
 * unwrapModule resolves until:
 * - it finds a module with a valid `_openapi` export
 * - OR it reaches depth 2 without success → null
 *
 * sanitizeOpenApiModule verifies:
 * - shape integrity
 * - no prototype pollution
 * - endpoint definitions adhere to constraints (tags, responses, method)
 *
 * The unwrap logic guarantees you never get a broken module merged into
 * your spec, preserving safety and correctness.
 */
async function unwrapModule<TEndpoint extends EndpointDef>(
	maybe: unknown,
	depth = 0
): Promise<MultiEndpointModule<TEndpoint> | null> {
	if (depth > 2) return null;

	try {
		const sanitized = sanitizeOpenApiModule((maybe ?? {}) as Record<string, unknown>);
		return sanitized as MultiEndpointModule<TEndpoint>;
	} catch {
		// not a valid _openapi module, fall through
	}

	if (typeof maybe === 'function' && maybe.length === 0) {
		const next = await (maybe as () => Promise<unknown>)();
		return unwrapModule<TEndpoint>(next, depth + 1);
	}

	return null;
}
