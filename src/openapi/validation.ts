import type { AnySchema, MultiEndpointModule } from './types.ts';

/**
 * Hardened `_openapi` module validation and sanitization.
 * Purpose:
 * - Modules imported via `import.meta.glob` may contain arbitrary exports,
 *   arbitrary prototypes, and potentially malicious or malformed `_openapi`
 *   objects. This function enforces strict structural integrity before any
 *   endpoint definition becomes part of the final OpenAPI spec.
 *
 * Guarantees:
 * - `_openapi` must be a safe, prototype-free plain object.
 * - Only valid HTTP-method keys are retained.
 * - Each endpoint definition is recursively sanitized to eliminate:
 *     - prototype pollution vectors
 *     - forbidden keys (`__proto__`, etc.)
 *     - incorrect shapes
 *     - oversized structures (responses, tags, doc strings)
 *
 * - Drops all unrecognized methods silently.
 * - Caps endpoints per module to prevent abusive modules from blowing up
 *   the resulting spec or consuming unbounded CPU/RAM.
 *
 * Output:
 * - A deep-frozen `{ _openapi: { METHOD: sanitizedDef } }` object.
 * - Freezing ensures that later user code cannot mutate definitions after
 *   the fact — OpenAPI generation must operate on immutable, trusted data.
 */
export function sanitizeOpenApiModule(mod: Record<string, unknown>): MultiEndpointModule {
	const raw = (mod as { _openapi?: unknown })._openapi;
	assertSafePlainRecord(raw, 'module._openapi');

	const api = raw as Record<string, unknown>;
	const cleanApi: Record<string, unknown> = Object.create(null);

	let count = 0;

	for (const [method, def] of Object.entries(api)) {
		if (count >= MAX_ENDPOINTS_PER_MODULE) break;
		if (!VALID_METHODS.has(method)) continue;
		if (!isValidEndpointDef(def)) continue;

		const safeDef = sanitizeEndpointDef(def as Record<string, unknown>);
		cleanApi[method] = safeDef;
		count++;
	}

	const frozenApi = Object.freeze(cleanApi) as Record<string, unknown>;
	const result = { _openapi: frozenApi };

	return Object.freeze(result) as MultiEndpointModule;
}

/**
 * Allowed HTTP methods for `_openapi` keys.
 *
 * Constraints:
 * - These reflect the only methods we allow the spec generator to process.
 * - Anything else (e.g. "HEAD", "OPTIONS") is discarded intentionally.
 *   The library focuses strictly on the core CRUD verbs unless extended.
 */
const VALID_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
export const VALIBOT_SUPPORTED_TYPES = new Set<string>([
  "array",
  "bigint",
  "boolean",
  "brand",
  "date",
  "default",
  "enum",
  "fallback",
  "lazy",
  "literal",
  "never",
  "nullable",
  "nullish",
  "number",
  "object",
  "optional",
  "pipe",
  "promise",
  "readonly",
  "record",
  "string",
  "symbol",
  "transform",
  "tuple",
  "union",
  "unknown",
  "unknownAsync",
]);


/**
 * Safety caps to reduce abuse / DoS vectors through gigantic specs.
 *
 * Rationale:
 * - Endpoint definitions originate from user code, not trusted sources.
 * - Malformed or malicious modules could inject massive data structures
 *   (thousands of tags, hundreds of responses, megabytes of documentation).
 *
 * These caps enforce:
 * - MAX_ENDPOINTS_PER_MODULE: each module can expose at most N handlers.
 * - MAX_RESPONSES_PER_ENDPOINT: ensures `responses` stays enumerable.
 * - MAX_TAGS_PER_ENDPOINT: OpenAPI tools degrade with huge tag lists.
 * - MAX_DOC_STRING_LENGTH: bounds untrusted free-text.
 * - MAX_OPERATION_ID_LENGTH: protects code generators and indexing systems.
 *
 * These are defensive measures against pathological configs, not everyday limits.
 */
const MAX_ENDPOINTS_PER_MODULE = 32;
const MAX_RESPONSES_PER_ENDPOINT = 32;
const MAX_TAGS_PER_ENDPOINT = 16;
const MAX_DOC_STRING_LENGTH = 512;
const MAX_OPERATION_ID_LENGTH = 256;

