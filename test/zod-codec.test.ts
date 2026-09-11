import { z } from "zod";
import * as mini from "zod/mini";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

function setup<S extends z.core.$ZodType>(schema: S) {
	const extension = extensionFor({
		value: defineZodSchema(schema),
	});
	return {
		extension,
		codec: extension.descriptor.factory(extension.column("value").typeParams)(),
	};
}

it("validates both writes and reads", async () => {
	const { codec } = setup(z.object({ count: z.number().int().positive() }));
	await expect(codec.encode({ count: 2 })).resolves.toBe('{"count":2}');
	await expect(codec.decode({ count: 2 })).resolves.toEqual({ count: 2 });
	await expect(codec.encode({ count: -1 })).rejects.toThrow();
	await expect(codec.decode({ count: -1 })).rejects.toThrow();
	expect(() => codec.encodeJson({ count: -1 })).toThrow();
	expect(() => codec.decodeJson({ count: -1 })).toThrow();
});

it("persists input and applies non-idempotent transforms once on each read", async () => {
	const { codec } = setup(z.string().transform((value) => `${value}!`));
	const wire = await codec.encode("hello");
	expect(wire).toBe('"hello"');
	await expect(codec.decode(JSON.parse(wire))).resolves.toBe("hello!");
	expect(codec.decodeJson(codec.encodeJson("hello"))).toBe("hello!");
});

it.each(['"hello"', "true", "null", "42", '{"a":1}'])(
	"preserves parsed JSONB string %s",
	async (value) => {
		const { codec } = setup(z.string());
		await expect(codec.decode(value)).resolves.toBe(value);
	},
);

it("preserves refinements after serialized type params are reloaded", async () => {
	const binding = defineZodSchema(z.string().refine((s) => s.startsWith("ok")));
	const authored = extensionFor({ value: binding });
	const params = JSON.parse(
		JSON.stringify(authored.column("value").typeParams),
	);
	const loaded = extensionFor({ value: binding });
	const codec = loaded.descriptor.factory(params)();
	await expect(codec.encode("bad")).rejects.toThrow();
	await expect(codec.decode("ok!")).resolves.toBe("ok!");
	expect(() =>
		loaded.descriptor.factory({ ...params, export: "Other" }),
	).toThrow("mismatched");
	expect(() =>
		loaded.descriptor.factory({ ...params, key: "toString" }),
	).toThrow("Missing");
});

it("supports async validation and transforms at the query boundary", async () => {
	const { codec } = setup(z.string().transform(async (s) => s.length));
	await expect(codec.encode("abcd")).resolves.toBe('"abcd"');
	await expect(codec.decode("abcd")).resolves.toBe(4);
	expect(() => codec.decodeJson("abcd")).toThrow();
	expect(() => codec.encodeJson("abcd")).toThrow();
});

it("supports Mini, unions, lazy schemas and defaults", async () => {
	await expect(setup(mini.string()).codec.decode("mini")).resolves.toBe("mini");
	const recursive = z.lazy(() => z.object({ name: z.string() }));
	await expect(setup(recursive).codec.decode({ name: "a" })).resolves.toEqual({
		name: "a",
	});
	await expect(
		setup(z.union([z.number(), z.string()])).codec.decode(2),
	).resolves.toBe(2);
	await expect(
		setup(z.object({ name: z.string().default("guest") })).codec.decode({}),
	).resolves.toEqual({ name: "guest" });
});

it.each([
	undefined,
	NaN,
	Infinity,
	-0,
	1n,
	new Date(),
	new Map(),
	{ a: undefined },
	[undefined],
	Symbol("a"),
	() => 1,
])("rejects lossy JSON inputs %s", async (value) => {
	await expect(setup(z.unknown()).codec.encode(value)).rejects.toThrow();
});

it("rejects cycles but permits shared objects", async () => {
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	await expect(setup(z.unknown()).codec.encode(cycle)).rejects.toThrow(
		"Cyclic",
	);
	const a = { x: 1 };
	await expect(setup(z.unknown()).codec.encode({ a, b: a })).resolves.toBe(
		'{"a":{"x":1},"b":{"x":1}}',
	);
});

it("supports non-JSON schema inputs through explicit serialization", async () => {
	const binding = defineZodSchema(z.date(), {
		serialization: {
			serialize: (date) => date.toISOString(),
			deserialize: (json) => new Date(z.string().parse(json)),
		},
	});
	const extension = extensionFor({ date: binding });
	const codec = extension.descriptor.factory(
		extension.column("date").typeParams,
	)();
	const date = new Date("2026-01-01T00:00:00Z");
	expect(codec.decodeJson(codec.encodeJson(date))).toEqual(date);
	await expect(
		codec.decode(JSON.parse(await codec.encode(date))),
	).resolves.toEqual(date);
});

it("keeps emitter callbacks bound and resolves both type-map positions", () => {
	const { extension } = setup(z.string().transform(Number));
	const { factory, renderInputType, renderOutputType } = extension.descriptor;
	const params = extension.column("value").typeParams;
	expect(factory(params)().decodeJson("36")).toBe(36);
	expect(renderInputType(params)).toBe(
		'ZodTypes["zod/json@1"]["schemas"]["value"]["input"]',
	);
	expect(renderOutputType(params)).toBe(
		'ZodTypes["zod/json@1"]["schemas"]["value"]["output"]',
	);
	expect(extension.control.types?.codecTypes?.codecDescriptors).toEqual([
		extension.descriptor,
	]);
	expect(extension.runtime.codecs?.()).toEqual([extension.descriptor]);
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

it("accepts Zod codecs without reversing their transformations", async () => {
	const schema = z.codec(z.string(), z.number(), {
		decode: Number,
		encode: String,
	});
	const { codec } = setup(schema);
	await expect(codec.encode("12")).resolves.toBe('"12"');
	await expect(codec.decode("12")).resolves.toBe(12);
});

it("rejects a serializer whose stored value fails validation", async () => {
	const binding = defineZodSchema(z.number().positive(), {
		serialization: {
			serialize: () => -1,
			deserialize: (value) => z.number().parse(value),
		},
	});
	const extension = extensionFor({ value: binding });
	const codec = extension.descriptor.factory(
		extension.column("value").typeParams,
	)();
	await expect(codec.encode(2)).rejects.toThrow();
	expect(() => codec.encodeJson(2)).toThrow();
});
