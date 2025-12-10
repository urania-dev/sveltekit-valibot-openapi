# Valibot → OpenAPI 3.1

### (SvelteKit-first, framework-agnostic)

Generate an OpenAPI 3.1 specification directly from Valibot schemas and minimal endpoint metadata.
**No runtime hooks. No hidden validation. No route magic.**
The output is a clean, deterministic OpenAPI document.

- 🧩 First-class SvelteKit `+server` integration
- 🔌 Framework-agnostic generator (`createOpenApiSpec`)
- 🔍 Query schemas → OpenAPI parameters (strict object/union-of-objects)
- 🧾 Multi-media request/response body support
- 🔐 Security schemes & per-operation overrides
- 🛡 Hardened sanitization (prototype-free, bounded, schema-safe)
- 🧰 Fully async-schema compatible (async → sync structural normalization)

This library is **pure documentation generation**, not a runtime validator or router.
Still **alpha**.

---

## 🚀 Installation

```bash
pnpm add @uraniadev/sveltekit-valibot-openapi valibot @valibot/to-json-schema
```

---

## 📘 Defining endpoints

Endpoints are declared by exporting a `_openapi` object from your SvelteKit route module.

Each key is an HTTP method, each value is created with `defineEndpoint()`.
The object is later **sanitized**, **validated**, and **deep-frozen** by the generator to guarantee structural safety.

```ts
// src/routes/api/todos/+server.ts
import * as v from "valibot";
import { defineEndpoint } from "@uraniadev/sveltekit-valibot-openapi";

const Todo = v.object({
  id: v.string(),
  title: v.string(),
});

const TodoList = v.array(Todo);
const TodoCreate = v.object({ title: v.string() });

export const _openapi = {
  GET: defineEndpoint({
    method: "GET",
    path: "/api/todos",
    summary: "List todos",
    query: v.object({
      search: v.optional(v.string()),
    }),
    responses: {
      200: {
        description: "List of todos",
        schema: TodoList,
      },
    },
  }),

  POST: defineEndpoint({
    method: "POST",
    path: "/api/todos",
    summary: "Create a todo",
    body: TodoCreate,
    responses: {
      201: {
        description: "Created todo",
        schema: Todo,
      },
    },
  }),
} as const;
```

### ✔ What `defineEndpoint()` supports

- `query`: **object-like only** (object / optional / nullable / pipe / union-of-objects)
- `queryParams`: extra documentation aligned with `query`
- `body`:
  - a schema → emitted as `application/json`
  - or a `{ content: { "media/type": schema } }` map

- `responses`:
  - `{ schema }`
  - `{ content: { "media/type": schema } }`
  - both (JSON fallback auto-added)

- `tags`, `summary`, `description`, `deprecated`
- per-endpoint `security`

## 📡 Generating and exposing the OpenAPI spec

`createOpenApiSpec` produces the **OpenAPI spec object**.
You expose it however you want.

### SvelteKit example

```ts
// src/routes/openapi/+server.ts
import { json } from "@sveltejs/kit";
import { createOpenApiSpec } from "@uraniadev/sveltekit-valibot-openapi";

const modules = import.meta.glob("../api/**/+server.{ts,js}");

export const GET = async () => {
  const spec = await createOpenApiSpec(modules, {
    basePath: "/api",
    info: {
      title: "My API",
      version: "1.0.0",
      description: "Example SvelteKit API",
    },
    servers: [
      { url: "https://api.example.com", description: "Production" },
      { url: "http://localhost:5173", description: "Development" },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    security: [{ bearerAuth: [] }],
  });

  return json(spec);
};
```

Visit:

```
/openapi
```

to see your OpenAPI 3.1 JSON.

### Generic (non-SvelteKit) usage

```ts
import { createOpenApiSpec } from "@uraniadev/sveltekit-valibot-openapi";

const modules = import.meta.glob("./routes/**/route.{ts,js}");

async function build() {
  const spec = await createOpenApiSpec(modules, {
    info: { title: "My Service", version: "1.0.0" },
  });

  console.log(JSON.stringify(spec, null, 2));
}
```

---

## 🧾 Request Bodies

Request bodies fully support **multi-media content maps**:

```ts
body: {
  description: "Update profile",
  required: false,
  content: {
    "application/json": v.object({ name: v.string() }),
    "multipart/form-data": v.object({
      name: v.string(),
      avatar: v.string(),
    }),
  },
}
```

Shorthand (schema only):

```ts
body: v.object({ title: v.string() });
```

is documented as:

```json
{
  "content": {
    "application/json": { "schema": { … } }
  }
}
```

All body definitions undergo strict validation:

