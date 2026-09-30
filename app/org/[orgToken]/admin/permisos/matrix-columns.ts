// The permissions matrix's columns, by org type (portal-vet-p0 D13).
//
// Pure, and its own module so it can be tested: a page file may only export
// its default component and Next's page fields.

import { ORGANIZATION_CAPABILITIES } from "@/db/schema";
import {
  CAPABILITY_CATALOG,
  capabilityAppliesToOrgType,
} from "@/src/modules/organizations/domain/capabilities";

import type { MatrixColumn } from "./CapabilityMatrix";

// Caps in ORGANIZATION_CAPABILITIES but absent from CAPABILITY_CATALOG get a fallback label.
const EXTRA_CAP_LABELS: Record<string, string> = {
  "org.transfer.propose": "Proponer transferencia",
  "org.transfer.accept": "Aceptar transferencia",
};

// Full ordered column list: catalog order first, then extras.
const CATALOG_MAP = new Map(CAPABILITY_CATALOG.map((e) => [e.capability as string, e.label]));

/**
 * The matrix columns for an org of this type (portal-vet-p0 D13): every
 * capability, minus the shelter-only ones for an org that runs no rehoming
 * lifecycle — the same `capabilityAppliesToOrgType` the home cards use, so a
 * clinic admin is never shown six adoption/foster columns she cannot use. A
 * refugio keeps all of them.
 */
export function matrixColumnsFor(orgType: string): MatrixColumn[] {
  const columns: MatrixColumn[] = [];
  for (const cap of ORGANIZATION_CAPABILITIES) {
    if (!capabilityAppliesToOrgType(cap, orgType)) continue;
    columns.push({ capability: cap, label: CATALOG_MAP.get(cap) ?? EXTRA_CAP_LABELS[cap] ?? cap });
  }
  return columns;
}
