// CredencialesScreen — RUPGA service-dog credential registry + revoke console.
//
// F3+F7 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/rupga page.tsx, relocated so the Directorio hub
// (app/gob/directorio/page.tsx) can render it as its "credenciales" register
// under ?registro=credenciales. /gob/rupga now only redirects here (see
// app/gob/rupga/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic, same
// tomar/revocar action grammar (RevokeServiceDogActions).
//
// Listing surface for RUPGA service-dog credentials, with a "Revocar
// credencial" action per vigente row.
//
// Before this page, revokeServiceDogCredentialAction (fully built and
// tested backend, app/actions/service-dog.ts) had no UI caller anywhere in
// app/gob or app/admin — its siblings (org verification, vet role) each
// have a revocation console (RevokeOrgActions.tsx / RevokeUserActions.tsx);
// this page + RevokeServiceDogActions.tsx close that gap.
//
// Status filter (honesty fix, 2026-07-19): used to hardcode
// credential_status='vigente', so revoked credentials were permanently
// invisible — no way to review revocation history. A status filter (UrlTabs,
// same reasoning as /gob/servicios: the real default is "vigente", not "show
// all", so it fits the tabs idiom) now exposes vigente/revocada/all,
// defaulting to vigente (previous hardcoded behavior unchanged unless the
// operator switches tabs).

