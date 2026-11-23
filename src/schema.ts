import { z, type ZodError } from "zod";

/**
 * Controlled vocabularies are an IDMP-inspired demonstration subset
 * (dose form, route, and strength unit), not the full EDQM or UCUM catalogues.
 */
export const MAX_DESCRIPTION_LENGTH = 8_000;

export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const STRENGTH_UNITS = ["mg", "g", "mcg", "mL", "IU", "%"] as const;
export const DOSAGE_FORMS = [
  "Tablet",
  "Film-coated tablet",
  "Capsule",
  "Cream",
  "Solution",
  "Suspension",
  "Pressurised inhalation",
  "Injection",
] as const;
export const ROUTES_OF_ADMINISTRATION = [
  "Oral",
  "Intravenous",
  "Topical",
  "Subcutaneous",
  "Intramuscular",
  "Inhalation",
  "Rectal",
  "Ophthalmic",
] as const;

export type StrengthUnit = (typeof STRENGTH_UNITS)[number];
export type DosageForm = (typeof DOSAGE_FORMS)[number];
export type RouteOfAdministration = (typeof ROUTES_OF_ADMINISTRATION)[number];

function aliasMap<T extends string>(
  values: readonly T[],
  extra: ReadonlyArray<readonly [string, T]>,
): Readonly<Record<string, T>> {
  const aliases: Record<string, T> = {};
  for (const value of values) {
    aliases[value.toLowerCase()] = value;
  }
  for (const [key, value] of extra) {
    aliases[key.toLowerCase()] = value;
  }
  return aliases;
}

export const STRENGTH_UNIT_ALIASES: Readonly<Record<string, StrengthUnit>> = aliasMap(
  STRENGTH_UNITS,
  [
    ["milligram", "mg"],
    ["milligrams", "mg"],
    ["gram", "g"],
    ["grams", "g"],
    ["ug", "mcg"],
    ["µg", "mcg"],
    ["μg", "mcg"],
    ["microgram", "mcg"],
    ["micrograms", "mcg"],
    ["milliliter", "mL"],
    ["milliliters", "mL"],
    ["millilitre", "mL"],
    ["millilitres", "mL"],
    ["percent", "%"],
    ["percentage", "%"],
  ],
);

export const DOSAGE_FORM_ALIASES: Readonly<Record<string, DosageForm>> = aliasMap(DOSAGE_FORMS, [
  ["tablets", "Tablet"],
  ["film coated tablet", "Film-coated tablet"],
  ["film-coated tablets", "Film-coated tablet"],
  ["capsules", "Capsule"],
  ["creams", "Cream"],
  ["solutions", "Solution"],
  ["suspensions", "Suspension"],
  ["pressurized inhalation", "Pressurised inhalation"],
  ["injections", "Injection"],
]);

export const ROUTE_ALIASES: Readonly<Record<string, RouteOfAdministration>> = aliasMap(
  ROUTES_OF_ADMINISTRATION,
  [
    ["iv", "Intravenous"],
    ["po", "Oral"],
    ["sc", "Subcutaneous"],
    ["im", "Intramuscular"],
    ["inhaled", "Inhalation"],
    ["ocular", "Ophthalmic"],
  ],
);

export const ProductIdSchema = z.string().regex(PRODUCT_ID_PATTERN);

export const SourceRowSchema = z.strictObject({
  product_id: ProductIdSchema,
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
});

export const MedicinalProductSchema = z.strictObject({
  id: ProductIdSchema,
  name: z.string().min(1),
  activeSubstance: z.string().min(1),
  strengthValue: z.number().finite().gt(0),
  strengthUnit: z.enum(STRENGTH_UNITS),
  dosageForm: z.enum(DOSAGE_FORMS),
  routeOfAdministration: z.enum(ROUTES_OF_ADMINISTRATION),
  marketingAuthorizationHolder: z.string().min(1),
});

export type SourceRow = z.infer<typeof SourceRowSchema>;
export type MedicinalProduct = z.infer<typeof MedicinalProductSchema>;

export function formatValidationIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path =
      issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
