import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { resolveExtractionMode, toValidationCandidate } from "../src/extractor.js";
import { runPipeline } from "../src/index.js";
import {
  formatValidationIssues,
  MedicinalProductSchema,
  type MedicinalProduct,
} from "../src/schema.js";
import {
  MEDICINAL_PRODUCT_CONTEXT,
  toJsonLd,
  type DrugNode,
} from "../src/transformer.js";

const SAMPLE_CSV = fileURLToPath(new URL("../data/sample_products.csv", import.meta.url));

function validProduct(): MedicinalProduct {
  return {
    id: "MP-1001",
    name: "Helixor",
    activeSubstance: "paracetamol",
    strengthValue: 500,
    strengthUnit: "mg",
    dosageForm: "Film-coated tablet",
    routeOfAdministration: "Oral",
    marketingAuthorizationHolder: "Helix Therapeutics Ltd",
  };
}

describe("MedicinalProductSchema", () => {
  it("accepts a complete product and rejects unknown keys", () => {
    const product = validProduct();
    expect(MedicinalProductSchema.parse(product)).toEqual(product);
    expect(MedicinalProductSchema.safeParse({ ...product, batch: "A1" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { marketingAuthorizationHolder, ...incomplete } = validProduct();
    expect(marketingAuthorizationHolder).toBe("Helix Therapeutics Ltd");
    const result = MedicinalProductSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatValidationIssues(result.error).some((reason) => reason.startsWith("marketingAuthorizationHolder:"))).toBe(true);
    }
  });

  it.each([
    ["zero strength", { strengthValue: 0 }, "strengthValue"],
    ["negative strength", { strengthValue: -5 }, "strengthValue"],
    ["non-finite strength", { strengthValue: Number.POSITIVE_INFINITY }, "strengthValue"],
    ["NaN strength", { strengthValue: Number.NaN }, "strengthValue"],
    ["unknown unit", { strengthUnit: "lb" }, "strengthUnit"],
    ["empty name", { name: "" }, "name"],
    ["empty active substance", { activeSubstance: "" }, "activeSubstance"],
    ["empty holder", { marketingAuthorizationHolder: "" }, "marketingAuthorizationHolder"],
    ["unknown route", { routeOfAdministration: "Transdermal" }, "routeOfAdministration"],
    ["unknown dosage form", { dosageForm: "Lozenge" }, "dosageForm"],
  ])("rejects %s", (_label, overrides, field) => {
    const result = MedicinalProductSchema.safeParse({ ...validProduct(), ...overrides });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatValidationIssues(result.error).some((reason) => reason.startsWith(`${field}:`))).toBe(true);
    }
  });
});

describe("JSON-LD transformation", () => {
  it("builds a schema.org Drug node with a stable IDMP-inspired identifier", () => {
    const record = toJsonLd(validProduct());

    expect(record["@context"]).toEqual(MEDICINAL_PRODUCT_CONTEXT);
    expect(record["@context"].schema).toBe("https://schema.org/");
    expect(record["@type"]).toBe("Drug");
    expect(record["@id"]).toBe("urn:idmp:medicinal-product:MP-1001");
    expect(record.identifier).toBe("MP-1001");
    expect(record.name).toBe("Helixor");
    expect(record.activeIngredient).toBe("paracetamol");
    expect(record.nonProprietaryName).toBe("paracetamol");
    expect(record.dosageForm).toBe("Film-coated tablet");
    expect(record.administrationRoute).toBe("Oral");
    expect(record.manufacturer).toEqual({
      "@type": "Organization",
      name: "Helix Therapeutics Ltd",
    });
    expect(record.availableStrength).toEqual({
      "@type": "QuantitativeValue",
      value: 500,
      unitText: "mg",
    });
  });
});

describe("extraction normalization", () => {
  it("selects mock mode when requested or when no usable API key is present", () => {
    expect(resolveExtractionMode(true, "sk-test")).toBe("mock");
    expect(resolveExtractionMode(false, undefined)).toBe("mock");
    expect(resolveExtractionMode(false, "your_key_here")).toBe("mock");
    expect(resolveExtractionMode(false, "sk-test")).toBe("openai");
  });

  it("canonicalizes synonyms into the controlled vocabulary", () => {
    const candidate = toValidationCandidate("MP-1", {
      name: "  Helixor ",
      activeSubstance: "paracetamol",
      strengthValue: "500",
      strengthUnit: "MG",
      dosageForm: "film-coated tablets",
      routeOfAdministration: "oral",
      marketingAuthorizationHolder: " Helix Therapeutics Ltd ",
    });

    expect(MedicinalProductSchema.parse(candidate)).toMatchObject({
      id: "MP-1",
      name: "Helixor",
      strengthValue: 500,
      strengthUnit: "mg",
      dosageForm: "Film-coated tablet",
      routeOfAdministration: "Oral",
      marketingAuthorizationHolder: "Helix Therapeutics Ltd",
    });
  });
});

