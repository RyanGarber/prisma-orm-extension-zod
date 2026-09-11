import { expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

it("preserves schema input and output types", () => {
	const transformed = z.string().transform((s) => s.length);
	const branded = z.string().brand<"ID">();
	const extension = extensionFor({
		transformed: defineZodSchema(transformed),
		branded: defineZodSchema(branded),
		literal: defineZodSchema(z.literal("hello")),
	});
	type Transformed = ReturnType<
		ReturnType<typeof extension.column<"transformed">>["codecFactory"]
	>;
	expectTypeOf<Parameters<Transformed["encode"]>[0]>().toEqualTypeOf<string>();
	expectTypeOf<
		Awaited<ReturnType<Transformed["decode"]>>
	>().toEqualTypeOf<number>();
	expectTypeOf<
		Parameters<Transformed["encodeJson"]>[0]
	>().toEqualTypeOf<string>();
	expectTypeOf<ReturnType<Transformed["decodeJson"]>>().toEqualTypeOf<number>();
	type Branded = ReturnType<
		ReturnType<typeof extension.column<"branded">>["codecFactory"]
	>;
	expectTypeOf<Parameters<Branded["encode"]>[0]>().toEqualTypeOf<string>();
	expectTypeOf<Awaited<ReturnType<Branded["decode"]>>>().toEqualTypeOf<
		z.output<typeof branded>
	>();
	type Literal = ReturnType<
		ReturnType<typeof extension.column<"literal">>["codecFactory"]
	>;
	expectTypeOf<
		Awaited<ReturnType<Literal["decode"]>>
	>().toEqualTypeOf<"hello">();
	// @ts-expect-error Unknown registration key
	extension.column("missing");
});

function extensionFor<
	const S extends Readonly<
		Record<string, import("../src/core/schema").ZodSchema>
	>,
>(schemas: S) {
	return createZodExtension(schemas, {
		module: "./schemas",
		export: "SchemaTypes",
	});
}
