import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import type { $ZodType, input } from "zod/v4/core";

export interface SchemaOptions<S extends $ZodType> {
	/** Override automatic serialization for application-specific representations. */
	readonly serialization?: {
		serialize(value: input<S>): JsonValue;
		deserialize(value: JsonValue): input<S>;
	};
}

export function defineZodSchema<S extends $ZodType>(
	schema: S,
	options: SchemaOptions<S> = {},
) {
	return { schema, ...options };
}

export type ZodSchema<S extends $ZodType = $ZodType> = ReturnType<
	typeof defineZodSchema<S>
>;

/** Strict JSON fast path. Repeated references and non-JSON values use the rich serializer. */
export function jsonValue(
	value: unknown,
	seen = new Set<object>(),
	preserveReferences = false,
): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		jsonString(value);
		return value;
	}
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		!Object.is(value, -0)
	)
		return value;
	if (typeof value !== "object") throw new TypeError("Not a JSON value");
	if (seen.has(value)) throw new TypeError("Repeated reference");
	seen.add(value);
	try {
		if (Array.isArray(value))
			return Array.from(value, (item) =>
				jsonValue(item, seen, preserveReferences),
			);
		if (Object.getPrototypeOf(value) !== Object.prototype)
			throw new TypeError("Not a plain JSON object");
		if (Object.getOwnPropertySymbols(value).length)
			throw new TypeError("Symbol keys");
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => {
				jsonString(key);
				return [key, jsonValue(item, seen, preserveReferences)];
			}),
		);
	} finally {
		if (!preserveReferences) seen.delete(value);
	}
}

function jsonString(value: string) {
	if (value.includes(String.fromCharCode(0)) || /[\uD800-\uDFFF]/u.test(value))
		throw new TypeError("String requires a JSONB-safe representation");
}
