import { JurisdictionFilter } from "@/components/JurisdictionFilter";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpButton, OpCrumbs, OpSelect } from "@/components/ui/dashboard";
import { db, ownerships, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { speciesLabel } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";
import { searchFosterVolunteers } from "@/src/modules/foster/actions";
import { and, eq, isNull } from "drizzle-orm";

import { VolunteerRow } from "./VolunteerRow";

export default async function VoluntariosPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{
    species?: string;
    province?: string;
    locality?: string;
    pet?: string;
    /** Set by VolunteerRow after a successful proposal — see the banner below. */
    propuesta?: string;
  }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);

  const filters = await searchParams;
  const species =
    filters.species === "dog" || filters.species === "cat" || filters.species === "other"
      ? filters.species
      : undefined;

  // #815 audit finding #15: previously requested a bare limit: 50 with no
  // truncation signal. Fetch one extra row (51) and slice back to 50 so a
  // pool larger than the page size gets a visible notice instead of a
  // silent cutoff (same fetch-N+1 pattern as adopciones/page.tsx).
  const VOLUNTEER_PAGE_SIZE = 50;
  const result = await searchFosterVolunteers({
    orgToken,
    species,
    province: filters.province ?? null,
    locality: filters.locality ?? null,
    petPublicToken: filters.pet ?? null,
    limit: VOLUNTEER_PAGE_SIZE + 1,
  });

  // Pets currently in shelter_custody by this org — used for the "propose" pet picker.
  const orgPets = await db
    .select({ id: pets.id, publicToken: pets.publicToken, name: pets.name, species: pets.species })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows.
        isNull(pets.deletedAt),
      ),
    );

  if ("error" in result) {
    return (
      <div className="space-y-6">
        <p className="text-md text-ln-op-danger">{result.error}</p>
      </div>
    );
  }

  const { rows: visibleRows, truncated } = capRows(result.rows, VOLUNTEER_PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Breadcrumbs (audit #18 — voluntarios had no breadcrumb). */}
      <OpCrumbs items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Voluntarios" }]} />
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Voluntarios</p>
        <h1 className="text-title font-semibold text-ln-op-ink">Pool de voluntarios</h1>
        <p className="mt-1 text-md text-ln-op-mute">
          Voluntarios activos con al menos un slot disponible.
        </p>
      </header>

      {/* Tab bar — Pool is this page; Propuestas links to the subroute */}
      <nav className="flex gap-1 border-b border-ln-op-line">
        <span
          className="px-4 py-2 text-md font-medium border-b-2 border-ln-op-azul text-ln-op-azul"
          aria-current="page"
        >
          Pool
        </span>
        <a
          href={`/org/${orgToken}/voluntarios/propuestas`}
          className="px-4 py-2 text-md font-medium no-underline border-b-2 border-transparent text-ln-op-mute hover:text-ln-op-ink-2 transition-colors"
        >
          Propuestas
        </a>
      </nav>

      {/* Post-action confirmation. The proposal writer sets a local success
          message and then reloads the document (router.refresh is banned, see
          lib/ui/full-page-action-nav.ts) — which wiped that message before
          anyone could read it. The pool card came back looking IDENTICAL to
          before ("1 slot · 0 aceptadas", "Proponer tránsito" available again),
          so cowork had to open the Propuestas tab to find out it had worked,
          with a live risk of sending the same proposal twice (master test CIU,
          A-3-a). A signal that has to survive a full reload belongs in the URL,
          which is also what the org listing already does with `?adopcion=`. */}
      {filters.propuesta && (
        <output className="block rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg px-4 py-3 text-md text-ln-op-ink">
          Propuesta enviada ({filters.propuesta}). La vas a ver en{" "}
          <a href={`/org/${orgToken}/voluntarios/propuestas`} className="underline">
            Propuestas
          </a>{" "}
          hasta que el voluntario la acepte o la rechace.
        </output>
      )}

      <form
        action={`/org/${orgToken}/voluntarios`}
        method="GET"
        className="flex flex-wrap gap-3 items-end"
      >
        <div>
          <label
            htmlFor="filter-species"
            className="mb-1 block text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
          >
            Especie
          </label>
          <OpSelect
            id="filter-species"
            name="species"
            defaultValue={filters.species ?? ""}
            size="sm"
            block={false}
          >
            <option value="">Todas</option>
            <option value="dog">Perros</option>
            <option value="cat">Gatos</option>
            <option value="other">Otras</option>
          </OpSelect>
        </div>
        <JurisdictionFilter
          provinceParam="province"
          localityParam="locality"
          defaultProvince={filters.province ?? ""}
          defaultLocality={filters.locality ?? ""}
          labelClassName="mb-1 block text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
          selectClassName="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card px-3 py-[7px] text-sm text-ln-op-ink focus:outline-none focus:ring-2 focus:ring-ln-op-azul"
        />
        <div>
          <label
            htmlFor="filter-pet"
            className="mb-1 block text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
          >
            Match para
          </label>
          <OpSelect
            id="filter-pet"
            name="pet"
            defaultValue={filters.pet ?? ""}
            size="sm"
            block={false}
          >
            <option value="">— sin mascota —</option>
            {orgPets.map((p) => (
              <option key={p.id} value={p.publicToken}>
                {p.name} ({speciesLabel(p.species)})
              </option>
            ))}
          </OpSelect>
        </div>
        <OpButton type="submit" variant="primary" size="sm">
          Filtrar
        </OpButton>
      </form>

      {visibleRows.length === 0 && (
        <LnEmptyState icon="usuarios" title="No hay voluntarios que coincidan." />
      )}

      <ul className="space-y-2">
        {visibleRows.map((row) => (
          <VolunteerRow
            key={row.userId}
            row={row}
            orgToken={orgToken}
            orgPets={orgPets}
            preselectedPetToken={filters.pet ?? null}
          />
        ))}
      </ul>

      {truncated && (
        <p className="text-sm text-ln-op-mute">
          Mostrando los primeros {VOLUNTEER_PAGE_SIZE}. Hay más — usá los filtros de arriba para
          acotar la búsqueda.
        </p>
      )}
    </div>
  );
}