- media types validated (`type/subtype`)
- schemas must be valid Valibot schemas
- description length capped
- full deep-frozen sanitized output

## 📤 Responses

A response may define:

- a single JSON schema (`schema`)
- a `content` map
- or both

```ts
responses: {
  200: {
    description: "Multiple formats",
    content: {
      "application/json": v.object({ ok: v.string() }),
      "text/plain": v.string(),
      "image/png": v.string(),
    },
  },
  404: {
    description: "Not found",
    schema: v.object({ message: v.string() }),
  },
}
```

Rules enforced by sanitization:

- status keys **must be numeric 3-digit codes**
- unknown keys rejected
- description length capped
- schemas validated + normalized asynchronously
- content media types validated
- max 32 responses per endpoint

## 🔍 Query Parameters

`query` must be **object-like**:

- `object(...)`
- wrapped in `optional`, `nullable`, `nullish`, `pipe`, `brand`, `fallback`, `default`
- unions of objects **only if all branches expose identical keys**

Unsupported shapes (primitives, arrays) are rejected.

```ts
const Query = v.object({
  search: v.optional(v.string()),
  limit: v.number(),
  sort: v.union([v.literal("asc"), v.literal("desc")]),
});
```

The generator:

- unwraps wrapper types
- validates union shapes
- rejects mismatched branches
- extracts top-level fields only
- produces OpenAPI `in: "query"` parameters
- merges documentation from `queryParams`

Array-typed query values are permitted and documented normally.

---

## 🛡 Hardened Sanitization Layer

Every `_openapi` module is sanitized before inclusion:

- must be **plain**, **prototype-free** objects
- forbidden keys: `__proto__`, `constructor`, `prototype`
- no getters/setters
- max 32 methods per module
- endpoint definitions validated strictly:
  - allowed keys only
  - required `method` and `responses`
  - tags capped, doc strings capped
  - body/query/responses validated structurally
  - deep-frozen immutable output

This prevents prototype pollution, malformed metadata, and unbounded structures from entering your spec.

---

## 🧬 Schema Normalization & Budget Limits

Valibot schemas go through a full structural normalization step:

- async schemas → sync structure
- `date()` → `{ type: "string", format: "date-time" }`
- `never()` removed
- wrapper unwrapping
- union normalization
- array nesting bounded

To prevent runaway or malicious schemas:

- max depth: **32**
- max nodes: **10,000**
- max union options: **32**
- max object properties: **128**
- max array nesting: **16**

Invalid or pathological schemas fail early with explicit errors.

---

## 🧱 Component Schema Registry (deduplication)

Schemas used in request/response bodies are automatically:

- normalized
- converted to JSON Schema
- deduplicated
- registered under `#/components/schemas/...`

This avoids excessive inlining and makes the generated spec tooling-friendly.

```json
{
  "components": {
    "schemas": {
      "User_1": { ... },
      "Todo_2": { ... }
    }
  }
}
```

---

## 🏷 Auto-tagging

If an endpoint has tags, the generator aggregates them into a sorted list:

```json
{
  "tags": ["Users", "Todo"]
}
```

---

## 🗂 Path Handling

Your generator now:

- infers OpenAPI paths from route files (`[id]` → `{id}`)
- extracts path parameters and documents them automatically
- ensures all path parameters are required and typed

Example:

```
src/routes/api/users/[id]/+server.ts
↓
/api/users/{id}
```

---

## 🔐 Authentication / Security

### Global security

```ts
const spec = await createOpenApiSpec(glob, {
  securitySchemes: {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  },
  security: [{ bearerAuth: [] }],
});
```

### Per-endpoint overrides

```ts
defineEndpoint({
  method: "GET",
  path: "/api/public",
  security: [], // override to no auth
  responses: { 200: { description: "OK" } },
});
```

---

## ❌ What this library does NOT do

- ❌ No runtime validation
- ❌ No runtime authentication
- ❌ No magic route behavior

It is **pure documentation generation**, not a framework.

---

## 📦 Public Types

Import from the published package:

```ts
import { EndpointDef, OpenApiSpec } from "@uraniadev/sveltekit-valibot-openapi";
```

---

## 🤖 About the Project

This library was not exactly “vibe-coded” or generated blindly.
It was built through an iterative workflow where AI was used **as a technical assistant**, not as an author.

All architectural decisions, schema handling logic, and API design were intentionally crafted by the maintainer, with AI serving as a tool to accelerate refactoring, validate edge cases, and improve TypeScript ergonomics.

Every line of code was reviewed, tested, and integrated with a somehow clear understanding of SvelteKit, Valibot, and OpenAPI constraints.

So any mistake or naivety is purely mine, amplified by AI abuse 😉
