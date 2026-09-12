import { Temporal } from "ponyfill-temporal";
import { type $ZodType, type $ZodTypes, util } from "zod/v4/core";

const temporalClasses = {
	"Temporal.Instant": Temporal.Instant,
	"Temporal.PlainDate": Temporal.PlainDate,
	"Temporal.PlainDateTime": Temporal.PlainDateTime,
	"Temporal.PlainMonthDay": Temporal.PlainMonthDay,
	"Temporal.PlainTime": Temporal.PlainTime,
	"Temporal.PlainYearMonth": Temporal.PlainYearMonth,
	"Temporal.ZonedDateTime": Temporal.ZonedDateTime,
	"Temporal.Duration": Temporal.Duration,
};

function constructorFor(schema: $ZodType): unknown {
	for (
		let current: $ZodType | undefined = schema;
		current;
		current = current._zod.parent
	) {
		// biome-ignore lint/complexity/useLiteralKeys: index signature
		const cls = current._zod.bag["Class"];
		if (cls) return cls;
		// temporal-zod's annotated instance schemas expose their type here after cloning.
		const json = current._zod.toJSONSchema?.();
		if (
			json &&
			typeof json === "object" &&
			"id" in json &&
			typeof json.id === "string" &&
			Object.hasOwn(temporalClasses, json.id)
		) {
			return temporalClasses[json.id as keyof typeof temporalClasses];
		}
	}
	return undefined;
}

/** Build a read-only parser graph; Zod still owns branching, validation and transforms. */
export function hydrationSchema(schema: $ZodType): $ZodType {
	const cache = new Map<$ZodType, $ZodType>();
	function visit(source: $ZodType): $ZodType {
		const cached = cache.get(source);
		if (cached) return cached;
		const def = (source as $ZodTypes)._zod.def;
		const copy = { ...def };
		// Cache before descending so lazy recursive schemas share their parser.
		const result = util.clone(source, copy);
		cache.set(source, result);
		let next = copy;
		switch (def.type) {
			case "object":
				next = {
					...def,
					shape: Object.fromEntries(
						Object.entries(def.shape).map(([key, value]) => [
							key,
							visit(value),
						]),
					),
					...(def.catchall ? { catchall: visit(def.catchall) } : {}),
				};
				break;
			case "array":
				next = { ...def, element: visit(def.element) };
				break;
			case "tuple":
				next = {
					...def,
					items: def.items.map(visit),
					rest: def.rest ? visit(def.rest) : null,
				};
				break;
			case "record":
				next = { ...def, valueType: visit(def.valueType) };
				break;
			case "union":
				next = { ...def, options: def.options.map(visit) };
				break;
			case "intersection":
				next = { ...def, left: visit(def.left), right: visit(def.right) };
				break;
			case "optional":
			case "nonoptional":
			case "nullable":
			case "default":
			case "prefault":
			case "catch":
			case "readonly":
			case "success":
				next = { ...def, innerType: visit(def.innerType) };
				break;
			case "lazy":
				next = { ...def, getter: () => visit(def.getter()) };
				break;
			case "pipe":
				// Codecs/transforms own their output representation. Only their input is hydrated.
				next = {
					...def,
					in: visit(def.in),
					...(source._zod.traits.has("$ZodPreprocess")
						? { out: visit(def.out) }
						: {}),
				};
				break;
		}
		const parser = util.clone(source, next);
		const cls = def.type === "custom" ? constructorFor(source) : undefined;
		const revive =
			def.type === "date" || cls === Date
				? (value: string) => new Date(value)
				: Object.values(temporalClasses).some((candidate) => candidate === cls)
					? (value: string) =>
							(cls as { from(value: string): unknown }).from(value)
					: undefined;
		// Run the original leaf, preserving instance checks and their constructor closure.
		const run = revive ? source._zod.run : parser._zod.run;
		result._zod.run = (payload, ctx) => {
			if (revive && typeof payload.value === "string") {
				try {
					payload.value = revive(payload.value);
				} catch {
					/* Let Zod report the invalid value at its schema path. */
				}
			}
			return run(payload, ctx);
		};
		return result;
	}
	return visit(schema);
}
