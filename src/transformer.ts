import { type MedicinalProduct } from "./schema.js";

/**
 * Project vocabulary for knowledge-graph interchange.
 * ISO IDMP is the conceptual model; this context is not an official ISO publication.
 * schema.org `manufacturer` is populated from the marketing authorization holder.
 */
export const MEDICINAL_PRODUCT_CONTEXT = {
  schema: "https://schema.org/",
  idmp: "https://example.org/idmp/",
  Drug: "schema:Drug",
  Organization: "schema:Organization",
  QuantitativeValue: "schema:QuantitativeValue",
  name: "schema:name",
  identifier: "schema:identifier",
  nonProprietaryName: "schema:nonProprietaryName",
  activeIngredient: "schema:activeIngredient",
  dosageForm: "schema:dosageForm",
  administrationRoute: "schema:administrationRoute",
  manufacturer: "schema:manufacturer",
  availableStrength: "idmp:strength",
  value: "schema:value",
  unitText: "schema:unitText",
} as const;

export interface DrugNode {
  "@type": "Drug";
  "@id": string;
  identifier: string;
  name: string;
  nonProprietaryName: string;
  activeIngredient: string;
  dosageForm: string;
  administrationRoute: string;
  manufacturer: {
    "@type": "Organization";
    name: string;
  };
  availableStrength: {
    "@type": "QuantitativeValue";
    value: number;
    unitText: string;
  };
}

/** A single record that stays valid JSON-LD outside the document. */
export interface DrugJsonLd extends DrugNode {
  "@context": typeof MEDICINAL_PRODUCT_CONTEXT;
}

export interface JsonLdDocument {
  "@context": typeof MEDICINAL_PRODUCT_CONTEXT;
  "@graph": DrugNode[];
}

export function toJsonLd(product: MedicinalProduct): DrugJsonLd {
  return {
    "@context": MEDICINAL_PRODUCT_CONTEXT,
    ...toDrugNode(product),
  };
}

export function toJsonLdDocument(products: readonly MedicinalProduct[]): JsonLdDocument {
  return {
    "@context": MEDICINAL_PRODUCT_CONTEXT,
    "@graph": products.map((product) => toDrugNode(product)),
  };
}

function toDrugNode(product: MedicinalProduct): DrugNode {
  return {
    "@type": "Drug",
    "@id": `urn:idmp:medicinal-product:${product.id}`,
    identifier: product.id,
    name: product.name,
    nonProprietaryName: product.activeSubstance,
    activeIngredient: product.activeSubstance,
    dosageForm: product.dosageForm,
    administrationRoute: product.routeOfAdministration,
    manufacturer: {
      "@type": "Organization",
      name: product.marketingAuthorizationHolder,
    },
    availableStrength: {
      "@type": "QuantitativeValue",
      value: product.strengthValue,
      unitText: product.strengthUnit,
    },
  };
}
