/* eslint-disable @typescript-eslint/no-explicit-any */
// debug.ts
// Run this with: bun run debug.ts
// This environment contains NO SvelteKit. Only your OpenAPI generator + fake endpoints.

import { toJsonSchema as _toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import { createOpenApiSpec } from "./src/openapi/create-specs.js";
import { normalizeSchema as _normalizeSchema } from "./src/openapi/create-specs.js";

export const PaginationSchema = v.nullish(
	v.object({
		desc: v.nullish(
			v.pipe(
				v.unknown(),
				v.transform((s) => (s === 'false' ? false : true))
			),
			true
		),
		limit: v.fallback(v.nullish(v.number(), 10), 10),
		page: v.fallback(v.nullish(v.number(), 1), 1),
		query: v.nullish(v.string()),
		sort: v.nullish(v.string(), 'createdAt')
	})
);
export type Pagination = v.InferOutput<typeof PaginationSchema>;
export type PaginationInput = v.InferInput<typeof PaginationSchema>;

export const ParamsSchema = v.object({
	desc: v.nullish(
		v.pipe(
			v.unknown(),
			v.transform((s) => (s === 'false' ? false : true))
		),
		true
	),
	limit: v.pipe(
		v.optional(v.string()),
		v.transform((i) => (i && !isNaN(parseInt(i)) ? parseInt(i) : undefined))
	),
	page: v.pipe(
		v.optional(v.string(), '1'),
		v.transform((i) => (i && !isNaN(parseInt(i)) ? parseInt(i) : 1))
	),
	query: v.nullish(v.string()),
	sort: v.nullish(v.string(), 'createdAt'),
	tags: v.pipe(
		v.optional(v.string()),
		v.transform(
			(i) => (i?.trim() !== ',' ? i?.split(',').filter((t) => t.trim() !== '') : []) as string[]
		)
	)
});

export const UrlExpandConfig = {
	organization: {
		columns: ['id', 'name', 'logo', 'createdAt'] as const,
		relations: {
			teams: {
				columns: ['id', 'name', 'organizationId'] as const
			}
		}
	},
	tags: {
		columns: ['id', 'tag'] as const
	},
	teams: {
		columns: ['id', 'name', 'organizationId'] as const,
		relations: {
			organization: {
				columns: ['id', 'name', 'logo', 'createdAt'] as const
			}
		}
	},
	user: {
		columns: ['id', 'username', 'role', 'createdAt'] as const,
		relations: {
			urls: {
				columns: ['id', 'originalUrl', 'shortcode'] as const
			}
		}
	}
} as const;

type ConfigNode = {
	readonly columns?: readonly string[];
	readonly relations?: Record<string, ConfigNode>;
};

const walkConfig = (
	node: ConfigNode,
	prefix: string,
	expand: string[],
	fields: string[]
) => {
	if (node.columns) {
		for (const col of node.columns) {
			fields.push(prefix ? `${prefix}.${col}` : col);
		}
	}

	if (node.relations) {
		for (const key of Object.keys(node.relations)) {
			const full = prefix ? `${prefix}.${key}` : key;
			expand.push(full);
			walkConfig(node.relations[key], full, expand, fields);
		}
	}
};

const collectExpandPaths = <T extends typeof UrlExpandConfig>(config: T): string[] => {
	const expand: string[] = [];
	const fields: string[] = [];

	for (const raw of Object.keys(config)) {
		const key = raw as keyof T;
		expand.push(raw);
		walkConfig(config[key] as ConfigNode, raw, expand, fields);
	}

	return expand;
};

const collectFieldPaths = <T extends typeof UrlExpandConfig>(config: T): string[] => {
	const expand: string[] = [];
	const fields: string[] = [];

	for (const raw of Object.keys(config)) {
		const key = raw as keyof T;
		walkConfig(config[key] as ConfigNode, raw, expand, fields);
	}

	return fields;
};

const AllowedURLExpand = collectExpandPaths(UrlExpandConfig);
const AllowedURLFields = collectFieldPaths(UrlExpandConfig);


type BuildResult = {
	columns?: Record<string, true>; 
	with?: RelationMap;             
};

type RelationLeaf = {
	columns?: Record<string, true>;
	with?: RelationMap;
};

type RelationMap = Record<string, RelationLeaf>;

export const BuildRelationsFromParams = (
	expand?: string[],
	fields?: string[]
): BuildResult | undefined => {
	if ((!expand || expand.length === 0) && (!fields || fields.length === 0)) {
		return undefined;
	}

	const rootWith: RelationMap = {};
	const rootColumns: Record<string, true> = {};
	const fieldOverride: Record<string, true> = {};

	// 1. Handle expand → create relation tree with default columns
	if (expand) {
		for (const path of expand) {
			const parts = path.split('.');
			if (parts.length === 0) continue;

			let cfg: ConfigNode | undefined;
			let map: RelationMap = rootWith;

			for (let i = 0; i < parts.length; i++) {
				const seg = parts[i];

				if (i === 0) {
					const top = UrlExpandConfig[seg as keyof typeof UrlExpandConfig];
					if (!top) {
						cfg = undefined;
						break;
					}
					cfg = top as unknown as ConfigNode;
				} else {
					if (!cfg?.relations) {
						cfg = undefined;
						break;
					}
					cfg = cfg.relations[seg];
					if (!cfg) break;
				}

				const existing = map[seg];
				const leaf: RelationLeaf = existing ?? (map[seg] = {});
				const isLast = i === parts.length - 1;

				if (isLast && cfg.columns) {
					if (!leaf.columns) leaf.columns = {};
					for (const col of cfg.columns) {
						leaf.columns[col] = true;
					}
				}

				if (!leaf.with) leaf.with = {};
				map = leaf.with;
			}
		}
	}

	// 2. Handle fields → base columns + override relation columns
	if (fields) {
		for (const path of fields) {
			if (!path) continue;

			const parts = path.split('.');

			// root-level field: `id`, `shortcode`, ...
			if (parts.length === 1) {
				const colName = parts[0];
				rootColumns[colName] = true;
				continue;
			}

			// relational field: `user.id`, `user.urls.id`, ...
			const relParts = parts.slice(0, -1);
			const colName = parts[parts.length - 1];

			let cfg: ConfigNode | undefined;
			let map: RelationMap = rootWith;
			let relPath = '';

			for (let i = 0; i < relParts.length; i++) {
				const seg = relParts[i];

				if (i === 0) {
					const top = UrlExpandConfig[seg as keyof typeof UrlExpandConfig];
					if (!top) {
						cfg = undefined;
						break;
					}
					cfg = top as unknown as ConfigNode;
					relPath = seg;
				} else {
					if (!cfg?.relations) {
						cfg = undefined;
						break;
					}
					cfg = cfg.relations[seg];
					if (!cfg) break;
					relPath = `${relPath}.${seg}`;
				}

				const existing = map[seg];
				const leaf: RelationLeaf = existing ?? (map[seg] = {});
				const isLastRel = i === relParts.length - 1;

				if (isLastRel) {
					const allowedCols = cfg?.columns ?? [];
					if (!allowedCols.includes(colName)) break;

					// first time we touch this relation → reset columns to empty, then add only requested ones
					if (!fieldOverride[relPath]) {
						leaf.columns = {};
						fieldOverride[relPath] = true;
					}

					if (!leaf.columns) leaf.columns = {};
					leaf.columns[colName] = true;
				}

				if (!leaf.with) leaf.with = {};
				map = leaf.with;
			}
		}
	}

	if (
		Object.keys(rootColumns).length === 0 &&
		Object.keys(rootWith).length === 0
	) {
		return undefined;
	}

	return {
		columns: Object.keys(rootColumns).length > 0 ? rootColumns : undefined,
		with: Object.keys(rootWith).length > 0 ? rootWith : undefined
	};
};
export const EnforcedPaginationSchema = v.pipe(
	v.optional(
		v.object({ ...ParamsSchema.entries, table: v.optional(v.string()) }),
		{
			desc: true,
			limit: '14',
			page: '1',
			query: undefined,
			sort: 'createdAt'
		}
	),
	v.transform((input) => {
		const limitCookie = input?.table ?? '15'
		const limit = input.limit
			? input.limit
			: limitCookie && !isNaN(parseInt(limitCookie))
				? parseInt(limitCookie)
				: input.limit || 14;

		const offset = Math.max(input.page - 1, 0) * limit;
		const colCookie = input?.table
			? "14"
			: undefined;
		const columnVisibility =
			(colCookie && (JSON.parse(colCookie) as { [x: string]: boolean })) || {};

		return {
			...input,
			columns: columnVisibility,
			desc: typeof input.desc === 'boolean' ? input.desc : true,
			limit,
			offset
		};
	})
);

// ---------------------------------------------------------------------
// WRAP normalizeSchema WITH COMPLETE TRACE
// ---------------------------------------------------------------------
function wrapNormalize(fn: any) {
  return (schema: any, budget: any) => {
    console.log("\n\n========== NORMALIZE ENTER ==========");
    console.log("TYPE:", schema?.type);
    console.log("RAW:", schema);
    console.log("BUDGET:", budget);

    let out;
    try {
      out = fn(schema, budget);
    } catch (err) {
      console.log("NORMALIZE ERROR:", err);
      throw err;
    }

    console.log("========== NORMALIZE EXIT ==========");
    console.log("OUT:", out);
    return out;
  };
}

(globalThis as any).normalizeSchema = wrapNormalize(_normalizeSchema);

// force import layer override
// (Bun will use the patched version through the global override)
const normalizeSchema = (globalThis as any).normalizeSchema;


// ---------------------------------------------------------------------
// WRAP toJsonSchema
// ---------------------------------------------------------------------
function wrapToJson(fn: any) {
  return (schema: any, opts: any) => {
    console.log("\n--- VALIBOT → JSON-SCHEMA ---");
    console.log("SCHEMA:", schema);
    console.log("OPTS:", opts);

    try {
      const out = fn(schema, opts);
      console.log("JSON-SCHEMA:", out);
      return out;
    } catch (err) {
      console.log("JSON-SCHEMA ERROR:", err);
      throw err;
    }
  };
}

(globalThis as any).toJsonSchema = wrapToJson(_toJsonSchema);
const toJsonSchema = (globalThis as any).toJsonSchema;


// ---------------------------------------------------------------------
// FAKE ENDPOINTS (NO SVELTEKIT)
// ---------------------------------------------------------------------

// This replicates EXACTLY your ApiParamsSchema (the broken one)
export const ApiParamsSchema = v.pipe(
  v.object({
  desc: v.nullish(
		v.pipe(
			v.unknown(),
			v.transform((s) => (s === 'false' ? false : true))
		),
		true
	),
	expand: v.pipe(
			v.optional(v.string()),
			v.transform((i) => (i ? i.split(',').map((p) => p.trim()).filter((i)=>i !== undefined): []))
		),
	fields: v.pipe(
			v.optional(v.string()),
			v.transform((i) => (i ? i.split(',').map((p) => p.trim()).filter((i)=>i !== undefined): []))
		),
	limit: v.pipe(
		v.optional(v.string()),
		v.transform((i) => (i && !isNaN(parseInt(i)) ? parseInt(i) : undefined))
	),
	page: v.pipe(
		v.optional(v.string(), '1'),
		v.transform((i) => (i && !isNaN(parseInt(i)) ? parseInt(i) : 1))
	),
	query: v.nullish(v.string()),
    	sort: v.nullish(v.string(), 'createdAt'),
		tags: v.pipe(
		v.optional(v.string()),
		v.transform(
			(i) => (i?.trim() !== ',' ? i?.split(',').filter((t) => t.trim() !== '') : []) as string[]
		)
	)
  }),

  v.transform((input) => {
		const limit = input.limit ?? 14;
		const page = Math.max(Number(input.page) || 1, 1);
		const offset = (page - 1) * limit;
		const desc = input.desc === false ? false : true;

		const rawExpand = input.expand ?? [];
		const resolvedExpand: string[] = [];

		for (const token of rawExpand) {
			if (token === '*') {
				resolvedExpand.push(...Object.keys(UrlExpandConfig));
				continue;
			}

			if (token.endsWith('.*')) {
				const base = token.slice(0, -2);
				if (!base) continue;

				if (Object.prototype.hasOwnProperty.call(UrlExpandConfig, base)) {
					resolvedExpand.push(base);
				}

				for (const path of AllowedURLExpand) {
					if (path.startsWith(`${base}.`)) {
						resolvedExpand.push(path);
					}
				}
				continue;
			}

			resolvedExpand.push(token);
		}

		const expand = resolvedExpand.filter(
			(p, idx, self) => AllowedURLExpand.includes(p) && self.indexOf(p) === idx
		);

		const fields =
			input.fields?.filter((p) => {
				if (!p) return false;
				if (!p.includes('.')) return true; 
				return AllowedURLFields.includes(p); 
			}) ?? [];

		return {
			...input,
			desc,
			expand,
			fields,
			limit,
			offset,
			page
		};
	})
);

// Minimal fake route definition
const FakeModule = {
  _openapi: {
    GET: {
      description: "Test query parameter normalization",
      method: "GET",
      query: ApiParamsSchema,
      responses: {
        200: {
          description: "OK",
          schema: v.object({ ok: v.string() })
        }
      },
      summary: "Debug endpoint",
      tags: ["TEST"]
    }
  }
};

// Fake import.meta.glob
const fakeGlob = () => ({
  "/api/test/+server.ts": async () => FakeModule
});

// ---------------------------------------------------------------------
// RUN IT
// ---------------------------------------------------------------------
console.log("\n\n=========== OPENAPI DEBUG RUN ===========\n");

createOpenApiSpec(fakeGlob(), {
  logger: {
    error: (...a) => console.log("OPENAPI ERROR:", ...a),
    info: (...a) => console.log("OPENAPI INFO:", ...a),
    warn: (...a) => console.log("OPENAPI WARN:", ...a),
  }
})
.then((spec) => {
  console.log("\n\n=========== FINAL OPENAPI SPEC ===========\n");
  console.dir(spec, { depth: 20 });
})
.catch((err) => {
  console.log("\n\n=========== OPENAPI FAILURE ===========\n");
  console.error(err);
});
