// Buscar nuevo hogar — ONE route, TWO people, two different asks.
//
//   foster (role='foster')  → the transit caregiver asks a verified org to find
//                             the animal a permanent home (pre-existing; the
//                             foster's branch below is unchanged).
//   titular (role='owner')  → rehome-by-titular: the titular asks a verified
//                             org to ACCOMPANY the adoption — publish, vet —
//                             while the animal keeps living with them. Three
//                             states (none / pending / active) on this same
//                             screen; see TitularRehomePanel.
//
// The two never share an authorization check (spec §3, REQ-14): the foster
// branch calls the foster action (authorised on the live `foster` row), the
// titular branch calls the rehome actions (requireTitularAccess + the live
// `owner` row). Here the page only decides WHICH person it is looking at —
// and prefers `owner` EXPLICITLY when both rows exist, never by a bare ORDER
// BY (design "Route reuse with a determinism trap").
//
// A caretaker, a co-owner and a stranger hold no matching row and 404, as
// the foster-only page always did. The "⋯ Más" sheet derives this row's
// audience from the role gate below (MasSheet.helpers.test.ts), so the entry
// point and the page cannot drift apart again.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { db, ownerships, pets, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  type RehomeState,
  getRehomeStateForPet,
} from "@/src/modules/rehome/application/get-rehome-state-for-pet";
import { listCoveringOrgs } from "@/src/modules/rehome/application/list-covering-orgs";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";
import { and, eq, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RehomeRequestForm } from "./RehomeRequestForm";
import {
  type RehomeOrgOption,
  TitularRehomePanel,
  type TitularRehomeState,
} from "./TitularRehomePanel";

const backLinkCls =
  "mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline";
const titleCls =
  "m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]";

// THE PICKER'S LIST IS `listCoveringOrgs` (src/modules/rehome/application),
// shared with `GET /api/v1/pets/{token}/rehome` since 2026-09-10. It used to
// be an inline `findCoveringOrgs` here — the same join and the same
// `coverageAreaCoversZone` predicate the request use-case refuses on (W-4) —
// and a second door needing it would have been the fifth copy of that
// predicate. Both branches below offer the same list, because the org's
// qualification is the same whoever is asking.

/** The loader's state, narrowed to what the panel renders (the org picker travels with "none"). */
function toPanelState(state: RehomeState, orgs: RehomeOrgOption[]): TitularRehomeState {
  if (state.kind === "none") return { kind: "none", orgs };
  if (state.kind === "pending") {
    return {
      kind: "pending",
      orgDisplayName: state.orgDisplayName,
      casePublicCode: state.casePublicCode,
    };
  }
  return {
    kind: "active",
    orgDisplayName: state.orgDisplayName,
    listingCasePublicCode: state.listingCasePublicCode,
  };
}

/** The titular's surface: header, then the panel — or the honest empty state when nobody covers the zone. */
function TitularSurface({
  publicToken,
  petName,
  province,
  locality,
  state,
}: {
  publicToken: string;
  petName: string;
  province: string | null;
  locality: string | null;
  state: TitularRehomeState;
}) {
  const nobodyCovers = state.kind === "none" && state.orgs.length === 0;
  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      <Link href={`/mis-mascotas/${publicToken}`} className={backLinkCls}>
        ← {petName}
      </Link>

      <div className="mb-6">
        <h1 className={titleCls}>Acompañamiento de adopción para {petName}</h1>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
          Una organización verificada publica a {petName} en la búsqueda de hogar y evalúa a quienes
          se postulan. {petName} sigue viviendo con vos hasta que se concrete la adopción, y podés
          dar de baja el acompañamiento cuando quieras.
        </p>
      </div>

      {nobodyCovers ? (
        <LnEmptyState
          variant="dashed"
          title={
            province
              ? `No encontramos refugios ni redes de rescate verificados en ${locality ?? province}. Podés volver a intentarlo más adelante o contactar una organización directamente.`
              : `${petName} no tiene provincia registrada. Editá el perfil para poder elegir una organización cercana.`
          }
          action={
            province ? undefined : (
              <Link
                href={`/mis-mascotas/${publicToken}/editar`}
                className="font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                Editar mascota →
              </Link>
            )
          }
        />
      ) : (
        <TitularRehomePanel petPublicToken={publicToken} petName={petName} state={state} />
      )}

      {state.kind === "none" && !nobodyCovers && (
        <p className="mt-5 text-sm text-[var(--color-ln-mute)]">
          La organización recibe el pedido en su bandeja de casos y lo acepta o lo rechaza. Hasta
          que responda, nada cambia y podés cancelarlo acá mismo.
        </p>
      )}
    </div>
  );
}

