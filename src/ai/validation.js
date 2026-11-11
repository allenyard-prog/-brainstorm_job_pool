import Ajv from "ajv";
import { AiError } from "./errors.js";

export const INPUT_BYTES = 256 * 1024;
export const OUTPUT_BYTES = 2 * 1024 * 1024;
const ajv = new Ajv({
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  addUsedSchema: false,
});
const ownObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateRequest(input, kind) {
  if (!ownObject(input) || !["text", "json"].includes(kind))
    throw new AiError("AI_INVALID_REQUEST");
  const allowed = [
    "model",
    "prompt",
    "system",
    "maxOutputTokens",
    "signal",
    ...(kind === "json" ? ["schema"] : []),
  ];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !ownObject(input.model) ||
    Object.keys(input.model).some((key) => !["provider", "id"].includes(key)) ||
    typeof input.model.provider !== "string" ||
    !input.model.provider ||
    typeof input.model.id !== "string" ||
    !input.model.id.trim() ||
    input.model.id.length > 200 ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    (input.system !== undefined && typeof input.system !== "string") ||
    (input.signal !== undefined && !(input.signal instanceof AbortSignal))
  )
    throw new AiError("AI_INVALID_REQUEST");
  const maxOutputTokens = input.maxOutputTokens ?? 2048;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 8192
  )
    throw new AiError("AI_INVALID_REQUEST");
  let encoded;
  try {
    encoded = JSON.stringify({ ...input, signal: undefined });
  } catch {
    throw new AiError("AI_INVALID_REQUEST");
  }
  if (Buffer.byteLength(encoded) > INPUT_BYTES)
    throw new AiError("AI_INVALID_REQUEST");
  return { ...input, model: { ...input.model }, maxOutputTokens, kind };
}

export function compileOutputSchema(schema) {
  let nodes = 0;
  const invalid = () => {
    throw new AiError("AI_INVALID_SCHEMA");
  };
  function visit(node, depth) {
    if (!ownObject(node) || depth > 10 || ++nodes > 200) invalid();
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (
      types.length > 2 ||
      new Set(types).size !== types.length ||
      types.some(
        (type) =>
          ![
            "object",
            "array",
            "string",
            "number",
            "integer",
            "boolean",
            "null",
          ].includes(type),
      ) ||
      (types.length === 2 && !types.includes("null"))
    )
      invalid();
    const type = types.find((value) => value !== "null") ?? "null";
    const allowed = [
      "type",
      "title",
      "description",
      "enum",
      ...(type === "object"
        ? ["properties", "required", "additionalProperties"]
        : type === "array"
          ? ["items"]
          : []),
    ];
    if (Object.keys(node).some((key) => !allowed.includes(key))) invalid();
    for (const key of ["title", "description"])
      if (
        node[key] !== undefined &&
        (typeof node[key] !== "string" || node[key].length > 2000)
      )
        invalid();
    if (
      node.enum !== undefined &&
      (!Array.isArray(node.enum) ||
        !node.enum.length ||
        node.enum.length > 100 ||
        node.enum.some(
          (value) =>
            value !== null &&
            !["string", "number", "boolean"].includes(typeof value),
        ))
    )
      invalid();
    if (type === "object") {
      if (
        !ownObject(node.properties) ||
        node.additionalProperties !== false ||
        !Array.isArray(node.required) ||
        new Set(node.required).size !== node.required.length ||
        node.required.length !== Object.keys(node.properties).length ||
        node.required.some(
          (key) =>
            typeof key !== "string" || !Object.hasOwn(node.properties, key),
        )
      )
        invalid();
      for (const [key, child] of Object.entries(node.properties)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) invalid();
        visit(child, depth + 1);
      }
    }
    if (type === "array") visit(node.items, depth + 1);
  }
  try {
    if (schema?.type !== "object") invalid();
    visit(schema, 0);
    try {
      return ajv.compile(schema);
    } finally {
      // Each request owns its validator; do not retain supplied schemas indefinitely.
      ajv.removeSchema(schema);
    }
  } catch {
    throw new AiError("AI_INVALID_SCHEMA");
  }
}
