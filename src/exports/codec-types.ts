import type { input, output } from "zod/v4/core";
import type { ZodSchema } from "../core/schema";

/** Export this type from the module registered with createZodExtension. */
export type CodecTypes<
	Schemas extends Readonly<Record<string, ZodSchema>> = Readonly<
		Record<string, ZodSchema>
	>,
> = {
	readonly "zod/json@1": {
		readonly input: unknown;
		readonly output: unknown;
		readonly traits: "equality";
		readonly schemas: {
			readonly [Key in keyof Schemas]: {
				readonly input: input<Schemas[Key]["schema"]>;
				readonly output: output<Schemas[Key]["schema"]>;
			};
		};
	};
};
