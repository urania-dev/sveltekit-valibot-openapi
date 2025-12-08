# Valibot → OpenAPI 3.1

### (SvelteKit-first, framework-agnostic)

Generate an OpenAPI 3.1 specification from your Valibot schemas and lightweight
endpoint metadata — **no runtime magic**, **no validation side-effects**, just
clean documentation.

- 🧩 First-class support for SvelteKit `+server` routes
- 🔌 Framework-agnostic spec generator (`createOpenApiSpec`)
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

Inside your route modules, export an `_openapi` object.
Each key is an HTTP method, and each value comes from `defineEndpoint`.

The example below uses SvelteKit, but the `_openapi` pattern works in any
framework as long as you can pass the modules into the spec generator.

```ts
// src/routes/api/todos/+server.ts
import type { RequestHandler } from "./$types";
import * as valibot from "valibot";
import { defineEndpoint } from "@uraniadev/sveltekit-valibot-openapi";

const TodoSchema = v.object({
  id: v.string(),
  title: v.string(),
});

const TodoListSchema = array(TodoSchema);
const TodoCreateSchema = v.object({
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

## 📡 Generating and exposing the OpenAPI spec

`createOpenApiSpec` now returns the **OpenAPI spec object**, not a
framework handler. You can use it wherever you like.

### SvelteKit example

```ts
// src/routes/openapi/+server.ts
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { createOpenApiSpec } from "@uraniadev/sveltekit-valibot-openapi";

const modules = import.meta.glob("../api/**/+server.{ts,js}");

export const GET: RequestHandler = async () => {
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

Now visit:

```
/openapi
```

…and you get your live OpenAPI 3.1 JSON.
Point Scalar, Swagger UI, Redoc, or Postman at it.

### Non-SvelteKit / generic usage

As long as you can build a `GlobModules` map (or something compatible),
you can generate the spec anywhere:

```ts
import { createOpenApiSpec } from "@uraniadev/sveltekit-valibot-openapi";

const modules = import.meta.glob("./routes/**/route.{ts,js}");

async function buildSpec() {
  const spec = await createOpenApiSpec(modules, {
    info: {
      title: "My Service",
      version: "1.0.0",
    },
  });

  // Write to file, feed into a UI, etc.
  console.log(JSON.stringify(spec, null, 2));
}
```

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
const JsonSchema = v.object({ name: string() });
const MultipartSchema = v.object({
  name: v.string(),
  avatar: v.string(),
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
        "application/json": v.object({ ok: string() }),
        "text/plain": v.string(),
        "image/png": v.string(),
      },
    },
    404: {
      description: "Not found",
      schema: v.object({ ok: string() }),
    },
  },
});
```

---

## 🔍 Query Parameters

Object schemas become OpenAPI `parameters`.

```ts
const QuerySchema = v.object({
  search: v.optional(v.string()),
  limit: v.number(),
  verbose: v.optional(v.boolean()),
  sort: v.union([literal("asc"), literal("desc")]),
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

### Global security (any framework)

You configure security the same way – directly on the spec generator:

```ts
const spec = await createOpenApiSpec(glob, {
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
  security: [], // no auth for this operation
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
