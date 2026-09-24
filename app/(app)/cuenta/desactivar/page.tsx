// Desactivar cuenta — Libreta Nacional redesign.
// GovtSelfDeactivateForm (client component) unchanged.

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LnCallout } from "@/components/ui/DocElements";
import { db, govtAssignments, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";

import { GovtSelfDeactivateForm } from "./GovtSelfDeactivateForm";

export default async function DesactivarPage() {
  const { user } = await requireUserOrRedirect();

  const [profile] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  if (
    !profile ||
    profile.role !== "govt" ||
    profile.accountType !== "institutional" ||
    profile.deactivatedAt !== null
  ) {
    redirect("/cuenta");
  }

  const myAssignments = await db
    .select({
      province: govtAssignments.jurisdictionProvince,
      locality: govtAssignments.jurisdictionLocality,
    })
    .from(govtAssignments)
    .where(and(eq(govtAssignments.userId, user.id), isNull(govtAssignments.revokedAt)));

  // Single grouped aggregate instead of one COUNT per jurisdiction.
  // Falls back to empty coverage counts when there are no assignments.
  const coverageRows =
    myAssignments.length > 0
      ? await db
          .select({
            province: govtAssignments.jurisdictionProvince,
            locality: govtAssignments.jurisdictionLocality,
            otherCount: sql<number>`count(*)::int`,
          })
          .from(govtAssignments)
          .innerJoin(profiles, eq(profiles.id, govtAssignments.userId))
          .where(
            and(
              ne(govtAssignments.userId, user.id),
              // KNOWN LIMITATION (authz-subsumption fence hardening, 2026-07-22
              // — see scripts/check-jurisdiction-subsumption.ts KNOWN_EXCEPTIONS):
              // this is a coverage-WARNING estimate, not an authorization gate
              // (nothing is granted/hidden by this count). It compares EXACT
              // pairs only, so a whole-province (whole-CABA) assignment on
              // either side won't be recognized as covering a barrio-specific
              // assignment on the other side. jurisdictionPairClause doesn't fix
              // this by simple substitution — it subsumes from ONE side only,
              // and the groupBy+exact-key lookup below still needs the match to
              // land under `a.province}||${a.locality}`. Needs a dedicated
              // bidirectional-overlap helper; deferred as low-stakes (informational
              // warning only, no data exposure).
              or(
                ...myAssignments.map((a) =>
                  and(
                    eq(govtAssignments.jurisdictionProvince, a.province),
                    eq(govtAssignments.jurisdictionLocality, a.locality),
                  ),
                ),
              ),
              isNull(govtAssignments.revokedAt),
              isNull(profiles.deactivatedAt),
            ),
          )
          .groupBy(govtAssignments.jurisdictionProvince, govtAssignments.jurisdictionLocality)
      : [];

  const coverageMap = new Map(
    coverageRows.map((r) => [`${r.province}||${r.locality}`, r.otherCount]),
  );

  const localitiesWithCoverage = myAssignments.map((a) => ({
    province: a.province,
    locality: a.locality,
    otherActiveGovtCount: coverageMap.get(`${a.province}||${a.locality}`) ?? 0,
  }));

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Desactivar mi cuenta
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Hola, <strong>{profile.displayName}</strong>. Esta acción es irreversible desde este
          panel. Si necesitás reactivar tu cuenta, contactá a un administrador.
        </p>
      </div>

      <LnCallout tone="warn" title="Esta acción es irreversible" className="mb-6">
        Al desactivar tu cuenta, perdés acceso al panel de operador gubernamental.
      </LnCallout>

      <GovtSelfDeactivateForm localities={localitiesWithCoverage} />
    </div>
  );
}
