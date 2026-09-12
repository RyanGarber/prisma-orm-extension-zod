import type { $ZodType } from "zod/v4/core";

export function defineZodSchema<S extends $ZodType>(schema: S) {
	return { schema };
}

export type ZodSchema<S extends $ZodType = $ZodType> = ReturnType<
	typeof defineZodSchema<S>
>;
