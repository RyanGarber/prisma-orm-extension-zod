import { Temporal } from "ponyfill-temporal";
import { z } from "zod";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";

function codecFor(schema: z.core.$ZodType = z.unknown()) {
	const ext = createZodExtension(
		{ value: defineZodSchema(schema) },
		{ module: "./schemas", export: "SchemaTypes" },
	);
	return ext.descriptor.factory(ext.column("value").typeParams)();
}
const values = [
	String.fromCharCode(0, 0xd800),
	{ [String.fromCharCode(0, 0xdc00)]: "key" },
	undefined,
	NaN,
	Infinity,
	-Infinity,
	-0,
	12345678901234567890n,
	new Date("2026-09-12T00:00:00.123Z"),
	new Date(NaN),
	new Map([["date", new Date(0)]]),
	new Set([1, undefined, 2n]),
	/orchids/giu,
	new URL("https://example.com/a?q=b"),
	new URLSearchParams("a=1&a=2"),
	Object(1),
	Object(false),
	Object("hello"),
	Object(42n),
	Object.assign(Object.create(null), { x: 1 }),
	Object.assign(new Array(3), { 0: undefined, 2: 1 }),
	{ x: undefined },
	new Error("failure", { cause: new TypeError("underlying") }),
	new AggregateError([new RangeError("range"), 1n], "failures"),
	new Uint8Array([0, 127, 255]).buffer,
	new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2),
	new Int8Array([-128, 127]),
	new Uint8Array([255]),
	new Uint8ClampedArray([255]),
	new Int16Array([-32768]),
	new Uint16Array([65535]),
	new Int32Array([-2147483648]),
	new Uint32Array([4294967295]),
	new Float32Array([NaN, Infinity, -0]),
	new Float64Array([Math.PI, -Infinity]),
	new BigInt64Array([-1n]),
	new BigUint64Array([18446744073709551615n]),
	Buffer.from("hello"),
	Temporal.PlainDateTime.from("2026-09-12T12:34:56.123456789"),
	Temporal.PlainDate.from("2026-09-12"),
	Temporal.PlainTime.from("12:34:56"),
	Temporal.Instant.from("2026-09-12T00:00Z"),
	Temporal.Duration.from("P1DT2H"),
	Temporal.PlainYearMonth.from("2026-09"),
	Temporal.PlainMonthDay.from("09-12"),
	Temporal.ZonedDateTime.from("2026-09-12T12:00[America/New_York]"),
];

it.each(values.map((value, index) => ({ value, index })))(
	"round-trips standard value $index at root and inside tool output",
	async ({ value }) => {
		for (const [schema, input] of [
			[z.unknown(), value],
		] as const) {
			const codec = codecFor(schema);
			const expected = z.core.parse(schema, input);
			expect(
				await codec.decode(JSON.parse(await codec.encode(input))),
			).toStrictEqual(expected);
			expect(
				codec.decodeJson(JSON.parse(JSON.stringify(codec.encodeJson(input)))),
			).toStrictEqual(expected);
		}
	},
);

it("validates and restores z.date without callbacks", async () => {
	const codec = codecFor(z.object({ createdAt: z.date() }));
	const input = { createdAt: new Date() };
	expect(
		await codec.decode(JSON.parse(await codec.encode(input))),
	).toStrictEqual(input);
	expect(codec.decodeJson(codec.encodeJson(input))).toStrictEqual(input);
	await expect(codec.encode({ createdAt: "2026-09-12" })).rejects.toThrow();
	await expect(codec.encode({ createdAt: new Date(NaN) })).rejects.toThrow();
});

it("preserves graph identity, cycles, sparse arrays, and shared binary backing stores", async () => {
	const buffer = new ArrayBuffer(16);
	const shared = { value: 1 };
	const input: {
		a: object;
		b: object;
		buffer: ArrayBuffer;
		view: Uint8Array;
		sparse: unknown[];
		self?: unknown;
		map?: Map<unknown, unknown>;
		set?: Set<unknown>;
	} = {
		a: shared,
		b: shared,
		buffer,
		view: new Uint8Array(buffer, 4, 4),
		sparse: new Array(100),
	};
	input.self = input;
	input.map = new Map([[input, shared]]);
	input.set = new Set([input]);
	const codec = codecFor();
	for (const result of [
		await codec.decode(JSON.parse(await codec.encode(input))),
		codec.decodeJson(codec.encodeJson(input)),
	] as (typeof input)[]) {
		expect(result.self).toBe(result);
		expect(result.a).toBe(result.b);
		expect((result.map as Map<unknown, unknown>).get(result)).toBe(result.a);
		expect((result.set as Set<unknown>).has(result)).toBe(true);
		expect((result.view as Uint8Array).buffer).toBe(result.buffer);
		expect(0 in (result.sparse as unknown[])).toBe(false);
	}
});

