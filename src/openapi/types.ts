import type { BaseIssue, BaseSchema, BaseSchemaAsync } from 'valibot';

/**
 * A Valibot schema accepted by this library.
 *
 * Both sync and async Valibot schemas are supported. Async schemas are
 * normalised internally so they can be converted into JSON Schema without
 * requiring async execution. Behavioural async logic is not executed here;
 * only structural information is used to generate documentation.
 */
export type AnySchema<TInput = unknown, TOutput = unknown> =
  | BaseSchema<TInput, TOutput, BaseIssue<unknown>>
  | BaseSchemaAsync<TInput, TOutput, BaseIssue<unknown>>;

/**
 * Describes a single documented API operation.
 *
 * This structure is exported from route modules and consumed by the OpenAPI
 * generator. Each operation corresponds to one HTTP method for a given path.
 *
 * @template TQuerySchema
 * Valibot schema describing the URL query parameters.
 *
 * @template TBodySchema
 * Valibot schema describing the request body.
 *
 * @template TResponses
 * Map of status codes to response definitions.
 */
export interface EndpointDef<
  TQuerySchema extends AnySchema | undefined = AnySchema | undefined,
  TBodySchema extends AnySchema | undefined = AnySchema | undefined,
  TResponses extends EndpointResponses = EndpointResponses
> {
  /**
 * Valibot schema describing the request body.
 *
 * Two forms are supported:
 *
 * 1. Pass a schema directly:
 *    ```ts
 *    body: MySchema
 *    // → emitted as application/json
 *    ```
 *
 * 2. Pass a `content` map to describe multiple media types:
 *    ```ts
 *    body: {
 *      description: 'Explanation for the request body',
 *      content: {
 *        'application/json': JsonSchema,
 *        'multipart/form-data': FormSchema
 *      },
 *      required: true
 *    }
 *    ```
 *
 * No Promise-based schema loading is supported here. Any async Valibot
 * schema is normalised automatically before JSON Schema conversion.
 */
  body?:
    | {
        /**
         * Optional human-readable description for the request body.
         *
         * Emitted as `requestBody.description` in the OpenAPI operation.
         * Useful when the body shape is complex or when you need to explain
         * side-effects (e.g. callbacks, expand semantics, etc.).
         */
        content: Record<string, AnySchema>;
        description?: string;
        /** Whether the request body is required. Defaults to `true`. */
        required?: boolean;
      }
    | TBodySchema;
  /**
   * Marks this endpoint as deprecated in the generated OpenAPI spec.
   */
  deprecated?: boolean;

  /** Optional detailed description. */
  description?: string;

  /** HTTP method implemented by this operation. */
  method: HttpMethod;

  /** OperationId used by OpenAPI code generators. */
  operationId?: string;
  
  /**
   * Absolute OpenAPI path for the operation.
   * If omitted, the path is inferred from the file location.
   */
  path?: string;

  
  /**
   * Valibot schema describing the query string parameters.
   *
   * When `query` is an object schema, each top-level field is converted
   * into an OpenAPI `in: "query"` parameter, with required/optional flags
   * derived from the Valibot schema.
   */
  query?: TQuerySchema;
  /**
   * Optional per-query-parameter documentation.
   *
   * Each key must match a top-level property name of the `query` schema.
   * These docs are merged into the generated OpenAPI parameters and take
   * precedence over any `description`/`example(s)` derived from JSON Schema.
   */
  queryParams?: QueryParameterDocs;
  
  /** HTTP responses for this operation. */
  responses: TResponses;

  /**
   * Security requirements applied to this operation.
   *
   * If omitted, the generator falls back to the top-level `security`
   * defined on `OpenApiOptions` (if any).
   */
  security?: SecurityRequirementObject[];
  
  /** Short title for documentation. */
  summary?: string;

  
  /** Tags used to group related operations in API documentation. */
  tags?: string[];
}

/**
 * Mapping of HTTP status codes to response definitions.
 *
 * @template TSchemaMap
 * A record where each key is a status code and the value is a Valibot
 * schema (or `undefined`). This is transformed into a map of `ResponseDef`s.
 */
export type EndpointResponses<
  TSchemaMap extends Record<PropertyKey, AnySchema | undefined> = Record<
    number,
    AnySchema | undefined
  >
