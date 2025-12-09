import type {
  AnySchema,
  EndpointDef,
  EndpointResponses,
  HttpMethod,
  ResponseDef
} from './types.ts';

export type { EndpointDef, HttpMethod, ResponseDef };

/**
 * Defines a typed OpenAPI endpoint description for a SvelteKit route.
 *
 * This helper is used **inside API route modules** (e.g. `+server.ts`) to
 * provide strong typing for documenting your endpoints. The returned value
 * is not transformed at runtime — it is simply returned as-is — but the
 * type-level inference it enables is critical for:
 *
 * - autocompletion when writing OpenAPI metadata  
 * - accurate OpenAPI generation inside `$lib/openapi/sveltekit.ts`  
 * - full schema-safe request/response typing through Valibot  
 *
 * ---
 * ## 📌 Usage
 *
 * Inside a route file, you export an `_openapi` object containing one or
 * more HTTP methods mapped to endpoint definitions:
 *
 * ```ts
 * // src/routes/api/todos/+server.ts
 * import { defineEndpoint } from '$lib/openapi/endpoint';
 * import { TodoListResponseSchema } from '$lib/schemas/todo';
 *
 * export const _openapi = {
 *   GET: defineEndpoint({
 *     method: 'GET',
 *     path: '/api/todos',
 *     summary: 'List todos',
 *     responses: {
 *       200: {
 *         description: 'List of todos',
 *         schema: TodoListResponseSchema
 *       }
 *     }
 *   }),
 *
 *   POST: defineEndpoint({
 *     method: 'POST',
 *     path: '/api/todos',
 *     summary: 'Create todo',
 *     body: NewTodoSchema,
 *     responses: {
 *       201: {
 *         description: 'Created todo',
 *         schema: TodoSchema
 *       }
 *     }
 *   })
 * };
 * ```
 *
 * The `$lib/openapi/sveltekit.ts` generator will automatically discover
 * these definitions via `import.meta.glob` and convert them into a
 * standards-compliant OpenAPI 3.1 document.
 *
 * ---
 * ## 📘 Generic Parameters
 *
 * ### `TQuerySchema`
 * The Valibot schema describing the query string parameters.
 *
 * ```ts
 * query?: TQuerySchema;
 * ```
 *
 * When `query` is an object schema, each top-level field is emitted as an
 * OpenAPI `in: "query"` parameter. Required fields become required params,
 * optional fields become optional params.
 *
 * ---
 * ### `TBodySchema`
 * The Valibot schema describing the request body.
 *
 * ```ts
 * body?: TBodySchema | {
 *   content: Record<string, AnySchema>;
 * };
 * ```
 *
 * - If you pass a single schema, it is treated as `application/json`.
 * - If you pass a `content` map, each key becomes a media type in
 *   `requestBody.content` (e.g. JSON, text, multipart form data, etc.).
 *
 * ---
 * ### `TResponseSchemas`
 * A mapping of numeric status codes → Valibot schemas.
 *
 * ```ts
 * responses: {
 *   200: { description?: string; schema?: TSchema };
 *   400: { ... };
 * }
 * ```
 *
 * Each status code may or may not have an attached `schema`. You can also
 * provide a `content` map on each response to describe multiple media types.
 * The generator will emit:
 *
 * - a `description` (always)  
 * - a `content` block when either `schema` or `content` is present  
 *
 * ---
 * ## 🧾 Return Value
 *
 * The function returns the given object unchanged, but typed as:
 *
 * ```ts
 * EndpointDef<TQuerySchema, TBodySchema, EndpointResponses<TResponseSchemas>>
 * ```
 *
 * This is necessary for proper downstream inference when the generator
 * reads your `_openapi` definitions.
 *
 * ---
 * ## 🔐 Security
 *
 * If you attach a `security` array to the endpoint definition, it will be
 * emitted on the corresponding OpenAPI operation and can reference any
 * security schemes defined on the generator:
 *
 * ```ts
 * defineEndpoint({
 *   method: 'GET',
 *   path: '/api/secure',
 *   responses: { 200: { description: 'OK' } },
 *   security: [{ bearerAuth: [] }]
 * });
 * ```
 * ---
 * ## 🔒 At Runtime
*
* `defineEndpoint()` is a **no-op function** (identity function).
* All behavior happens at the type level and later in the OpenAPI generator.
*
 *
 */
export const defineEndpoint = <
  TQuerySchema extends AnySchema | undefined = AnySchema | undefined,
  TBodySchema extends AnySchema | undefined = AnySchema | undefined,
  TResponseSchemas extends Record<number, AnySchema | undefined> = Record<
    number,
    AnySchema | undefined
  >
>(
  def: EndpointDef<
    TQuerySchema,
    TBodySchema,
    EndpointResponses<TResponseSchemas>
  >
) => def;