import Link from "next/link";
import { Suspense } from "react";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import {
  OpCard,
  OpCardBody,
  OpFilterBar,
  OpPill,
  SearchFilterField,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import {
  type ServiceDogCredentialStatusFilter,
  searchServiceDogCredentials,
} from "@/lib/infra/admin-search";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { SERVICE_TYPE_LABELS } from "@/lib/infra/service-dog-labels";
import { panoramaScopeLabel } from "@/lib/panorama/scope-label";
import { acronymPurpose, expandAcronym } from "@/lib/ui/operator-vocabulary";
import { pluralizeEs } from "@/lib/utils/format";

import { RevokeServiceDogActions } from "./RevokeServiceDogActions";

const CREDENTIAL_STATUS_TABS: UrlTabItem[] = [
  { value: "vigente", label: "Vigentes" },
  { value: "revocada", label: "Revocadas" },
  { value: "all", label: "Todas" },
];

function parseCredentialStatus(raw: string | undefined): ServiceDogCredentialStatusFilter {
  if (raw === "revocada" || raw === "all") return raw;
  return "vigente";
}

type PillTone = "ok" | "danger" | "neutral";
const STATUS_PILL: Record<string, { label: string; tone: PillTone }> = {
  vigente: { label: "Vigente", tone: "ok" },
  revocada: { label: "Revocada", tone: "danger" },
};

export type CredencialesScreenProps = {
  searchParams: { q?: string; status?: string };
  /**
   * True when rendered as the Directorio hub's "Credenciales" tab
   * (app/gob/directorio/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function CredencialesScreen({
  searchParams: sp,
  underHub = false,
}: CredencialesScreenProps) {
  const query = (sp.q ?? "").trim();
  const statusFilter = parseCredentialStatus(sp.status);
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const { items: results, truncated } = await searchServiceDogCredentials(
    query,
    { role: profile.role, jurisdictions },
    { status: statusFilter },
  );

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow="miMAR Gobierno · Credenciales RUPGA"
        title="Credenciales RUPGA"
        subtitle={
          <>
            {/* C2 glossary primitive (lib/ui/operator-vocabulary.ts) — first-use
                expansion + one-line purpose, so RUPGA is never assumed knowledge
                for a first-time operator (S2 "RUPGA sin expandir"). Kept even
                underHub — none of this repeats the "Credenciales" tab label. */}
            <p className="text-sm text-ln-op-mute">{expandAcronym("RUPGA")}</p>
            <p className="text-sm text-ln-op-ink-2">{acronymPurpose("RUPGA")}</p>
            <p className="text-sm text-ln-op-ink-2">
              {profile.role === "admin"
                ? "Buscá por nombre de la mascota, token o número RUPGA. Tu vista es universal."
                : // Same fix as OrganizacionesScreen: scope label, not a raw
                  // locality count that misreads whole-province assignments.
                  `Credenciales de tu alcance: ${panoramaScopeLabel(profile.role, jurisdictions)}.`}
            </p>
          </>
        }
      />

      {/* Unified filter bar (opfilterbar-sweep2-2026-07-21 item 5b) — migrated
          off the bespoke GET <form>. Estado stays on UrlTabs (unchanged): its
          real default is "vigente", not "show all" (honesty fix 2026-07-19
          comment above) — the exact default-trap an OpFilterBar axis's own
          implicit blank "Todas" option would reintroduce, so it is
          deliberately NOT ported into an axis here. serverNavCommit merges
          into the CURRENT query string, so the active status tab survives a
          search commit with no hidden input needed (safer than the old
          form's manual hidden field, which a future new param could forget). */}
      <OpFilterBar showPeriod={false}>
        <SearchFilterField
          paramKey="q"
          value={query}
          label="Buscar"
          placeholder="Buscar por nombre, token o RUPGA"
        />
      </OpFilterBar>

      <Suspense>
        <UrlTabs
          paramKey="status"
          defaultValue="vigente"
          tabs={CREDENTIAL_STATUS_TABS}
          aria-label="Filtrar por estado de la credencial"
        >
          <UrlTabsContent value={statusFilter}>
            {results.length === 0 ? (
              query ? (
                <LnEmptyState
                  title="Sin resultados"
                  description="Ajustá la búsqueda o cambiá el estado arriba."
                  className="mt-4"
                />
              ) : (
                // Actionable empty state (C2 — first RUPGA consumer, S2 "RUPGA
                // sin expandir"): names WHAT this registry is, WHY it might be
                // empty (nobody in scope has presented a credential in this
                // status yet), and WHAT populates it (the owner-facing
                // asistencia form → ANDIS issues the RUPGA number).
                <LnEmptyState
                  icon="huella"
                  title="Sin credenciales RUPGA en este estado"
                  description="RUPGA acredita a personas usuarias de perro guía o de asistencia (ANDIS). Vacío no es un error: se completa cuando un dueño/a carga su perro de asistencia (Mis mascotas → Asistencia) y ANDIS emite el número RUPGA — o cuando cambiás de estado/localidad arriba."
                  className="mt-4"
                />
              )
            ) : (
              <p className="mt-4 text-sm text-ln-op-mute">
                {truncated
                  ? `Mostrando las primeras ${results.length} ${pluralizeEs(results.length, "credencial")}. Usá el buscador para acotar la lista.`
                  : `${results.length} ${pluralizeEs(results.length, "credencial")}`}
              </p>
            )}

            <div className="space-y-3 mt-3">
              {results.map((c) => {
                const pill = STATUS_PILL[c.credentialStatus] ?? {
                  label: c.credentialStatus,
                  tone: "neutral" as const,
                };
                return (
                  <OpCard key={c.petId}>
                    <OpCardBody>
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-medium text-ln-op-ink">{c.petName}</p>
                            <p className="text-sm text-ln-op-mute">
                              {SERVICE_TYPE_LABELS[c.serviceType]}
                              {c.rupgaCredential && ` · RUPGA ${c.rupgaCredential}`}
                            </p>
                            <p className="text-xs text-ln-op-mute">
                              {c.jurisdictionLocality ?? "—"}, {c.jurisdictionProvince ?? "—"}
                            </p>
                          </div>
                          <OpPill tone={pill.tone}>{pill.label}</OpPill>
                        </div>
                        {/* Revoking an already-revoked credential has nothing to do —
                            only offer the action on a currently vigente credential. */}
                        {c.credentialStatus === "vigente" && (
                          <RevokeServiceDogActions
                            credential={c}
                            actorRole={profile.role}
                            jurisdictions={jurisdictions}
                          />
                        )}
                      </div>
                    </OpCardBody>
                  </OpCard>
                );
              })}
            </div>
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>

      <p className="text-sm text-ln-op-mute">
        <Link href="/gob" className="underline underline-offset-4 hover:text-ln-op-ink-2">
          {"←"} Volver al panel
        </Link>
      </p>
    </div>
  );
}
