import type { Json, JsonSchema } from "@t3tools/plugin-api";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

export const PLUGIN_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const SCHEMA_MAX_BYTES = 32 * 1024;
const SCHEMA_MAX_DEPTH = 16;

const Bound = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Descriptor: Schema.Codec<JsonSchema> = Schema.suspend(() =>
  Schema.Union([
    Schema.Record(Schema.String, Schema.Never),
    Schema.Struct({ type: Schema.Literals(["null", "boolean"]) }),
    Schema.Struct({
      type: Schema.Literal("string"),
      enum: Schema.optionalKey(Schema.Array(Schema.String)),
      maxLength: Schema.optionalKey(Bound),
    }),
    Schema.Struct({
      type: Schema.Literal("number"),
      minimum: Schema.optionalKey(Schema.Number),
      maximum: Schema.optionalKey(Schema.Number),
    }),
    Schema.Struct({
      type: Schema.Literal("array"),
      items: Descriptor,
      maxItems: Schema.optionalKey(Bound),
    }),
    Schema.Struct({
      type: Schema.Literal("object"),
      properties: Schema.Record(Schema.String, Descriptor),
      required: Schema.Array(Schema.String),
      additionalProperties: Schema.Literal(false),
    }),
  ]),
);

const parseOptions = { onExcessProperty: "error" } as const;
const decodeDescriptor = Schema.decodeUnknownSync(Descriptor, parseOptions);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);

function boundedJson(input: unknown, maxBytes: number): Json {
  const encoded = JSON.stringify(input);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new Error("Plugin payload exceeds the supported size.");
  }
  return decodeJson(input);
}

function checkDepth(value: Json, depth: number): void {
  if (depth > SCHEMA_MAX_DEPTH) throw new Error("Plugin schema exceeds the supported depth.");
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
  }
}

function checkDescriptor(schema: JsonSchema): void {
  if (schema.type === "object") {
    if (schema.required.some((key) => !Object.hasOwn(schema.properties, key))) {
      throw new Error("Plugin schema requires an undefined property.");
    }
    for (const child of Object.values(schema.properties)) checkDescriptor(child);
  } else if (schema.type === "array") {
    checkDescriptor(schema.items);
  } else if (
    schema.type === "number" &&
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    throw new Error("Plugin schema has an inverted numeric range.");
  } else if (schema.type === "string" && schema.enum?.length === 0) {
    throw new Error("Plugin schema has no enum alternatives.");
  }
}

export function compilePluginSchema(input: unknown) {
  const json = boundedJson(input, SCHEMA_MAX_BYTES);
  checkDepth(json, 0);
  const descriptor = decodeDescriptor(json);
  checkDescriptor(descriptor);
  // The supported JSON-only subset cannot introduce service-dependent decoders.
  const schema = SchemaRepresentation.fromJsonSchemaDocument({
    dialect: "draft-2020-12",
    schema: descriptor,
    definitions: {},
  }) as Schema.Codec<unknown>;
  const decode = Schema.decodeUnknownSync(schema, parseOptions);
  return (value: unknown): Json =>
    boundedJson(decode(boundedJson(value, PLUGIN_PAYLOAD_MAX_BYTES)), PLUGIN_PAYLOAD_MAX_BYTES);
}