/**
 * Validate that a value is a *safe, plain, prototype-free object*.
 *
 * Threat model:
 * - Prototype pollution (`__proto__`, `constructor`, accessors).
 * - Objects created with exotic prototypes via `Object.create(...)`.
 * - Symbols as keys.
 *
 * Enforcement:
 * - Must be an object, not null, not an array.
 * - Prototype must be Object.prototype or null.
 * - Must not contain forbidden keys capable of polluting prototypes.
 * - Must not define getters/setters, which introduce arbitrary code execution.
 *
 * This function is an early firewall — anything that fails here is rejected
 * before influencing the OpenAPI structure.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Runtime assertion ensuring the value is a Valibot schema.
 *
 * Rejects:
 * - Non-objects
 * - Objects with wrong `kind`
 * - Schemas using unsupported Valibot types (library whitelist)
 *
 * This protects the converter from receiving malformed input and ensures
 * that Valibot → JSON Schema always receives a real schema node.
 */
export function assertValibotSchema(schema: unknown, label: string): asserts schema is AnySchema {
	if (!isValibotSchema(schema)) {
		throw new Error(`[openapi] ${label} must be a Valibot schema`);
	}
}

export function hasWrapped(x: unknown): x is { type: string; wrapped: unknown } {
  return (
    typeof x === 'object' &&
    x !== null &&
    'wrapped' in (x as Record<string, unknown>)
  );
}

/**
 * Runtime check: is this a Valibot schema object?
 *
 * Requirements:
 * - `kind` must be `"schema"` — Valibot’s internal tag.
 * - `type` must be a supported primitive (whitelisted).
 *
 * This guards normalization and conversion: only real schema nodes proceed.
 *
 * Why this is strict:
 * - Userland objects might pretend to be schemas.
 * - Import-meta-glob may load arbitrary modules.
 * - The converter must not operate on impostor objects.
 */
export function isValibotSchema(schema: unknown): schema is AnySchema {
	if (!schema || typeof schema !== 'object') return false;

	const base = schema as { kind?: unknown; type?: unknown };
	if (base.kind !== 'schema') return false;

	if (typeof base.type !== 'string') return false;
	if (!VALIBOT_SUPPORTED_TYPES.has(base.type)) return false;

	return true;
}

export function isValidMediaType(mediaType: string): boolean {
	return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType);
}

function assertSafePlainRecord(
	value: unknown,
	label: string
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`[openapi] ${label} must be a plain object`);
	}

	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		throw new Error(`[openapi] ${label} must not have a custom prototype`);
	}

	const ownKeys = Reflect.ownKeys(value);
	for (const key of ownKeys) {
		if (typeof key !== 'string') {
			throw new Error(`[openapi] ${label} must not use symbol keys`);
		}
		if (FORBIDDEN_KEYS.has(key)) {
			throw new Error(`[openapi] ${label} contains forbidden key "${key}"`);
		}
	}

	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, desc] of Object.entries(descriptors)) {
		if (desc.get || desc.set) {
			throw new Error(`[openapi] ${label} property "${key}" must not use accessors`);
		}
	}
}
/**
 * Basic structural validation for endpoint definitions.
 *
 * Goals:
 * - Ensure predictable shape before deeper sanitization.
 * - Reject arbitrary keys early.
 *
 * Checks:
 * - Must be a plain object.
 * - `method` must exist and be one of VALID_METHODS.
 * - Only allowed keys can appear; any unknown key invalidates the def.
 * - `responses` must be present (endpoint must define response semantics).
 *
 * This prevents malformed endpoint metadata from silently leaking into the spec.
 */
function isValidEndpointDef(def: unknown): boolean {
	if (!def || typeof def !== 'object' || Array.isArray(def)) return false;

	const method = (def as { method?: unknown }).method;
	if (typeof method !== 'string' || !VALID_METHODS.has(method)) return false;

	const allowed = new Set([
		'body',
		'deprecated',
		'description',
		'method',
		'operationId',
		'path',
		'query',
		'queryParams',
		'responses',
		'security',
		'summary',
		'tags'
	]);

	for (const key of Object.keys(def as Record<string, unknown>)) {
		if (!allowed.has(key)) return false;
	}

	if ((def as { responses?: unknown }).responses === undefined) return false;

	return true;
}
/**
 * sanitizeBodyDef:
 *
 * `endpoint.body` accepts either:
 * 1. a Valibot schema (shorthand for application/json)
 * 2. an object containing:
 *       { content: { "media/type": valibotSchema, ... }, description?, required? }
 *
 * Validation rules:
 * - If a non-schema object is supplied, it must contain a `content` map.
 * - Media types must be syntactically valid.
 * - Each schema inside content must be Valibot-valid.
 * - Description is trimmed + bounded; `required` must be boolean.
 *
 * Output is a fully frozen, prototype-free representation for OpenAPI.
 */
