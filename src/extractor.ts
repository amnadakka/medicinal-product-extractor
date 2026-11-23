import OpenAI from "openai";

import {
  DOSAGE_FORM_ALIASES,
  DOSAGE_FORMS,
  ROUTE_ALIASES,
  ROUTES_OF_ADMINISTRATION,
  STRENGTH_UNIT_ALIASES,
  STRENGTH_UNITS,
} from "./schema.js";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export type ExtractionMode = "mock" | "openai";

export interface ExtractionConfig {
  mode: ExtractionMode;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseURL?: string | undefined;
}

/** A transport or authentication failure. The pipeline aborts instead of quarantining every row. */
export class ExtractionRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionRequestError";
  }
}

export function resolveExtractionMode(
  mock: boolean | undefined,
  apiKey: string | undefined,
): ExtractionMode {
  if (mock === true) return "mock";
  const key = apiKey?.trim();
  if (key && key !== "your_key_here") return "openai";
  return "mock";
}

export function resolveModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed : DEFAULT_OPENAI_MODEL;
}

/**
 * Builds one extractor for a pipeline run.
 * Mock mode is a deterministic prose parser. Live mode calls Structured Outputs once per row.
 */
export function createExtractor(
  config: ExtractionConfig,
): (description: string) => Promise<unknown> {
  if (config.mode === "mock") {
    return (description) => Promise.resolve(mockExtract(description));
  }

  const client = createOpenAIClient(config);
  const model = resolveModel(config.model);
  return (description) => extractWithOpenAI(client, model, description);
}

/** Normalizes model or mock output into the shape Zod validates. Unknown keys are dropped. */
export function toValidationCandidate(id: string, raw: unknown): unknown {
  const record = isPlainObject(raw) ? raw : {};
  return {
    id,
    name: cleanText(record.name),
    activeSubstance: cleanText(record.activeSubstance),
    strengthValue: asNumber(record.strengthValue),
    strengthUnit: canonicalize(record.strengthUnit, STRENGTH_UNIT_ALIASES),
    dosageForm: canonicalize(record.dosageForm, DOSAGE_FORM_ALIASES),
    routeOfAdministration: canonicalize(record.routeOfAdministration, ROUTE_ALIASES),
    marketingAuthorizationHolder: cleanText(record.marketingAuthorizationHolder),
  };
}

interface MockExtraction {
  name: string;
  activeSubstance: string;
  strengthValue: number;
  strengthUnit: string;
  dosageForm: string;
  routeOfAdministration: string;
  marketingAuthorizationHolder: string;
}

function mockExtract(description: string): MockExtraction {
  const strength = description.match(
    /strength of\s+(\d+(?:\.\d+)?)\s*(mg|g|mcg|ml|iu|%)(?![A-Za-z])/i,
  );
  const rawValue = strength?.[1];
  const rawUnit = strength?.[2];

  return {
    name: firstGroup(description, /medicinal product\s+([A-Za-z][A-Za-z0-9-]*)/) ?? "",
    activeSubstance:
      firstGroup(
        description,
        /active substance\s+([A-Za-z][A-Za-z-]{1,}(?:\s+[A-Za-z][A-Za-z-]{1,}){0,4})\s+at a strength/i,
      ) ?? "",
    strengthValue: rawValue === undefined ? 0 : Number(rawValue),
    strengthUnit: rawUnit ?? "",
    dosageForm:
      firstGroup(
        description,
        /supplied as an?\s+([A-Za-z][A-Za-z -]+?)\s+containing the active substance/i,
      ) ?? "",
    routeOfAdministration:
      firstGroup(
        description,
        /given by the (oral|intravenous|topical|subcutaneous|intramuscular|inhalation|rectal|ophthalmic) route/i,
      ) ?? "",
    marketingAuthorizationHolder:
      firstGroup(description, /marketing authori[sz]ation holder is\s+([^.]+)/i) ?? "",
  };
}

function firstGroup(description: string, pattern: RegExp): string | undefined {
  const group = description.match(pattern)?.[1]?.trim().replace(/\s+/g, " ");
  return group && group.length > 0 ? group : undefined;
}

const SYSTEM_PROMPT = [
  "You extract structured medicinal product data for a regulatory master-data pipeline.",
  "Use only facts stated in the description. Do not infer missing identity, strength, or authorisation facts.",
  "When a text field is not stated, return an empty string. When strength is not stated, return 0.",
  `Allowed strengthUnit values: "", ${STRENGTH_UNITS.join(", ")}.`,
  `Allowed dosageForm values: "", ${DOSAGE_FORMS.join(", ")}.`,
  `Allowed routeOfAdministration values: "", ${ROUTES_OF_ADMINISTRATION.join(", ")}.`,
  "Map obvious synonyms onto those allowed values, such as milligram to mg, tablets to Tablet, and oral to Oral.",
  "Put the proprietary product name in name and the active substance in activeSubstance.",
].join("\n");

function extractionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      activeSubstance: { type: "string" },
      strengthValue: { type: "number" },
      strengthUnit: { type: "string", enum: ["", ...STRENGTH_UNITS] },
      dosageForm: { type: "string", enum: ["", ...DOSAGE_FORMS] },
      routeOfAdministration: { type: "string", enum: ["", ...ROUTES_OF_ADMINISTRATION] },
      marketingAuthorizationHolder: { type: "string" },
    },
    required: [
      "name",
      "activeSubstance",
      "strengthValue",
      "strengthUnit",
      "dosageForm",
      "routeOfAdministration",
      "marketingAuthorizationHolder",
    ],
  };
}

function createOpenAIClient(config: ExtractionConfig): OpenAI {
  const apiKey = config.apiKey?.trim();
  if (!apiKey || apiKey === "your_key_here") {
    throw new ExtractionRequestError(
      "OPENAI_API_KEY is not set. Re-run with --mock or provide a key.",
    );
  }

  const baseURL = config.baseURL?.trim();
  return new OpenAI({
    apiKey,
    timeout: 60_000,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function extractWithOpenAI(
  client: OpenAI,
  model: string,
  description: string,
): Promise<unknown> {
  let response: Awaited<ReturnType<OpenAI["responses"]["create"]>>;
  try {
    response = await client.responses.create({
      model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: description },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "medicinal_product_extraction",
          strict: true,
          schema: extractionJsonSchema(),
        },
      },
    });
  } catch (error) {
    throw new ExtractionRequestError(describeRequestFailure(error), { cause: error });
  }

  const text = response.output_text.trim();
  if (text.length === 0) {
    throw new Error("Model returned an empty extraction.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Model returned text that was not valid JSON.");
  }
}

function describeRequestFailure(error: unknown): string {
  if (isPlainObject(error) && "status" in error && "message" in error) {
    return `OpenAI request failed (${String(error.status)}): ${String(error.message)}`;
  }
  if (error instanceof Error) return `OpenAI request failed: ${error.message}`;
  return "OpenAI request failed.";
}

function canonicalize<T extends string>(
  value: unknown,
  aliases: Readonly<Record<string, T>>,
): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  return aliases[trimmed.toLowerCase()] ?? trimmed;
}

function cleanText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

function asNumber(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