it("preserves Error details and RegExp state", async () => {
	const error = new TypeError("failure", { cause: new Error("cause") });
	Object.assign(error, { code: "TOOL_FAILED", when: new Date(0) });
	const regexp = /hello/g;
	regexp.lastIndex = 3;
	const codec = codecFor();
	const result = (await codec.decode(
		JSON.parse(await codec.encode({ error, regexp })),
	)) as { error: typeof error; regexp: RegExp };
	expect(result.error).toBeInstanceOf(TypeError);
	expect(result.error.cause).toBeInstanceOf(Error);
	expect(Object.getOwnPropertyNames(result.error).sort()).toEqual(
		Object.getOwnPropertyNames(error).sort(),
	);
	expect(result.error.stack).toBe(error.stack);
	expect(result.regexp.lastIndex).toBe(3);
});

it("reads legacy JSON and escapes new inputs that resemble serialization envelopes", async () => {
	const codec = codecFor();
	for (const input of [
		{ plain: [1, "hello", null] },
		"$prismaZod",
		{ $prismaZod: "devalue@1", value: [1] },
		{ $prismaZod: "user data" },
	]) {
		expect(
			await codec.decode(JSON.parse(await codec.encode(input))),
		).toStrictEqual(input);
	}
	expect(await codec.decode({ ordinary: "legacy row" })).toEqual({
		ordinary: "legacy row",
	});
	expect(await codec.encode({ plain: [1, "hello", null] })).toBe(
		'{"plain":[1,"hello",null]}',
	);
	await expect(
		codec.decode({ $prismaZod: "future@2", value: [] }),
	).rejects.toThrow("unsupported");
});

it.each([() => 1, new WeakMap(), new WeakSet(), Promise.resolve(1)])(
	"rejects non-persistable values with paths",
	async (value) => {
		const codec = codecFor();
		await expect(codec.encode({ nested: [value] })).rejects.toThrow(
			"$.nested[0]",
		);
		expect(() => codec.encodeJson({ nested: [value] })).toThrow();
	},
);

it("preserves repeated errors and circular causes", async () => {
	const error = new Error("cycle");
	error.cause = error;
	const codec = codecFor();
	for (const result of [
		await codec.decode(JSON.parse(await codec.encode({ a: error, b: error }))),
		codec.decodeJson(codec.encodeJson({ a: error, b: error })),
	] as { a: Error; b: Error }[]) {
		expect(result.a).toBeInstanceOf(Error);
		expect(result.a).toBe(result.b);
		expect(result.a.cause).toBe(result.a);
	}
});

it("preserves symbols, symbol keys, and special object keys without prototype mutation", async () => {
	const symbol = Symbol("local");
	const value: {
		symbol: symbol;
		again: symbol;
		global: symbol;
		known: symbol;
		boxed: { valueOf(): symbol };
		self?: unknown;
		[key: symbol]: unknown;
		__proto__?: unknown;
	} = {
		symbol,
		again: symbol,
		global: Symbol.for("registry"),
		known: Symbol.iterator,
		boxed: Object(symbol),
		[symbol]: new Date(0),
	};
	Object.defineProperty(value, "__proto__", {
		value: "ordinary property",
		enumerable: true,
	});
	value.self = value;
	const codec = codecFor();
	for (const result of [
		await codec.decode(JSON.parse(await codec.encode(value))),
		codec.decodeJson(codec.encodeJson(value)),
	] as (typeof value)[]) {
		const restored = result.symbol as symbol;
		expect(restored.description).toBe("local");
		expect(restored).toBe(result.again);
		expect(result[restored]).toEqual(new Date(0));
		expect((result.boxed as { valueOf(): symbol }).valueOf()).toBe(restored);
		expect(result.global).toBe(Symbol.for("registry"));
		expect(result.known).toBe(Symbol.iterator);
		expect(result.self).toBe(result);
		expect(Reflect.get(result, "__proto__")).toBe("ordinary property");
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	}
});
