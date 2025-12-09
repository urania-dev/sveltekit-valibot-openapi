import * as v from "valibot";

import { toCleanJsonSchema } from "../src/lib/openapi/sveltekit"; // adjust path
import { createOpenApiSpec } from "../src/lib/openapi/sveltekit";

// Mock a module that simulates a SvelteKit API `+server.ts`
const fakeModule = {
  _openapi: {
    GET: {
      method: "GET",
      path: "/api/test",
      query: v.object({
        from: v.nullable(v.date()),
        page: v.number(),
        search: v.optional(v.string()),
      }),
      responses: {
        200: {
          description: "OK",
          schema: v.object({
            createdAt: v.date(),
            id: v.string(),
            tags: v.array(v.string()),
          })
        }
      },
      summary: "Test endpoint"
    }
  }
};

// Simulates import.meta.glob
const modules = {
  "/src/routes/api/test/+server.ts": async () => fakeModule
};

async function run() {
  console.log("=== Test: date() → OpenAPI format ===");

  const schema = toCleanJsonSchema(
    v.object({
      createdAt: v.date(),
      updatedAt: v.nullable(v.date()),
    }),
    "output"
  );

  console.log(JSON.stringify(schema, null, 2));

  console.log("\n=== Test: generate full OpenAPI spec ===");

  const spec = await createOpenApiSpec(modules, {
    info: { title: "Local Test", version: "1.0.0" }
  });

  console.dir(spec, { depth: 20 });
}

run();
