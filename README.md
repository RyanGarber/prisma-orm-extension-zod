# Prisma 8 Zod extension

Zod 4 validation and separate write/read types for PostgreSQL `jsonb` columns, based on Prisma's official Arktype extension. Requires `@prisma/orm-postgres@8.0.0-rc.8`.

```sh
pnpm add @ryangarber/prisma-orm-extension-zod zod @prisma/orm-postgres@8.0.0-rc.8
```

## Define schemas and register the extension

```ts
// schemas.ts
import { z } from "zod";
export const Profile = z.object({
  name: z.string().min(1),
  age: z.string().regex(/^\d+$/).transform(Number),
});
```

```ts
// zod-extension.ts
import { createZodExtension, defineZodSchema } from "@ryangarber/prisma-orm-extension-zod/column-types";
import type { CodecTypes } from "@ryangarber/prisma-orm-extension-zod/codec-types";
import { Profile } from "./schemas";

const schemas = { Profile: defineZodSchema(Profile) };
export type SchemaTypes = CodecTypes<typeof schemas>;
export const zodExtension = createZodExtension(schemas, {
  module: "./zod-extension", // resolved relative to emitted contract.d.ts
  export: "SchemaTypes",
});
```

Register all schemas in one extension instance, using identifier-shaped keys. Share this module between authoring, control, and runtime. `module` and `export` identify the exported **type map**, not a schema value. Derive that map from the same schema record with `CodecTypes<typeof schemas>`; a mismatched hand-written map can make generated types incorrect. Prisma imports it through its supported type-import mechanism; inline import expressions in codec renderers are rejected by Prisma 8.
```ts
// contract.ts
import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { zodExtension } from "./zod-extension";

export const contract = defineContract(
  { extensions: { zod: zodExtension.pack } },
  ({ field, model }) => ({
    models: {
      User: model("User", {
        fields: {
          id: field.id.uuidv4String(),
          profile: field.column(zodExtension.column("Profile")),
        },
      }).sql({ table: "users" }),
    },
  }),
);
```

```ts
// prisma.config.ts
import { defineConfig } from "@prisma/orm-postgres/config";
import { zodExtension } from "./zod-extension";

export default defineConfig({
  contract: "./contract.ts",
  extensions: [zodExtension.control],
});
```

Supply `zodExtension.runtime` in the Postgres runtime's `extensions` array. Run `prisma contract emit` and use its generated `Contract` type for application queries. The emitted per-column input and output types resolve through the imported schema map to `z.input<typeof Profile>` and `z.output<typeof Profile>`, preserving unions, literals, brands, recursive schemas, and transforms. Prisma's un-emitted builder path may fall back to `unknown`; use emitted contracts for query inference.

## Write and read semantics

Writes accept the schema **input**, validate it, and persist that input as JSON. Reads validate the stored input and return the schema **output**. For the example above, write `{ name: "Ada", age: "36" }` and read `{ name: "Ada", age: 36 }`. The database contains the string age. Output values are not automatically valid write inputs.

Transforms are not inverted and transformed output is not stored. This also applies to Zod codecs: their forward parse runs on reads; their reverse encode is not used. Refinements and transforms should be deterministic and free of side effects: write validation runs before and after serialization. Database comparisons operate on the stored input representation.

The original schema is registered at runtime, rather than converted to JSON Schema. This preserves custom refinements, preprocessors, transforms, codecs, and lazy types without serializing executable functions. Changing a schema or its serialization requires considering existing data and re-emitting the contract; schema code changes are not captured by the contract hash.

Zod Classic and Mini types are accepted through `zod/v4/core`'s `$ZodType`. Query-time encode/decode support async schemas. Prisma's synchronous `encodeJson`/`decodeJson` hooks cannot run async schemas; these throw for async refinements/transforms, including when Prisma uses those hooks for nested JSON results or contract defaults. Use synchronous schemas for those paths.

## Non-JSON inputs

Any Zod type can be registered, but its input still needs a database representation. The default serializer rejects lossy values such as `undefined`, `bigint`, dates, maps, non-finite numbers, cycles, and objects containing unsupported values. Provide synchronous serialization callbacks for these inputs:

```ts
const DateSchema = z.date();
const date = defineZodSchema(DateSchema, {
  serialization: {
    serialize: (value) => value.toISOString(),
    deserialize: (json) => new Date(z.string().parse(json)),
  },
});
```

Callbacks must round-trip the input faithfully. Their JSON output is checked and the deserialized input is validated before a write proceeds. Top-level optional/default schemas receiving `undefined` need a custom representation; object properties absent from the input can still receive defaults on reads. Prisma controls SQL NULL handling separately from Zod nullable schemas.

The driver must provide parsed JSONB values on reads, as the standard Postgres driver does. Raw JSON text is not guessed or automatically parsed, avoiding ambiguity for strings such as `"42"` or `"null"`.

Validation errors preserve Zod's issue paths. Serialization failures throw `TypeError`; missing/mismatched runtime registrations fail at codec materialization.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

The package exposes `column-types`, `codecs`, `codec-types`, `pack`, `control`, and `runtime`. The last three expose the configuration factory, whose result provides the corresponding descriptor. No process-global schema registry is used.
