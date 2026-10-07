// The public directory at /refugios — "Refugios y veterinarias" (PO 2026-10-02).
//
// Who is listed:
//   - a VERIFIED shelter or rescue network, always (unchanged since P2);
//   - a VERIFIED clinic, only when it opted in from its settings
//     (`organizations.public_directory_opt_in`, migration 0283, default off).
// Nothing else: a sanitary authority or an "other" org is never listed, and
// neither is a suspended or dissolved one (`organizations.status`), whatever
// the rest says.
//
// This module is the pure half of that rule plus the URL filters the page
// reads. The SQL half (the same rule as a WHERE clause) lives in
// lib/infra/org-directory.ts and is pinned against this one by its test.
//
// ZERO server imports: the settings form ("use client") reads
// `canOptIntoPublicDirectory`.

import { isRehomingOrgType } from "./org-type";

/**
 * How a listed org became verified, for the public "Datos de verificación"
 * box. An institution, never a person: "matricula" = a clinic auto-verified
 * because its sole admin holds a verified veterinary matrícula; "mimar_team"
 * = every other path (a miMAR review).
 */
export type PublicVerificationPath = "mimar_team" | "matricula";

/** The public label for each path. No staff member's name, ever. */
export const PUBLIC_VERIFIER_LABEL: Readonly<Record<PublicVerificationPath, string>> = {
  mimar_team: "Equipo miMAR",
  matricula: "miMAR, por matrícula veterinaria verificada",
};

/** Org types that may choose to appear in the directory. */
export const PUBLIC_DIRECTORY_OPT_IN_ORG_TYPES: ReadonlySet<string> = new Set(["clinic"]);

/** Whether an org of this type gets the "appear in the directory" setting. */
export function canOptIntoPublicDirectory(orgType: string): boolean {
  return PUBLIC_DIRECTORY_OPT_IN_ORG_TYPES.has(orgType);
}

/** Whether this organization is shown on the public directory and its profile page. */
export function isListedInPublicDirectory(org: {
  orgType: string;
  verified: boolean;
  /** `organizations.status`: a suspended or dissolved org is never listed. */
  status: string;
  publicDirectoryOptIn: boolean;
}): boolean {
  if (!org.verified || org.status !== "active") return false;
  if (isRehomingOrgType(org.orgType)) return true;
  return canOptIntoPublicDirectory(org.orgType) && org.publicDirectoryOptIn;
}

// ---------------------------------------------------------------------------
// URL filters — `?tipo=refugios|veterinarias&provincia=<name>`
// ---------------------------------------------------------------------------

/** The directory's type filter; `null` = every listed type. */
export type DirectoryKind = "refugios" | "veterinarias";

export const DIRECTORY_KIND_OPTIONS: ReadonlyArray<{ value: DirectoryKind; label: string }> = [
  { value: "refugios", label: "Refugios" },
  { value: "veterinarias", label: "Veterinarias" },
];

export type DirectoryFilters = {
  kind: DirectoryKind | null;
  /** A canonical province name, or null. */
  province: string | null;
};

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Reads the filters from search params. Anything unknown is dropped rather
 * than echoed back: a hand-typed `?provincia=` that is not a province shows
 * the whole directory, never an empty page that blames the visitor.
 */
export function parseDirectoryFilters(
  params: Record<string, string | string[] | undefined>,
  provinceNames: ReadonlyArray<string>,
): DirectoryFilters {
  const rawKind = firstValue(params.tipo)?.trim().toLowerCase();
  const kind = DIRECTORY_KIND_OPTIONS.some((o) => o.value === rawKind)
    ? (rawKind as DirectoryKind)
    : null;
  const rawProvince = firstValue(params.provincia)?.trim();
  const province = rawProvince && provinceNames.includes(rawProvince) ? rawProvince : null;
  return { kind, province };
}

/** The org types a kind filter admits. */
function kindAdmits(kind: DirectoryKind, orgType: string): boolean {
  return kind === "refugios" ? isRehomingOrgType(orgType) : orgType === "clinic";
}

/** Applies the filters to rows already restricted to listed organizations. */
export function applyDirectoryFilters<
  T extends { orgType: string; jurisdictionProvince: string | null },
>(rows: ReadonlyArray<T>, filters: DirectoryFilters): T[] {
  return rows.filter(
    (row) =>
      (filters.kind === null || kindAdmits(filters.kind, row.orgType)) &&
      (filters.province === null || row.jurisdictionProvince === filters.province),
  );
}

/** The query string for a set of filters (empty values omitted). */
export function directorySearch(filters: DirectoryFilters): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set("tipo", filters.kind);
  if (filters.province) params.set("provincia", filters.province);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** How a listed organization's type reads on the directory and its profile. */
export const DIRECTORY_ORG_TYPE_LABELS: Readonly<Record<string, string>> = {
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  clinic: "Veterinaria",
};
