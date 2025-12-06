# SvelteKit + Valibot → OpenAPI 3.1

Generate an OpenAPI 3.1 specification from your SvelteKit routes and Valibot
schemas — **no runtime magic**, **no validation side-effects**, just clean
documentation.

- 🧩 Works with SvelteKit `+server` routes
- ✅ Uses Valibot schemas for types **and** OpenAPI generation
- 🧾 Supports multiple request/response media types
- 🔍 Emits typed query parameters as OpenAPI `parameters`
- 🔐 Documents authentication via OpenAPI `securitySchemes` / `security`

This library **does not** enforce validation or authentication at runtime.
It only **documents** what your API looks like.

---

## 🚀 Installation

```bash
pnpm add @uraniadev/sveltekit-valibot-openapi valibot @valibot/to-json-schema
```

---

## 📘 Defining endpoints

Inside your SvelteKit route modules, export an `_openapi` object.
Each key is an HTTP method, and each value comes from `defineEndpoint`.

```ts
// src/routes/api/todos/+server.ts
import type { RequestHandler } from "./$types";
import { object, string, array } from "valibot";
import { defineEndpoint } from "@uraniadev/sveltekit-valibot-openapi";

const TodoSchema = object({
  id: string(),
  title: string(),
});

const TodoListSchema = array(TodoSchema);
const TodoCreateSchema = object({
  title: string(),
});

export const _openapi = {
  GET: defineEndpoint({
    method: "GET",
    path: "/api/todos",
    summary: "List todos",
    query: object({
      search: string().optional(),
    }),
    responses: {
      200: {
        description: "List of todos",
        schema: TodoListSchema,
      },
    },
  }),

  POST: defineEndpoint({
    method: "POST",
    path: "/api/todos",
    summary: "Create a todo",
    body: TodoCreateSchema,
    responses: {
      201: {
        description: "Created todo",
        schema: TodoSchema,
      },
    },
  }),
} as const;

export const GET: RequestHandler = async () => new Response("...");
export const POST: RequestHandler = async () => new Response("...");
```

---

## 📡 Creating the OpenAPI route

```ts
// src/routes/openapi/+server.ts
import { createOpenApiHandler } from "@uraniadev/sveltekit-valibot-openapi";

export const GET = createOpenApiHandler(
  import.meta.glob("../api/**/+server.{ts,js}"),
  {
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
  }
);
```

Now visit:

```
/openapi
```

…and you get your live OpenAPI 3.1 JSON.
Point Scalar, Swagger UI, Redoc, or Postman at it.

---

## 📝 Request Bodies

### Single media type (`application/json`)

```ts
body: MyJsonSchema;
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
const JsonSchema = object({ name: string() });
const MultipartSchema = object({
  name: string(),
  avatar: string(),
});

defineEndpoint({
  method: "POST",
  path: "/api/profile",
  body: {
    content: {
      "application/json": JsonSchema,
      "multipart/form-data": MultipartSchema,
    },
  },
  responses: {
    204: { description: "Profile updated" },
  },
});
```

---

## 📤 Responses

Supports:

- `schema` (simple JSON response)
- `content` (multi-media)
- both

```ts
defineEndpoint({
  method: "GET",
  path: "/api/example",
  responses: {
    200: {
      description: "Multiple formats",
      content: {
        "application/json": object({ ok: string() }),
        "text/plain": string(),
        "image/png": string(),
      },
    },
    404: {
      description: "Not found",
      schema: object({ ok: string() }),
    },
  },
});
```

---

## 🔍 Query Parameters

Object schemas become OpenAPI `parameters`.

```ts
const QuerySchema = object({
  search: string().optional(),
  limit: number(),
  verbose: boolean().optional(),
  sort: union([literal("asc"), literal("desc")]),
});

defineEndpoint({
  method: "GET",
  path: "/api/items",
  query: QuerySchema,
  responses: {
    200: { description: "OK" },
  },
});
```

---

## 🔐 Authentication

### Global

```ts
createOpenApiHandler(glob, {
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    },
  },
  security: [{ bearerAuth: [] }],
});
```

### Override per-endpoint

```ts
defineEndpoint({
  method: "GET",
  path: "/api/public",
  responses: { 200: { description: "OK" } },
  security: [], // no auth
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

This library was not “vibe-coded” or generated blindly.
It was built through an iterative workflow where AI was used **as a technical assistant**, not as an author.

All architectural decisions, schema handling logic, and API design were intentionally crafted by the maintainer, with AI serving as a tool to accelerate refactoring, validate edge cases, and improve TypeScript ergonomics.

Every line of code was reviewed, tested, and integrated with a clear understanding of SvelteKit, Valibot, and OpenAPI constraints.

So any mistake or naivety is purely mine, amplified by AI abuse 😉