describe("pipeline", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function makeOutputDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "medicinal-product-extractor-"));
    directories.push(directory);
    return directory;
  }

  it("extracts the sample catalogue with mock mode and quarantines the incomplete row", async () => {
    const outputDir = await makeOutputDir();
    const summary = await runPipeline({
      inputPath: SAMPLE_CSV,
      outputDir,
      mock: true,
    });

    expect(summary.mode).toBe("mock");
    expect(summary.processed).toBe(6);
    expect(summary.succeeded).toBe(5);
    expect(summary.failed).toBe(1);
    expect(summary.warnings).toEqual([]);

    const document = JSON.parse(await readFile(summary.outputPath, "utf8")) as {
      "@context": typeof MEDICINAL_PRODUCT_CONTEXT;
      "@graph": DrugNode[];
    };
    expect(document["@context"]).toEqual(MEDICINAL_PRODUCT_CONTEXT);
    expect(document["@graph"].map((node) => node["@id"])).toEqual([
      "urn:idmp:medicinal-product:MP-1001",
      "urn:idmp:medicinal-product:MP-1002",
      "urn:idmp:medicinal-product:MP-1003",
      "urn:idmp:medicinal-product:MP-1004",
      "urn:idmp:medicinal-product:MP-1005",
    ]);
    expect(document["@graph"].map((node) => ({
      name: node.name,
      activeIngredient: node.activeIngredient,
      dosageForm: node.dosageForm,
      administrationRoute: node.administrationRoute,
      strength: node.availableStrength,
      manufacturer: node.manufacturer.name,
    }))).toEqual([
      {
        name: "Helixor",
        activeIngredient: "paracetamol",
        dosageForm: "Film-coated tablet",
        administrationRoute: "Oral",
        strength: { "@type": "QuantitativeValue", value: 500, unitText: "mg" },
        manufacturer: "Helix Therapeutics Ltd",
      },
      {
        name: "Amoxen",
        activeIngredient: "amoxicillin",
        dosageForm: "Capsule",
        administrationRoute: "Oral",
        strength: { "@type": "QuantitativeValue", value: 250, unitText: "mg" },
        manufacturer: "Northwind Pharmaceuticals",
      },
      {
        name: "Ventiva",
        activeIngredient: "salbutamol",
        dosageForm: "Pressurised inhalation",
        administrationRoute: "Inhalation",
        strength: { "@type": "QuantitativeValue", value: 100, unitText: "mcg" },
        manufacturer: "AeroMed AG",
      },
      {
        name: "Ondexa",
        activeIngredient: "ondansetron",
        dosageForm: "Solution",
        administrationRoute: "Intravenous",
        strength: { "@type": "QuantitativeValue", value: 4, unitText: "mg" },
        manufacturer: "Harbor Clinical Supply, Basel",
      },
      {
        name: "Dermacort",
        activeIngredient: "hydrocortisone",
        dosageForm: "Cream",
        administrationRoute: "Topical",
        strength: { "@type": "QuantitativeValue", value: 1, unitText: "%" },
        manufacturer: "Dermora Laboratories",
      },
    ]);

    const deadLetter = JSON.parse(await readFile(summary.deadLetterPath, "utf8")) as {
      mode: string;
      records: Array<{ sourceId: string; stage: string; reasons: string[] }>;
    };
    expect(deadLetter.mode).toBe("mock");
    expect(deadLetter.records).toHaveLength(1);
    expect(deadLetter.records[0]?.sourceId).toBe("MP-1006");
    expect(deadLetter.records[0]?.stage).toBe("validation");
    const reasons = deadLetter.records[0]?.reasons ?? [];
    expect(reasons.some((reason) => reason.startsWith("strengthValue:"))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("activeSubstance:"))).toBe(true);
    expect(reasons.some((reason) => reason.startsWith("marketingAuthorizationHolder:"))).toBe(true);
  });

  it("falls back to mock extraction when no API key is configured", async () => {
    const outputDir = await makeOutputDir();
    const summary = await runPipeline({
      inputPath: SAMPLE_CSV,
      outputDir,
      mock: false,
    });

    expect(summary.mode).toBe("mock");
    expect(summary.succeeded).toBe(5);
    expect(summary.failed).toBe(1);
    expect(summary.warnings.join(" ")).toMatch(/mock extractor/i);
  });

  it("dead-letters a duplicate product id and keeps the first record", async () => {
    const outputDir = await makeOutputDir();
    const description =
      "The medicinal product Helixor is supplied as a film-coated tablet containing the active substance paracetamol at a strength of 500 mg. It is given by the oral route. The marketing authorization holder is Helix Therapeutics Ltd.";
    const csvPath = join(outputDir, "duplicates.csv");
    await writeFile(
      csvPath,
      `product_id,description\nMP-1,"${description}"\nMP-1,"${description}"\n`,
      "utf8",
    );

    const summary = await runPipeline({ inputPath: csvPath, outputDir, mock: true });
    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);

    const deadLetter = JSON.parse(await readFile(summary.deadLetterPath, "utf8")) as {
      records: Array<{ sourceId: string; reasons: string[] }>;
    };
    expect(deadLetter.records[0]?.sourceId).toBe("MP-1");
    expect(deadLetter.records[0]?.reasons.join(" ")).toMatch(/duplicate/);
  });

  it("fails clearly when the input CSV does not exist", async () => {
    const outputDir = await makeOutputDir();
    await expect(
      runPipeline({
        inputPath: join(outputDir, "missing.csv"),
        outputDir,
        mock: true,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