export default async function BuscarHogarPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { user } = await requireUserOrRedirect();

  const accessRows = await db
    .select({
      pet: pets,
      role: ownerships.role,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Art. 16 (Ley 25.326): an erased pet reads as never registered. Access
        // is resolved INLINE here, and the foster branch below is reachable by a
        // live foster row — which the erasure leaves intact — so without this
        // term a foster would still see the erased pet's name on this screen.
        isNull(pets.deletedAt),
        eq(ownerships.ownerUserId, user.id),
        or(eq(ownerships.role, "owner"), eq(ownerships.role, "foster")),
        isNull(ownerships.endedAt),
      ),
    );

  if (accessRows.length === 0) notFound();

  // Prefer the titular EXPLICITLY when both rows exist — no ORDER BY roulette.
  const resolvedRole = accessRows.some((r) => r.role === "owner") ? "owner" : "foster";
  const pet = accessRows[0].pet;
  const province = pet.jurisdictionProvince ?? null;
  const locality = pet.jurisdictionLocality ?? null;

  const coveringOrgs = await listCoveringOrgs({ province, locality }, { repo: RehomeRepository });

  if (resolvedRole === "owner") {
    const state = await getRehomeStateForPet(pet.id, { repo: RehomeRepository });
    return (
      <TitularSurface
        publicToken={publicToken}
        petName={pet.name}
        province={province}
        locality={locality}
        state={toPanelState(
          state,
          coveringOrgs.map((o) => ({
            id: o.id,
            displayName: o.displayName,
            orgType: o.orgType,
            locality: o.locality,
          })),
        )}
      />
    );
  }

  // --- foster branch: unchanged ------------------------------------------

  const [profileRow] = await db
    .select({ displayName: profiles.displayName, phone: profiles.phone })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  const fosterName = profileRow?.displayName ?? user.id;

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link href={`/mis-mascotas/${publicToken}`} className={backLinkCls}>
        ← {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className={titleCls}>Buscar nuevo hogar para {pet.name}</h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Estas organizaciones están verificadas y operan en tu zona. Enviando una solicitud, les
          avisás que {pet.name} necesita un hogar definitivo.
        </p>
      </div>

      {coveringOrgs.length === 0 ? (
        <LnEmptyState
          variant="dashed"
          title={
            province
              ? `No encontramos refugios verificados en ${locality ?? province} registrados en el sistema. Podés contactar organizaciones directamente o pedir al refugio que hoy tiene a ${pet.name} que busque un voluntario.`
              : `${pet.name} no tiene provincia registrada. Editá el perfil para poder buscar organizaciones cercanas.`
          }
          action={
            !province ? (
              <Link
                href={`/mis-mascotas/${publicToken}/editar`}
                className="font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                Editar mascota →
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
          {coveringOrgs.map((org) => (
            <div
              key={org.id}
              className="flex flex-col gap-2.5 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]">
                  {org.displayName}
                </p>
                {/* Sin `capitalize`: "Red de rescate" y el nombre de la
                    localidad ya vienen bien escritos, y capitalize sube la
                    inicial de CADA palabra. */}
                <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                  {org.orgType === "rescue_network" ? "Red de rescate" : "Refugio"}
                  {" · "}
                  {org.locality}
                </p>
              </div>
              <RehomeRequestForm
                petPublicToken={publicToken}
                targetOrgId={org.id}
                orgDisplayName={org.displayName}
                fosterName={fosterName}
              />
            </div>
          ))}
        </div>
      )}

      <p className="mt-5 text-sm text-[var(--color-ln-mute)]">
        Las organizaciones recibirán una notificación con tus datos de contacto para hacer el
        seguimiento. No se compromete ningún acuerdo — es un primer contacto.
      </p>
    </div>
  );
}
