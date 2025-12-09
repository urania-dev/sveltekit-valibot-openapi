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

Export `_openapi` from your route module.
Each key is an HTTP method, each value is created with `defineEndpoint`.

Works in SvelteKit, but nothing here is tied to it — any environment that can pass a module map into the generator works.

```ts
// src/routes/api/todos/+server.ts
import * as v from "valibot";
import { defineEndpoint } from "@uraniadev/sveltekit-valibot-openapi";

const Todo = v.object({
  id: v.string(),
  title: v.string(),
});

const TodoList = v.array(Todo);
const TodoCreate = v.object({
  title: v.string(),
});

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

// SvelteKit handlers (not related to OpenAPI)
export const GET = async () => new Response("...");
export const POST = async () => new Response("...");
```

---

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

## 📝 Request Bodies

### Simple JSON schema

```ts
body: UserSchema;
```

Produces:

```json
{ "content": { "application/json": { "schema": ... } } }
```

### Optional body

```ts
body: {
  required: false,
  content: {
    "application/json": PartialUserSchema
  }
}
```

### Multiple media types

```ts
defineEndpoint({
  method: "POST",
  path: "/api/profile",
  body: {
    content: {
      "application/json": v.object({ name: v.string() }),
      "multipart/form-data": v.object({
        name: v.string(),
        avatar: v.string(),
      }),
    },
  },
  responses: { 204: { description: "Profile updated" } },
});
```

---

## 📤 Responses

You may declare:

- a JSON schema (`schema`)
- a multi-media `content` map
- or both (JSON fallback is added only if not already present)

```ts
defineEndpoint({
  method: "GET",
  path: "/api/example",
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
      schema: v.object({ ok: v.string() }),
    },
  },
});
```

---

## 🔍 Query Parameters

Query schemas **must be object-like** (object, optional/nullable/pipe wrappers, or unions of objects with matching keys).

Properties → OpenAPI `parameters`.

```ts
const Query = v.object({
  search: v.optional(v.string()),
  limit: v.number(),
  verbose: v.optional(v.boolean()),
  sort: v.union([v.literal("asc"), v.literal("desc")]),
});

defineEndpoint({
  method: "GET",
  path: "/api/items",
  query: Query,
  responses: { 200: { description: "OK" } },
});
```

The generator:

- unwraps Valibot pipeline types
- enforces object-only queries
- rejects arrays/primitives
- ensures union branches align

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