> = {
  [Status in keyof TSchemaMap]: ResponseDef<
    Extract<TSchemaMap[Status], AnySchema | undefined>
  >;
};
/**
 * Shape expected from `import.meta.glob` when scanning API modules.
 *
 * Each key is a module path. Each value is a loader returning a module
 * object. Nested loader functions are allowed and resolved automatically.
 *
 * Only the resolved module’s `_openapi` export is inspected; everything
 * else is ignored.
 */
export type GlobModules = Record<string, () => Promise<unknown>>;
/**
 * HTTP methods that may be documented for an API route.
 *
 * This type is used by `EndpointDef.method`. In SvelteKit, these correspond
 * directly to route handler exports such as `export const GET`, `export const POST`, etc.
 */
export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

/**
 * Lowercase form of `HttpMethod`, used within the OpenAPI `paths` object.
 *
 * @example
 * "GET" → "get"
 */
export type HttpMethodLower = Lowercase<HttpMethod>;

/**
 * A permissive JSON Schema type representing the output of
 * `@valibot/to-json-schema`.
 *
 * This type models the structural shape of JSON Schema without enforcing
 * strict keyword validation, and it allows vendor extensions through an
 * index signature.
 * 
 * NOTE:
 * - `v.date()` is normalised to `{ type: "string", format: "date-time" }`
 *   before conversion. This produces consistent OpenAPI output regardless
 *   of Valibot’s internal transformer behaviour.
 */
export type JsonSchema =
  | {
      [keyword: string]: unknown;
      $defs?: Record<string, JsonSchema>;
      $id?: string;
      $ref?: string;
      $schema?: string;
      additionalProperties?: boolean | JsonSchema;
      allOf?: JsonSchema[];
      anyOf?: JsonSchema[];
      const?: boolean | null | number | string;
      default?: unknown;
      description?: string;
      enum?: (boolean | null | number | string)[];
      examples?: unknown[];
      format?: string;
      items?: JsonSchema | JsonSchema[];
      not?: JsonSchema;
      oneOf?: JsonSchema[];
      patternProperties?: Record<string, JsonSchema>;
      prefixItems?: JsonSchema[];
      properties?: Record<string, JsonSchema>;
      required?: string[];
      title?: string;
      type?: string | string[];
    }
  | boolean;

/**
 * Module shape for API routes that export one or more documented operations.
 *
 * Route modules may declare multiple HTTP methods for the same path.
 * The `_openapi` record maps each supported method to its corresponding
 * `EndpointDef`.
 *
 * @example
 * export const _openapi = {
 *   GET: defineEndpoint({ ... }),
 *   POST: defineEndpoint({ ... })
 * };
 */
export type MultiEndpointModule<
  TEndpoint extends EndpointDef = EndpointDef
> = {
  _openapi?: Partial<Record<HttpMethod, TEndpoint>>;
};

/**
 * OpenAPI OAuth2 flow object.
 *
 * This is a minimal representation suitable for documenting scopes and
 * the involved URLs for a given flow.
 */
export interface OAuthFlowObject {
  authorizationUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
  tokenUrl?: string;
}

/**
 * Container for the set of OAuth2 flows supported by a security scheme.
 */
export interface OAuthFlowsObject {
  authorizationCode?: OAuthFlowObject;
  clientCredentials?: OAuthFlowObject;
  implicit?: OAuthFlowObject;
  password?: OAuthFlowObject;
}

/**
 * OpenAPI Components section.
 *
 * This library currently exposes `securitySchemes`, and may be extended
 * in the future to support more component types.
 */
export interface OpenApiComponents {
  schemas?: Record<string, JsonSchema>;
  securitySchemes?: Record<string, SecuritySchemeObject>;
}
/**
 * The reusable components section of the generated OpenAPI specification.
 *
 * This object collects named elements that can be referenced across the
 * entire spec instead of being duplicated inline. It acts as a shared
 * registry for schemas and security schemes.
 *
 * Currently supported component types:
 * - `schemas`: reusable JSON Schemas for request/response bodies, parameters, etc.
 * - `securitySchemes`: authentication and authorization mechanisms (bearer, API key, OAuth2…)
 *
 * These are automatically populated by the generator when deduplication or
 * merging logic detects identical schemas, and can also be provided manually
 * through the generator’s `options.securitySchemes`.
 *
 * The structure is intentionally minimal — compliant with OpenAPI 3.1, but
 * trimmed to the subset this library uses and guarantees to produce.
 */
