import { parse } from "csv-parse/sync";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExtractor,
  ExtractionRequestError,
  resolveExtractionMode,
  resolveModel,
  toValidationCandidate,
  type ExtractionMode,
} from "./extractor.js";
import {
  formatValidationIssues,
  MedicinalProductSchema,
  SourceRowSchema,
  type MedicinalProduct,
} from "./schema.js";
import { toJsonLdDocument } from "./transformer.js";

export const DEFAULT_INPUT_PATH = join(process.cwd(), "data", "sample_products.csv");
export const DEFAULT_OUTPUT_DIR = join(process.cwd(), "output");

const HELP_TEXT = `Usage: npm run start -- [options]

Extract medicinal product records from a CSV of unstructured descriptions.

Options:
  --mock           Use the deterministic offline extractor
  --input <path>   Input CSV (default: data/sample_products.csv)
  --output <dir>   Output directory (default: output)
  --help           Show this help

When OPENAI_API_KEY is unset, the pipeline uses the mock extractor.
`;

export interface PipelineOptions {
  inputPath: string;
  outputDir: string;
  mock?: boolean | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseURL?: string | undefined;
}

export interface PipelineSummary {
  mode: ExtractionMode;
  model: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  inputPath: string;
  outputPath: string;
  deadLetterPath: string;
  warnings: string[];
}

export interface DeadLetterRecord {
  sourceId: string;
  description: string;
  stage: "parse" | "extraction" | "validation";
  raw: unknown;
  candidate: unknown;
  reasons: string[];
}

export interface DeadLetterFile {
  generatedAt: string;
  mode: ExtractionMode;
  inputPath: string;
  records: DeadLetterRecord[];
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineSummary> {
  const inputPath = resolve(options.inputPath);
  const outputDir = resolve(options.outputDir);
  const mode = resolveExtractionMode(options.mock, options.apiKey);
  const model = mode === "openai" ? resolveModel(options.model) : null;
  const warnings: string[] = [];

  if (options.mock !== true && mode === "mock") {
    warnings.push("OPENAI_API_KEY is not set. Using the deterministic mock extractor.");
  }

  const rows = await readSourceRows(inputPath);
  const extract = createExtractor({
    mode,
    apiKey: options.apiKey,
    model: model ?? undefined,
    baseURL: options.baseURL,
  });

  const products: MedicinalProduct[] = [];
  const rejected: DeadLetterRecord[] = [];
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (!isPlainObject(row)) {
      rejected.push({
        sourceId: "(unreadable row)",
        description: "",
        stage: "parse",
        raw: row,
        candidate: null,
        reasons: ["(root): CSV row was not an object."],
      });
      continue;
    }

    const normalized = {
      ...row,
      product_id: typeof row.product_id === "string" ? row.product_id.trim() : row.product_id,
      description: typeof row.description === "string" ? row.description.trim() : row.description,
    };
    const parsedRow = SourceRowSchema.safeParse(normalized);
    if (!parsedRow.success) {
      rejected.push({
        sourceId: sourceIdOf(row),
        description: typeof normalized.description === "string" ? normalized.description : "",
        stage: "parse",
        raw: row,
        candidate: null,
        reasons: formatValidationIssues(parsedRow.error),
      });
      continue;
    }

    if (seenIds.has(parsedRow.data.product_id)) {
      rejected.push({
        sourceId: parsedRow.data.product_id,
        description: parsedRow.data.description,
        stage: "validation",
        raw: parsedRow.data,
        candidate: null,
        reasons: [`id: duplicate product_id "${parsedRow.data.product_id}"`],
      });
      continue;
    }
    seenIds.add(parsedRow.data.product_id);

    let raw: unknown;
    try {
      raw = await extract(parsedRow.data.description);
    } catch (error) {
      if (error instanceof ExtractionRequestError) throw error;
      rejected.push({
        sourceId: parsedRow.data.product_id,
        description: parsedRow.data.description,
        stage: "extraction",
        raw: null,
        candidate: null,
        reasons: [error instanceof Error ? error.message : "Extraction failed."],
      });
      continue;
    }

    const candidate = toValidationCandidate(parsedRow.data.product_id, raw);
    const parsedProduct = MedicinalProductSchema.safeParse(candidate);
    if (!parsedProduct.success) {
      rejected.push({
        sourceId: parsedRow.data.product_id,
        description: parsedRow.data.description,
        stage: "validation",
        raw,
        candidate,
        reasons: formatValidationIssues(parsedProduct.error),
      });
      continue;
    }

    products.push(parsedProduct.data);
  }

  const outputPath = join(outputDir, "products.jsonld");
  const deadLetterPath = join(outputDir, "dead_letter.json");
  const deadLetter: DeadLetterFile = {
    generatedAt: new Date().toISOString(),
    mode,
    inputPath,
    records: rejected,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(toJsonLdDocument(products), null, 2)}\n`, "utf8");
  await writeFile(deadLetterPath, `${JSON.stringify(deadLetter, null, 2)}\n`, "utf8");

  return {
    mode,
    model,
    processed: rows.length,
    succeeded: products.length,
    failed: rejected.length,
    inputPath,
    outputPath,
    deadLetterPath,
    warnings,
  };
}

export function formatSummary(summary: PipelineSummary): string {
  const mode = summary.model ? `${summary.mode} (${summary.model})` : summary.mode;
  const lines = [
    "Medicinal product extraction",
    "----------------------------",
    `Mode:        ${mode}`,
    `Processed:   ${summary.processed}`,
    `Succeeded:   ${summary.succeeded}`,
    `Failed:      ${summary.failed}`,
    `JSON-LD:     ${summary.outputPath}`,
    `Dead letter: ${summary.deadLetterPath}`,
  ];

  if (summary.warnings.length > 0) {
    lines.push("", ...summary.warnings);
  }

  return lines.join("\n");
}

async function readSourceRows(inputPath: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(inputPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Input CSV not found: ${inputPath}`);
    }
    throw error;
  }

  let table: unknown;
  try {
    table = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not parse CSV";
    throw new Error(`Could not parse input CSV: ${message}`);
  }

  if (!Array.isArray(table)) {
    throw new Error("Could not parse input CSV: parser did not return rows.");
  }

  return table;
}

function sourceIdOf(row: Record<string, unknown>): string {
  return typeof row.product_id === "string" && row.product_id.trim() !== ""
    ? row.product_id.trim()
    : "(unreadable row)";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CliOptions {
  help: boolean;
  mock: boolean;
  inputPath: string;
  outputDir: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let help = false;
  let mock = false;
  let inputPath = DEFAULT_INPUT_PATH;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--mock") {
      mock = true;
      continue;
    }
    if (arg === "--input" || arg === "--output") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      if (arg === "--input") inputPath = value;
      else outputDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
  }

  return { help, mock, inputPath, outputDir };
}

function loadEnvFile(filePath = join(process.cwd(), ".env")): void {
  if (!existsSync(filePath)) return;

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const summary = await runPipeline({
    inputPath: args.inputPath,
    outputDir: args.outputDir,
    mock: args.mock,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  console.log(formatSummary(summary));
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Pipeline failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