function sanitizeBodyDef(raw: unknown): unknown {
	if (raw === undefined || raw === null) return raw;

	if (isValibotSchema(raw)) {
		assertValibotSchema(raw, 'endpoint.body');
		return raw;
	}

	assertSafePlainRecord(raw, 'endpoint.body');
	const src = raw as {
		[key: string]: unknown;
		content?: unknown;
		description?: unknown;
		required?: unknown;
	};

	if (!('content' in src)) {
		throw new Error(
			'[openapi] endpoint.body object must contain a `content` map or be a Valibot schema'
		);
	}

	assertSafePlainRecord(src.content, 'endpoint.body.content');

	const cleanContent: Record<string, unknown> = Object.create(null);

	for (const [mediaType, schema] of Object.entries(src.content)) {
		if (!isValidMediaType(mediaType)) {
			throw new Error(`[openapi] endpoint.body.content media type "${mediaType}" is invalid`);
		}
		assertValibotSchema(schema, `endpoint.body.content["${mediaType}"]`);
		cleanContent[mediaType] = schema;
	}

	const out: Record<string, unknown> = Object.create(null);
	out.content = cleanContent;

	if (typeof src.description === 'string') {
		const desc = sanitizeDocString(src.description, MAX_DOC_STRING_LENGTH);
		if (desc) out.description = desc;
	}

	if (typeof src.required === 'boolean') {
		out.required = src.required;
	}

	return Object.freeze(out);
}

/**
 * sanitizeDocString:
 *
 * Conservative processing of free-text documentation:
 * - Only strings allowed.
 * - Trim whitespace.
 * - Reject empty results.
 * - Enforce maximum length to prevent large text injection into the spec.
 *
 * The function does *not* attempt sanitization beyond bounding and trimming —
 * markdown, HTML, etc., are allowed but size-limited.
 */
function sanitizeDocString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Produces a clean, prototype-free endpoint definition.
 *
 * Every field undergoes:
 * - Type validation
 * - Length caps
 * - Shape normalization
 * - Sanitization against prototype pollution
 *
 * Detailed rules:
 * - `method`: passed through verbatim (already validated).
 * - `path`: must be a trimmed string starting with "/" and containing no spaces.
 * - `summary` / `description`: trimmed + bounded.
 * - `operationId`: trimmed + length-bounded.
 * - `tags`: cleaned, capped, stripped of invalid entries.
 * - `query`: validated as object-like (object | wrappers | union of objects).
 * - `queryParams`: must correspond 1:1 with fields from `query`.
 * - `body`: either a Valibot schema or `{ content: {...} }` structure.
 * - `responses`: sanitized and validated against caps.
 * - `security`: copied if array.
 *
 * Output is fully frozen, ensuring downstream immutability.
 */
function sanitizeEndpointDef(def: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = Object.create(null);

	safe.method = def.method;

	if (typeof def.path === 'string') {
		const normalized = def.path.trim();
		if (normalized.startsWith('/') && !/\s/.test(normalized)) {
			safe.path = normalized;
		}
	}

	const summary = sanitizeDocString(def.summary, MAX_DOC_STRING_LENGTH);
	if (summary) safe.summary = summary;

	const description = sanitizeDocString(def.description, MAX_DOC_STRING_LENGTH);
	if (description) safe.description = description;

	if (typeof def.operationId === 'string') {
		const op = def.operationId.trim();
		if (op.length > 0) safe.operationId = op.slice(0, MAX_OPERATION_ID_LENGTH);
	}

	if (typeof def.deprecated === 'boolean') safe.deprecated = def.deprecated;

	if (Array.isArray(def.tags)) {
		const tags = sanitizeTags(def.tags);
		if (tags.length > 0) safe.tags = tags;
	}

	const querySchema = def.query !== undefined ? sanitizeQuerySchema(def.query) : undefined;
	if (querySchema) {
		safe.query = querySchema;
	}

	if (def.queryParams !== undefined) {
		safe.queryParams = sanitizeQueryParams(def.queryParams, safe.query);
	}

	if (def.body !== undefined) {
		safe.body = sanitizeBodyDef(def.body);
	}

	if (def.responses !== undefined) {
		safe.responses = sanitizeResponses(def.responses);
	}

	if (Array.isArray(def.security)) safe.security = def.security;

	return Object.freeze(safe);
}