export interface OpenApiComponents {
  schemas?: Record<string, JsonSchema>;
  securitySchemes?: Record<string, SecuritySchemeObject>;
}


/**
 * Metadata describing the API itself.
 *
 * This corresponds to the top-level `info` object in the OpenAPI 3.1
 * specification and identifies the published API version, its title, and
 * optional free-form description.
 *
 * These fields do not affect validation or behavior; they exist purely for
 * documentation, client generation, and UI rendering (Scalar, Redoc, Swagger UI).
 *
 * Example:
 * ```json
 * {
 *   "title": "Snapp Public API",
 *   "version": "1.0.0",
 *   "description": "Programmatic access to Snapp links and analytics."
 * }
 * ```
 */
export interface OpenApiInfo {
  description?: string;
  title?: string;
  version?: string;
}

/**
 * Minimal logging contract used internally by the generator.
 *
 * A user-supplied logger can be passed via `OpenApiOptions.logger` to capture
 * diagnostics, transformation errors, and schema-conversion issues during
 * spec generation. The interface mirrors common logging frameworks while
 * staying transport-agnostic.
 *
 * The generator never throws for non-fatal issues when a logger is present;
 * it reports them through these callbacks instead.
 *
 * Example adapter:
 * ```ts
 * const logger: OpenApiLogger = {
 *   error: (msg, meta) => console.error(msg, meta),
 *   warn:  (msg, meta) => console.warn(msg, meta)
 * };
 * ```
 */
export interface OpenApiLogger {
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

/**
 * Describes a single media type entry within a request or response body.
 *
 * In OpenAPI, every body content map is a dictionary of
 * `"media/type" → MediaTypeObject`, where each value can include a schema
 * and optionally encoding or examples (not exposed here for simplicity).
 *
 * Example:
 * ```json
 * {
 *   "application/json": {
 *     "schema": { "$ref": "#/components/schemas/User" }
 *   },
 *   "text/plain": {
 *     "schema": { "type": "string" }
 *   }
 * }
 * ```
 *
 * This interface models only the subset the generator emits — a pure schema
 * mapping — since encoding and examples are derived from Valibot data rather
 * than declared manually.
 */
export interface OpenApiMediaTypeObject {
    /** The JSON Schema describing the structure of the media type’s payload. */
  schema?: JsonSchema;
}

/**
 * Options available when generating the OpenAPI specification.
 *
 * - `basePath` filters included routes by prefix
 * - `info` configures title, version, and description
 * - `servers` defines the list of server URLs
 * - `securitySchemes` declares the available authentication mechanisms
 * - `security` sets default security requirements for all operations
 */
export interface OpenApiOptions {
  basePath?: string;
  info?: OpenApiInfo;
  logger?: OpenApiLogger;
  security?: SecurityRequirementObject[];
  securitySchemes?: Record<string, SecuritySchemeObject>;
  servers?: OpenApiServer[];
}
/** OpenAPI Parameter Object. */
export interface OpenApiParameterObject {
  description?: string;
  /**
   * Single inline example for this parameter.
   */
  example?: unknown;
  /**
   * Multiple named examples for this parameter.
   *
   * This is intentionally loose (array of values) rather than the full
   * OpenAPI `examples` object to keep the public type ergonomic.
   */
  examples?: unknown[];
  in: 'cookie' | 'header' | 'path' | 'query';
  name: string;
  required?: boolean;

