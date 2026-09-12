import { CodecImpl } from "@prisma/orm-postgres/components/codec";
import type { JsonValue } from "@prisma/orm-postgres/contract/types";
import type { ProjectionExpr } from "@prisma/orm-postgres/relational-core/ast";
import { PostgresCodecDescriptor } from "@prisma/orm-postgres/target/codec-descriptor";
import { postgresCodecRegistry } from "@prisma/orm-postgres/target/codecs";
import { z } from "zod";
import {
	type $ZodType,
	type input,
	type output,
	parse,
	parseAsync,
} from "zod/v4/core";
import { hydrationSchema } from "./hydration";
import type { ZodSchema } from "./schema";

const jsonbDescriptor = postgresCodecRegistry.descriptorFor("pg/jsonb@1");
if (!jsonbDescriptor)
	throw new Error("Prisma PostgreSQL JSONB codec is unavailable");
const jsonb = jsonbDescriptor.factory(undefined)({ name: "zod/json" });

export const ZOD_CODEC_ID = "zod/json@1" as const;
export const ZOD_NATIVE_TYPE = "jsonb" as const;
export type ZodTypeParams = {
	readonly key: string;
	readonly module: string;
	readonly export: string;
};

/** Input is persisted, output is produced by parsing on reads; transforms are never inverted. */
export class ZodCodec<S extends $ZodType> extends CodecImpl<
	typeof ZOD_CODEC_ID,
	readonly ["equality"],
	JsonValue,
	unknown
> {
	constructor(
		descriptor: ZodDescriptor,
		private readonly binding: ZodSchema<S>,
	) {
		super(descriptor);
		this.readSchema = hydrationSchema(binding.schema);
	}
	private readonly readSchema: $ZodType;
	async encode(value: input<S>): Promise<string> {
		await parseAsync(this.binding.schema, value);
		return jsonb.encode(value, {}) as Promise<string>;
	}
	async decode(value: JsonValue): Promise<output<S>> {
		return parseAsync(this.readSchema, value) as Promise<output<S>>;
	}
	encodeJson(value: input<S>): JsonValue {
		parse(this.binding.schema, value);
		return jsonb.encodeJson(value);
	}
	decodeJson(value: JsonValue): output<S> {
		return parse(this.readSchema, value) as output<S>;
	}
}

export class ZodDescriptor extends PostgresCodecDescriptor<ZodTypeParams> {
	override readonly codecId = ZOD_CODEC_ID;
	override readonly traits = ["equality"] as const;
	override readonly targetTypes = [ZOD_NATIVE_TYPE];
	override readonly paramsSchema = z.object({
		key: z.string(),
		module: z.string(),
		export: z.string(),
	});
	constructor(
		private readonly schemas: Readonly<Record<string, ZodSchema>>,
		private readonly reference: {
			readonly module: string;
			readonly export: string;
		},
	) {
		super();
	}
	protected override nativeType() {
		return ZOD_NATIVE_TYPE;
	}
	protected override jsonProjection(expression: ProjectionExpr) {
		return expression;
	}
	private lookup(params: ZodTypeParams): ZodSchema {
		const binding = Object.hasOwn(this.schemas, params.key)
			? this.schemas[params.key]
			: undefined;
		if (
			!binding ||
			this.reference.module !== params.module ||
			this.reference.export !== params.export
		) {
			throw new Error(
				`Missing or mismatched Zod schema registration: ${params.key}`,
			);
		}
		return binding;
	}
	override readonly factory = (params: ZodTypeParams) => {
		const binding = this.lookup(params);
		return () => new ZodCodec(this, binding);
	};
	override readonly renderInputType = (params: ZodTypeParams) =>
		this.render(params, "input");
	override readonly renderOutputType = (params: ZodTypeParams) =>
		this.render(params, "output");
	private render(params: ZodTypeParams, side: "input" | "output") {
		this.lookup(params);
		return `ZodTypes["zod/json@1"]["schemas"][${JSON.stringify(params.key)}]["${side}"]`;
	}
}
