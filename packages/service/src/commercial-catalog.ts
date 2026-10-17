import { readFileSync } from "node:fs";
import type { CommercialPlan, ConnectedPropertyType, LicenseType } from "../../contracts/src/index.ts";

/**
 * Deployment-supplied product and plan definitions. DDI does not define any
 * product, plan, or price; this module only validates what operators configure.
 */
export type CommercialCatalog = { version: string; products: Array<{ id: string; displayName: string; plans: CommercialPlan[] }> };

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROPERTY_TYPES: ConnectedPropertyType[] = ["PERSONAL_BRAND", "BUSINESS", "SPACE", "APPLICATION"];
const LICENSE_TYPES: LicenseType[] = ["PERPETUAL", "TERM"];

function invalid(): never { throw new Error("COMMERCIAL_CATALOG_INVALID"); }
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const id = (value: unknown) => typeof value === "string" && ID.test(value) ? value : invalid();

export function parseCatalog(input: unknown): CommercialCatalog {
  const root = record(input);
  if (typeof root.version !== "string" || !root.version || !Array.isArray(root.products) || !root.products.length) invalid();
  const productIds = new Set<string>();
  const products = root.products.map(raw => {
    const product = record(raw);
    const productId = id(product.id);
    if (productIds.has(productId)) invalid();
    productIds.add(productId);
    if (typeof product.displayName !== "string" || !product.displayName || !Array.isArray(product.plans) || !product.plans.length) invalid();
    const planIds = new Set<string>();
    const plans = product.plans.map(rawPlan => {
      const plan = record(rawPlan);
      const planId = id(plan.id);
      if (planIds.has(planId)) invalid();
      planIds.add(planId);
      const licenseType = LICENSE_TYPES.includes(plan.licenseType as LicenseType) ? plan.licenseType as LicenseType : invalid();
      const termDays = plan.termDays === undefined ? undefined : Number.isInteger(plan.termDays) && (plan.termDays as number) > 0 && (plan.termDays as number) <= 3660 ? plan.termDays as number : invalid();
      if ((licenseType === "TERM") !== (termDays !== undefined)) invalid();
      if (typeof plan.renewable !== "boolean" || typeof plan.requiresProperty !== "boolean") invalid();
      const propertyTypes = Array.isArray(plan.propertyTypes) ? plan.propertyTypes.map(type => PROPERTY_TYPES.includes(type as ConnectedPropertyType) ? type as ConnectedPropertyType : invalid()) : invalid();
      if (plan.requiresProperty !== propertyTypes.length > 0) invalid();
      const downloads = Array.isArray(plan.downloads) ? plan.downloads.map(id) : invalid();
      const edition = typeof plan.edition === "string" && plan.edition ? plan.edition : invalid();
      const parsed: CommercialPlan = { productId, planId, edition, licenseType, renewable: plan.renewable, requiresProperty: plan.requiresProperty, propertyTypes, downloads };
      if (termDays !== undefined) parsed.termDays = termDays;
      return parsed;
    });
    return { id: productId, displayName: product.displayName, plans };
  });
  return { version: root.version, products };
}

export function resolvePlan(catalog: CommercialCatalog, productId: string, planId: string): CommercialPlan | null {
  return catalog.products.find(product => product.id === productId)?.plans.find(plan => plan.planId === planId) ?? null;
}

/** DDI_COMMERCIAL_CATALOG_PATH (JSON file) or DDI_COMMERCIAL_CATALOG (inline JSON). Absent means commercial activation is disabled. */
export function loadCatalog(env: NodeJS.ProcessEnv): CommercialCatalog | undefined {
  const source = env.DDI_COMMERCIAL_CATALOG_PATH ? readFileSync(env.DDI_COMMERCIAL_CATALOG_PATH, "utf8") : env.DDI_COMMERCIAL_CATALOG;
  if (!source) return undefined;
  let value: unknown;
  try { value = JSON.parse(source); } catch { invalid(); }
  return parseCatalog(value);
}