  schema?: JsonSchema;
}

/** OpenAPI Request Body Object. */
export interface OpenApiRequestBodyObject {
  content: Record<string, OpenApiMediaTypeObject>;
  description?: string;
  required?: boolean;
}


/** OpenAPI Response Object. */
export interface OpenApiResponseObject {
  content?: Record<string, OpenApiMediaTypeObject>;
  description: string;
}

/** OpenAPI map of status code → response. */
export type OpenApiResponsesObject = Record<string, OpenApiResponseObject>;

/** OpenAPI `servers` entry. */
export interface OpenApiServer {
  description?: string;
  url: string;
}


/**
 * Structure returned by the generated OpenAPI handler.
 *
 * This representation follows OpenAPI 3.1 and is suitable for consumers
 * such as Scalar, Redoc, Swagger UI, and OpenAPI code generators.
 */
export interface OpenApiSpec {
  components?: OpenApiComponents;
  info: {
    description?: string;
  } & Required<Pick<OpenApiInfo, "title" | "version">>;
  openapi: "3.1.0";
  paths: PathsObject;
  security?: SecurityRequirementObject[];
  servers?: OpenApiServer[];
  tags?: OpenApiTagObject[];
}

export interface OpenApiTagObject {
  description?: string;
  name: string;
}

/**
 * A documented HTTP operation inside OpenAPI's `paths` object.
 *
 * The request body and parameters are attached by the generator when
 * applicable, based on the endpoint definition's `body` and `query`.
 */
export interface OperationObject {
  /** Marks the operation as deprecated in the docs. */
  deprecated?: boolean;
  description?: string;
  /** Unique identifier for this operation (per path + method). */
  operationId?: string;
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
  responses: OpenApiResponsesObject;
  security?: SecurityRequirementObject[];
  summary?: string;
  tags?: string[];
}

/**
 * OpenAPI `paths` representation:
 *
 * `/path`: {
 *   get?: OperationObject;
 *   post?: OperationObject;
 *   ...
 * }
 */
export type PathsObject = Record<
  string,
  Partial<Record<HttpMethodLower, OperationObject>>
>;

/**
 * Documentation for a single query parameter.
 */
export interface QueryParameterDoc {
  /** Human-readable explanation for this query parameter. */
  description?: string;

  /**
   * Single example value.
   *
   * This is emitted as `parameter.example`. Use it when you only need one
   * canonical example (e.g. an `expand` callback contract).
   */
  example?: unknown;

  /**
   * Multiple example values.
   *
   * This is emitted as `parameter.examples`. Useful to document common
   * patterns or callback behaviours.
   */
  examples?: unknown[];
}

/**
 * Per-parameter documentation for query fields.
 *
 * Keys must match the top-level keys of the `query` schema. These docs are
 * merged into the generated OpenAPI `Parameter` objects and allow you to add
 * descriptions and examples without changing the Valibot schema itself.
 *
 * @example
 * const QuerySchema = object({
 *   expand: string().optional(),
 *   limit: number().optional()
 * });
 *
 * defineEndpoint({
 *   method: 'GET',
 *   path: '/api/items',
 *   query: QuerySchema,
 *   queryParams: {
 *     expand: {
 *       description: 'Comma-separated list of relations to expand.',
 *       example: 'teams,organization'
 *     },
 *     limit: {
 *       description: 'Maximum number of items to return.',
 *       example: 50
 *     }
 *   },
 *   responses: { 200: { description: 'OK' } }
 * });
 */
export type QueryParameterDocs = Record<string, QueryParameterDoc>;

/**
 * Describes a single HTTP response for an operation.
 *
 * @template TSchema
 * A Valibot schema representing the response body for this status code, or
 * `undefined` if the response does not return a typed body.
 */
export interface ResponseDef<
  TSchema extends AnySchema  | undefined = AnySchema |   undefined
> {
  /**
   * Optional mapping of `mediaType → Valibot schema`.
   *
   * Use this to model multiple response representations for a status code,
   * such as JSON, plain text, or binary formats.
   */
  content?: Record<string, AnySchema>;

  /** Human-readable explanation included in the OpenAPI output. */
  description?: string;

  /**
   * Convenience field for a single `application/json` response.
   *
   * When `schema` is provided and no `application/json` entry exists in
   * `content`, the generator will emit it as a JSON media type.
   */
  schema?: TSchema;
}

export interface SchemaRegistry {
  bySchema: WeakMap<object, string>;
  componentsSchemas: Record<string, JsonSchema>;
  counter: number;
}

/**
 * OpenAPI Security Requirement Object.
 *
 * The keys are names of security schemes defined under
 * `components.securitySchemes`, and the values are the required scopes.
 */
export type SecurityRequirementObject = Record<string, string[]>;


/**
 * OpenAPI Security Scheme Object.
 *
 * This is used to describe how clients authenticate with the API
 * (API keys, HTTP auth, OAuth2, OpenID Connect).
 */
export interface SecuritySchemeObject {
  bearerFormat?: string;
  description?: string;

  // oauth2
  flows?: OAuthFlowsObject;
  in?: 'cookie' | 'header' | 'query';

  // apiKey
  name?: string;
  // openIdConnect
  openIdConnectUrl?: string;

  // http
  scheme?: string;

  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
}