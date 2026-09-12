import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import { parse, stringify } from "devalue";
import { Temporal } from "ponyfill-temporal";
import { jsonValue } from "./schema";

// Reserved only at the root. Inputs containing this key are themselves encoded,
// so user data cannot be confused with an envelope on newly written rows.
const marker = "$prismaZod";
const format = "devalue@1";

const errorTypes = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
	AggregateError,
};
const wellKnownSymbols = Object.fromEntries(
	Object.getOwnPropertyNames(Symbol)
		.map((name) => [name, Reflect.get(Symbol, name)])
		.filter(([, value]) => typeof value === "symbol"),
) as Record<string, symbol>;
const reducers = {
	Symbol: (value: unknown) => {
		if (typeof value !== "symbol") return false;
		const known = Object.entries(wellKnownSymbols).find(
			([, symbol]) => symbol === value,
		);
		const key = Symbol.keyFor(value);
		return known
			? ["known", known[0]]
			: key !== undefined
				? ["global", key]
				: ["local", value.description];
	},
	SymbolObject: (value: unknown) =>
		value &&
		typeof value === "object" &&
		Object.prototype.toString.call(value) === "[object Symbol]" && [
			Symbol.prototype.valueOf.call(value),
		],
	ObjectProperties: (value: unknown) => {
		if (!value || typeof value !== "object") return false;
		const proto = Object.getPrototypeOf(value);
		if (proto !== null && proto !== Object.prototype) return false;
		if (
			!Object.hasOwn(value, "__proto__") &&
			!Object.getOwnPropertySymbols(value).some((key) =>
				Object.prototype.propertyIsEnumerable.call(value, key),
			)
		)
			return false;
		return [
			proto === null,
			new Map(
				Reflect.ownKeys(value)
					.filter((key) =>
						Object.prototype.propertyIsEnumerable.call(value, key),
					)
					.map((key) => [key, Reflect.get(value, key)]),
			),
		];
	},
	...Object.fromEntries(
		Object.entries(errorTypes).map(([name, ErrorType]) => [
			`Error.${name}`,
			(value: unknown) =>
				value instanceof ErrorType &&
				Object.getPrototypeOf(value) === ErrorType.prototype &&
				Object.fromEntries(
					Reflect.ownKeys(value).map((key) => [key, Reflect.get(value, key)]),
				),
		]),
	),
	Buffer: (value: unknown) =>
		typeof Buffer !== "undefined" &&
		Buffer.isBuffer(value) &&
		new Uint8Array(value),
	RegExpState: (value: unknown) =>
		value instanceof RegExp && [value.source, value.flags, value.lastIndex],
};

function createRevivers() {
	const errors = new WeakMap<object, Error>();
	const objects = new WeakMap<object, object>();
	return {
		Symbol: ([kind, value]: [string, string | undefined]) => {
			if (kind === "local") return Symbol(value);
			if (typeof value !== "string")
				throw new TypeError("Invalid symbol payload");
			if (kind === "global") return Symbol.for(value);
			if (kind === "known" && Object.hasOwn(wellKnownSymbols, value))
				return wellKnownSymbols[value];
			throw new TypeError("Invalid symbol payload");
		},
		SymbolObject: ([value]: [symbol]) => Object(value),
		ObjectProperties: (payload: [boolean, Map<PropertyKey, unknown>?]) => {
			let object = objects.get(payload);
			if (!object) {
				object = Object.create(payload[0] ? null : Object.prototype) as object;
				objects.set(payload, object);
			}
			for (const [key, value] of payload[1] ?? []) {
				Object.defineProperty(object, key, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return object;
		},
		...Object.fromEntries(
			Object.entries(errorTypes).map(([name, ErrorType]) => [
				`Error.${name}`,
				(value: Record<string, unknown>) => {
					let error = errors.get(value);
					if (!error) {
						error = Reflect.construct(
							ErrorType,
							name === "AggregateError" ? [[]] : [],
						) as Error;
						errors.set(value, error);
						for (const key of Object.getOwnPropertyNames(error))
							Reflect.deleteProperty(error, key);
					}
					// A cyclic cause can revisit this payload while it is being hydrated.
					// Reuse the Error instance and copy the completed payload on the final visit.
					const descriptors = Object.getOwnPropertyDescriptors(value);
					for (const key of ["message", "stack", "cause", "errors"]) {
						const descriptor = descriptors[key];
						if (descriptor) descriptor.enumerable = false;
					}
					Object.defineProperties(error, descriptors);
					return error;
				},
			]),
		),
		Buffer: (value: Uint8Array) => {
			if (typeof Buffer === "undefined")
				throw new TypeError(
					"Buffer values require a runtime with Buffer support",
				);
			return Buffer.from(value);
		},
		RegExpState: ([source, flags, lastIndex]: [string, string, number]) => {
			const value = new RegExp(source, flags);
			value.lastIndex = lastIndex;
			return value;
		},
		...Object.fromEntries(
			Object.getOwnPropertyNames(Temporal).flatMap((name) => {
				const TemporalType = Temporal[name as keyof typeof Temporal];
				return "from" in TemporalType
					? [[`Temporal.${name}`, (value: string) => TemporalType.from(value)]]
					: [];
			}),
		),
	};
}

export function serialize(value: unknown): JsonValue {
	try {
		// Keep JSON-only rows queryable in their original shape. jsonValue rejects
		// anything whose type or reference identity would be lost by ordinary JSON.
		if (!(value && typeof value === "object" && Object.hasOwn(value, marker))) {
			return jsonValue(value, new Set(), true);
		}
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
	}
	try {
		// Keep the devalue document as text: JSONB cannot store NUL characters or
		// lone UTF-16 surrogates as JSON string values. Escaping the inner document
		// preserves them without exposing invalid Unicode to PostgreSQL.
		const payload = stringify(value, reducers).replace(
			/[\uD800-\uDFFF]/g,
			(character) =>
				`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
		return { [marker]: format, value: payload };
	} catch (error) {
		const path =
			error && typeof error === "object" && "path" in error
				? String(error.path)
				: "";
		throw new TypeError(
			`Cannot serialize value at $${path}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export function deserialize(value: JsonValue): unknown {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, marker)
	) {
		const envelope = value as { [marker]: JsonValue; value?: JsonValue };
		if (
			envelope[marker] !== format ||
			!Object.hasOwn(value, "value") ||
			Object.keys(value).length !== 2
		) {
			throw new TypeError("Invalid or unsupported Zod serialization envelope");
		}
		const payload = envelope.value;
		if (typeof payload !== "string")
			throw new TypeError("Invalid Zod serialization payload");
		return parse(payload, createRevivers());
	}
	return value;
}