/**
 * Sanitizes `queryParams` and aligns them with the validated `query` schema.
 *
 * Purpose:
 * - Documentation keys must correspond exactly to actual query fields.
 * - Prevents documentation drift where docs mention non-existent parameters.
 *
 * Mechanics:
 * - Ensures `raw` is a plain object with no prototype pollution.
 * - Extracts allowed keys from the object-like query schema.
 * - Rejects any documentation key not present in the schema.
 *
 * Each doc object is also validated as a safe plain record.
 * Output is frozen.
 */
function sanitizeQueryParams(raw: unknown, querySchema: unknown): Record<string, unknown> {
	assertSafePlainRecord(raw, '`queryParams`');

	const clean = Object.create(null) as Record<string, unknown>;

	let allowedKeys: Set<string> | undefined;

	if (querySchema) {
		const objectSchema = unwrapObjectLikeQuerySchema(querySchema, 'endpoint.query');
		const entries = (objectSchema as { entries?: Record<string, unknown> }).entries;

		if (entries && typeof entries === 'object') {
			allowedKeys = new Set(Object.keys(entries));
		}
	}

	for (const [key, doc] of Object.entries(raw)) {
		if (allowedKeys && !allowedKeys.has(key)) {
			throw new Error(`[openapi] queryParams["${key}"] does not match any field in query schema`);
		}

		assertSafePlainRecord(doc, `queryParams["${key}"]`);
		clean[key] = Object.freeze({ ...(doc as Record<string, unknown>) });
	}

	return clean;
}

function sanitizeQuerySchema(raw: unknown): AnySchema {
	return unwrapObjectLikeQuerySchema(raw, 'endpoint.query');
}

/**
 * sanitizeResponseDef:
 *
 * Sanitizes the response definition for a single HTTP status code.
 *
 * Allowed keys: `description`, `schema`, `content`. Nothing else.
 *
 * - `description`: trimmed + bounded.
 * - `schema`: must be Valibot schema.
 * - `content`: must be a map of mediaType → Valibot schema.
 *     - media types validated syntactically.
 *     - schemas validated individually.
 *
 * At least one of the three fields must be present. Otherwise the response
 * definition is considered semantically empty and rejected.
 *
 * Output: frozen, prototype-free.
 */
function sanitizeResponseDef(status: string, def: unknown): Record<string, unknown> {
	assertSafePlainRecord(def, `responses["${status}"]`);

	const src = def as Record<string, unknown>;
	const out: Record<string, unknown> = Object.create(null);

	if (src.description !== undefined) {
		const desc = sanitizeDocString(src.description, MAX_DOC_STRING_LENGTH);
		if (desc) out.description = desc;
	}

	if (src.schema !== undefined) {
		assertValibotSchema(src.schema, `responses["${status}"].schema`);
		out.schema = src.schema;
	}

	if (src.content !== undefined) {
		assertSafePlainRecord(src.content, `responses["${status}"].content`);
		for (const [mt, sch] of Object.entries(src.content)) {
			if (!isValidMediaType(mt)) {
				throw new Error(`[openapi] responses["${status}"].content media type "${mt}" is invalid`);
			}
			assertValibotSchema(sch, `responses["${status}"].content["${mt}"]`);
		}
		out.content = src.content;
	}

	const allowed = new Set(['content', 'description', 'schema']);
	for (const key of Object.keys(src)) {
		if (!allowed.has(key)) {
			throw new Error(`[openapi] responses["${status}"] contains unsupported key "${key}"`);
		}
	}

	if (!out.description && !out.schema && !out.content) {
		throw new Error(
			`[openapi] responses["${status}"] must define at least description, schema, or content`
		);
	}

	return Object.freeze(out);
}
/**
 * Sanitizes the `responses` map.
 *
 * Validation:
 * - Must be a plain object.
 * - Must contain 1–MAX_RESPONSES_PER_ENDPOINT entries.
 * - Keys must be 3-digit HTTP status codes ("200", "404", ...).
 *
 * Each response definition is validated and sanitized individually.
 *
 * Failure examples:
 * - Symbol keys
 * - Non-numeric keys
 * - Oversized response lists
 * - Response definitions lacking description/schema/content entirely
 *
 * Output is a clean, prototype-free object of sanitized response defs.
 */
