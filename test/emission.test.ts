import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "@prisma/orm-postgres/config";
import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { ok } from "@prisma/orm-postgres/utils/result";
import { executeContractEmit } from "@prisma/orm-toolchain/cli/control-api";
import {
	createZodExtension,
	defineZodSchema,
} from "../src/exports/column-types";
import { Profile } from "./fixtures/schemas";

it("emits separate input/output schema references through the real Prisma control stack", async () => {
	const extension = extensionFor({
		Profile: defineZodSchema(Profile),
	});
	const contract = defineContract(
		{ extensions: { zod: extension.pack } },
		({ field, model }) => ({
			models: {
				User: model("User", {
					fields: {
						id: field.id.uuidv4String(),
						profile: field.column(extension.column("Profile")),
					},
				}).sql({ table: "users" }),
			},
		}),
	);
	const config = defineConfig({
		contract: "./contract.ts",
		extensions: [extension.control],
	});
	const directory = await mkdtemp(join(process.cwd(), ".zod-emit-"));
	try {
		const result = await executeContractEmit({
			config: {
				...config,
				contract: {
					source: { load: async () => ok(contract) },
					output: join(directory, "contract.json"),
				},
			},
			cwd: process.cwd(),
			configPath: join(process.cwd(), "prisma.config.ts"),
		});
		const dts = (await readFile(result.files.dts, "utf8"))
			.replaceAll("'", '"')
			.replace(/\s+/g, " ");
		expect(dts).toContain(
			'ZodTypes["zod/json@1"]["schemas"]["Profile"]["input"]',
		);
		expect(dts).toContain(
			'ZodTypes["zod/json@1"]["schemas"]["Profile"]["output"]',
		);
		expect(dts).not.toContain("@internal/");
		await writeFile(
			join(directory, "schemas.ts"),
			`
import type { CodecTypes } from "../src/exports/codec-types";
import type { ZodSchema } from "../src/core/schema";
import type { Profile } from "../test/fixtures/schemas";
export type SchemaTypes = CodecTypes<{ Profile: ZodSchema<typeof Profile> }>;
`,
		);
		await writeFile(
			join(directory, "assertions.ts"),
			`
import type { StorageColumnInputTypes, StorageColumnTypes } from "./contract";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type Input = Assert<Equal<StorageColumnInputTypes["public"]["users"]["profile"], { name: string; age: string }>>;
export type Output = Assert<Equal<StorageColumnTypes["public"]["users"]["profile"], { name: string; age: number }>>;
`,
		);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
					strict: true,
					skipLibCheck: true,
					noEmit: true,
				},
				include: ["*.ts"],
			}),
		);
		execFileSync(
			"pnpm",
			["exec", "tsc", "--project", join(directory, "tsconfig.json")],
			{ encoding: "utf8" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);

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
