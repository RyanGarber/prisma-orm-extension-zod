import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import type { $ZodType, input } from "zod/v4/core";

export interface SchemaOptions<S extends $ZodType> {
	/** Required for non-JSON inputs; must round-trip the schema input. */
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

/** Reject lossy JSON conversions rather than silently dropping or changing data. */
export function jsonValue(
	value: unknown,
	ancestors = new Set<object>(),
): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		!Object.is(value, -0)
	)
		return value;
	if (typeof value !== "object" || value === null)
		throw new TypeError("Value requires custom JSON serialization");
	if (ancestors.has(value))
		throw new TypeError("Cyclic values cannot be stored as JSON");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return Array.from(value, (item) => jsonValue(item, ancestors));
		}
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		) {
			throw new TypeError(
				"Non-plain objects require custom JSON serialization",
			);
		}
		if (Object.getOwnPropertySymbols(value).length)
			throw new TypeError("Symbol keys cannot be stored as JSON");
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				jsonValue(item, ancestors),
			]),
		);
	} finally {
		ancestors.delete(value);
	}
}