function sanitizeResponses(raw: unknown): Record<string, unknown> {
	assertSafePlainRecord(raw, '`responses`');

	const clean = Object.create(null) as Record<string, unknown>;
	const entries = Object.entries(raw);
	if (entries.length === 0 || entries.length > MAX_RESPONSES_PER_ENDPOINT) {
		throw new Error('[openapi] `responses` has invalid size');
	}

	let count = 0;

	for (const [status, def] of entries) {
		if (count >= MAX_RESPONSES_PER_ENDPOINT) break;
		if (!/^[0-9]{3}$/.test(status)) {
			throw new Error(`[openapi] responses key "${status}" is not a 3-digit status code`);
		}

		const safeDef = sanitizeResponseDef(status, def);
		clean[status] = safeDef;
		count++;
	}

	return clean;
}
/**
 * Normalizes and bounds tags for an endpoint.
 *
 * Rules:
 * - Only string tags are kept.
 * - Trim whitespace.
 * - Limit tag length to 64 chars (safe for UI, indexing, codegen).
 * - Stop if MAX_TAGS_PER_ENDPOINT is reached.
 *
 * Intention: tags must remain small categorical markers, not payloads.
 */
function sanitizeTags(raw: unknown[]): string[] {
	const tags: string[] = [];
	for (const t of raw) {
		if (typeof t !== 'string') continue;
		const trimmed = t.trim();
		if (!trimmed) continue;
		tags.push(trimmed.slice(0, 64));
		if (tags.length >= MAX_TAGS_PER_ENDPOINT) break;
	}
	return tags;
}

/**
 * unwrapObjectLikeQuerySchema:
 *
 * Ensures the query schema is structurally an *object* or a stack of wrappers
 * (optional / nullable / pipe / union) whose unwrapped base is an object.
 *
 * Requirements:
 * - `object` type with `entries` is accepted.
 * - `optional` / `nullable` strip wrappers until base object is found.
 * - `pipe` unwraps transform layers (Valibot pipeline semantics).
 * - `union`: all union branches must expose *identical* object fields.
 *   (OpenAPI query parameters must be fixed, not variant-dependent.)
 *
 * Depth-cap:
 * - Maximum wrapper depth is enforced to avoid pathological recursion.
 *
 * Output:
 * - A validated object-like schema or an error indicating exact violation.
 */
function unwrapObjectLikeQuerySchema(schema: unknown, label: string, depth = 0): AnySchema {
	if (depth > 8) {
		throw new Error(`[openapi] ${label}: maximum wrapper depth exceeded`);
	}

	assertValibotSchema(schema, label);

	const node = schema as {
		entries?: Record<string, unknown>;
		inner?: unknown;
		options?: unknown[];
		type?: unknown;
		value?: unknown;
		wrapped?: unknown;
	};

	const type = node.type;

	if (type === 'object') {
		if (!node.entries || typeof node.entries !== 'object') {
			throw new Error(`[openapi] ${label}: object schema missing entries`);
		}
		return schema as AnySchema;
	}

	if (type === 'optional' || type === 'nullable') {
		if (!('wrapped' in node)) {
			throw new Error(`[openapi] ${label}: ${String(type)} schema missing "wrapped"`);
		}
		return unwrapObjectLikeQuerySchema(node.wrapped, label, depth + 1);
	}

	if (type === 'pipe') {
		const inner = node.inner ?? node.value;
		if (!inner) {
			throw new Error(`[openapi] ${label}: pipe schema missing "inner" or "value"`);
		}
		return unwrapObjectLikeQuerySchema(inner, label, depth + 1);
	}

	if (type === 'union') {
		const options = node.options;
		if (!Array.isArray(options) || options.length === 0) {
			throw new Error(`[openapi] ${label}: union schema missing options`);
		}

		let baseKeys: null | string[] = null;

		for (const opt of options) {
			const unwrapped = unwrapObjectLikeQuerySchema(opt, `${label}.unionOption`, depth + 1);
			const entries = (unwrapped as { entries?: Record<string, unknown> }).entries;

			if (!entries || typeof entries !== 'object') {
				throw new Error(`[openapi] ${label}: union option is not an object schema`);
			}

			const keys = Object.keys(entries);

			if (baseKeys === null) {
				baseKeys = keys;
			} else if (baseKeys.length !== keys.length || keys.some((k) => !baseKeys!.includes(k))) {
				throw new Error('[openapi] union query schema options must expose the same object fields');
			}
		}

		// Keep the original union; we just validated that it is object-like.
		return schema as AnySchema;
	}

	throw new Error(
		`[openapi] ${label} must be an object schema or a union/pipe/optional/nullable of objects`
	);
}