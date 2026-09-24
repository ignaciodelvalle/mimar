// GET /org/[orgToken]/mascotas/exportar — the org's own roster as CSV
// (org-first readiness finding #4: the exit ramp).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A refugio that cannot get its own animals back out of miMAR is locked in, and
// a system a shelter cannot leave is one it should not be asked to adopt. This
// route is the counterpart of the bulk import: same column catalog, same
// delimiter, same BOM, same date/enum vocabulary (lib/domain/intake-csv.ts), so
// a downloaded roster re-uploads through /intake/importar unedited. Import and
// export cannot drift because they are the same catalog read twice.
//
// AUTH — `pet.read_held`, pinned to the URL org
// ---------------------------------------------------------------------------
// Exactly the capability app/org/[orgToken]/mascotas/page.tsx checks before
// rendering the list ("Para ver el listado de animales necesitás el permiso
// pet.read_held"). The export contains what that page already shows, so gating
// it any looser would widen the surface and any tighter would hide a download
// from someone reading the same rows on screen. `requireCapabilityForOrgToken`
// resolves the org from the URL token FIRST, so a member of several orgs is
// authorized against the org in the URL, never their session-default membership
// (confused-deputy guard). Admins pass via the implicit universal grant, which
// is the same `|| membership.role === "admin"` branch the page relies on.
//
// SCOPE — only this org's animals, by construction
// ---------------------------------------------------------------------------
// The single WHERE is `owner_organization_id = <resolved org> AND ended_at IS
// NULL`. There is no caller-supplied filter anywhere in this file: no pet id,
// no token, no jurisdiction param. Cross-org contamination is not defended
// against, it is unrepresentable.
//
// IDENTIFIERS — chip and tattoo ARE included (see the privacy note below)
// ---------------------------------------------------------------------------
// Both are already visible to this exact audience on the org pet ficha
// (canonicalIds.microchip.code) and both are import columns, so omitting them
// would break the round-trip for the single most operationally important field
// a shelter owns. What is NOT here: any human's data. No adopter, no owner, no
// foster, no DNI, no phone, no email — the roster is about ANIMALS. The nearest
// thing to a person in the catalog is `jurisdiccion_rescate`, a free-text
// locality from the intake event, which is coarse by construction.
//
// NO ROW CAP, on purpose. The custody LIST caps at 200 rendered rows, but an
// exit ramp that silently truncates is not an exit ramp — the whole active
// roster ships. (Re-importing more than INTAKE_CSV_MAX_ROWS at once still needs
// splitting; that is the import's limit to explain, not a reason to withhold
// rows here.)

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, ownerships, petEvents, pets } from "@/db";
import {
  INTAKE_CSV_EXPORT_STATUS_HEADER,
  buildIntakeExportCsv,
  intakeReasonToIntakeCsvValue,
  sexToIntakeCsvValue,
  speciesToIntakeCsvValue,
  weightToIntakeCsvValue,
} from "@/lib/domain/intake-csv";
import { batchFetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { isoToArDateDisplay } from "@/lib/utils/date-input-ar";
import { isoDateInAr, statusLabel } from "@/lib/utils/format";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

export const dynamic = "force-dynamic";

// Same collapse rule as the custody list: one card (here, one row) per pet, the
// highest-stakes custody role winning when an animal carries several.
const ROLE_PRIORITY: Record<string, number> = {
  owner: 4,
  shelter_custody: 3,
  foster: 2,
  co_owner: 1,
  caretaker: 0,
};

/**
 * `dateOfBirth` → the `edad_anios` / `edad_meses` pair the template asks for.
 *
 * The import derives a DOB by subtracting the given age from TODAY
 * (parseIntakeForm), so re-deriving the age from the stored DOB against today
 * is what makes the round-trip land back on the same birth date. Returns empty
 * strings when the DOB is unknown — an absent age is an honest blank, and both
 * columns are optional.
 */
function ageColumns(dateOfBirth: string | null, todayIso: string): [string, string] {
  if (!dateOfBirth) return ["", ""];
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  if (!by || !ty) return ["", ""];
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (months < 0) return ["", ""];
  return [String(Math.floor(months / 12)), String(months % 12)];
}

type IntakeFacts = {
  intakeReason: string | null;
  intakeCondition: string | null;
  rescueJurisdiction: string | null;
  occurredAt: Date | null;
};

/**
 * Intake facts live ONLY in the append-only spine (`shelter_intake_recorded`),
 * never in a pets cache column — so this is the one place the export reads the
 * log directly rather than a projection (invariant #3). One batched query, the
 * EARLIEST event per pet.
 *
 * A pet that joined the org by custody transfer or adoption reversal has no
 * intake event and therefore no reason: those cells export EMPTY rather than a
 * fabricated "otro". Re-importing such a row asks the operator for the fact
 * miMAR never had, which is the correct question.
 */
async function fetchIntakeFacts(petIds: string[]): Promise<Map<string, IntakeFacts>> {
  const byPet = new Map<string, IntakeFacts>();
  if (petIds.length === 0) return byPet;

  const rows = await db
    .select({
      petId: petEvents.petId,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "shelter_intake_recorded")),
    )
    .orderBy(asc(petEvents.occurredAt));

  for (const row of rows) {
    // Ascending order + first-write-wins = the earliest intake per pet. A
    // re-intake after a return is a later episode; the roster describes how the
    // animal first entered.
    if (byPet.has(row.petId)) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const str = (key: string): string | null =>
      typeof payload[key] === "string" ? (payload[key] as string) : null;
    byPet.set(row.petId, {
      intakeReason: str("intake_reason"),
      intakeCondition: str("intake_condition"),
      rescueJurisdiction: str("rescue_jurisdiction"),
      occurredAt: row.occurredAt,
    });
  }

  return byPet;
}

export async function GET(_req: Request, { params }: { params: Promise<{ orgToken: string }> }) {
  const { orgToken } = await params;

  // A READ (CSV export): a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapabilityForOrgToken("pet.read_held", orgToken, { access: "read" });
  if (auth.error !== null) {
    return new NextResponse("No autorizado", { status: 403 });
  }
  const { organization } = auth;

  const orgRows = await db
    .select({ pet: pets, ownershipRole: ownerships.role, startedAt: ownerships.startedAt })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, organization.id),
        isNull(ownerships.endedAt),
        // Same population as the list page ("the file reads like the screen it
        // came from"): an erased pet's surviving sponsorship row must not put
        // it back into the roster the screen just excluded.
        isNull(pets.deletedAt),
      ),
    );

  const byPetId = new Map<string, (typeof orgRows)[number]>();
  for (const row of orgRows) {
    const existing = byPetId.get(row.pet.id);
    if (
      !existing ||
      (ROLE_PRIORITY[row.ownershipRole] ?? -1) > (ROLE_PRIORITY[existing.ownershipRole] ?? -1)
    ) {
      byPetId.set(row.pet.id, row);
    }
  }
  // Newest custody first — the same order the list renders, so the file reads
  // like the screen it came from.
  const rows = Array.from(byPetId.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  const petIds = rows.map((r) => r.pet.id);
  const [identifications, intakeFacts] = await Promise.all([
    batchFetchActiveIdentifications(petIds),
    fetchIntakeFacts(petIds),
  ]);

  const todayIso = isoDateInAr(new Date());

  const records = rows.map(({ pet, startedAt }) => {
    const ids = identifications.get(pet.id);
    const intake = intakeFacts.get(pet.id);
    const [ageYears, ageMonths] = ageColumns(pet.dateOfBirth ?? null, todayIso);
    // Intake date: the spine's own occurredAt when there is an intake event,
    // otherwise the custody start — the day this org's responsibility began
    // either way, and the column is required on re-import.
    const intakeDate = intake?.occurredAt ?? startedAt;

    return {
      nombre: pet.name,
      especie: speciesToIntakeCsvValue(pet.species),
      sexo: sexToIntakeCsvValue(pet.sex),
      edad_anios: ageYears,
      edad_meses: ageMonths,
      raza: pet.breed ?? "",
      color: pet.color ?? "",
      peso_estimado_kg: weightToIntakeCsvValue(pet.estimatedWeightKg),
      senias_particulares: pet.distinguishingFeatures ?? "",
      microchip: ids?.microchip?.code ?? "",
      pais_chip: ids?.microchip?.isoCountryCode ?? "",
      tatuaje: ids?.tattoo?.code ?? "",
      motivo_ingreso: intakeReasonToIntakeCsvValue(intake?.intakeReason),
      condicion_ingreso: intake?.intakeCondition ?? "",
      jurisdiccion_rescate: intake?.rescueJurisdiction ?? "",
      fecha_ingreso: isoToArDateDisplay(isoDateInAr(intakeDate)),
      [INTAKE_CSV_EXPORT_STATUS_HEADER]: statusLabel(pet.status),
    };
  });

  const filename = `mascotas-${orgToken}-${todayIso.replaceAll("-", "")}.csv`;

  return new NextResponse(buildIntakeExportCsv(records), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
