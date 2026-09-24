// Mis chapas — owner panel for physical tags (physical-tag-lifecycle D8).
//
// Account-scoped (not per-pet): a blank tag has no pet until activation binds
// one, and /cuenta already hosts the cross-pet surfaces. Lists every tag the
// user can manage (activated by them, or on a pet they currently own) with a
// revoke action for the active ones.
//
// Jurisdiction gating is DISCOVERY-ONLY (design D6): this page stays reachable
// even when engraved_plate is disabled — only the nav entry hides.

import { db, ownerships, petTags, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { LnButton } from "@/components/ui/Button";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";

import { TagList } from "./_components/TagList";

export const dynamic = "force-dynamic";

async function loadTags(userId: string) {
  const ownedPetIds = (
    await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(and(eq(ownerships.ownerUserId, userId), isNull(ownerships.endedAt)))
  ).map((r) => r.petId);

  return (
    db
      .select({
        id: petTags.id,
        serial: petTags.serial,
        status: petTags.status,
        activatedAt: petTags.activatedAt,
        revokedAt: petTags.revokedAt,
        petName: pets.name,
        petToken: pets.publicToken,
      })
      .from(petTags)
      // Art. 16 (Ley 25.326): an erased pet reads as never registered. The guard
      // lives in the leftJoin ON — not the WHERE — so the user's own tag stays
      // listed (account-scoped surface, revoke still works) while the erased pet's
      // name and token drop to null, exactly as lookupTagBySerial nulls the
      // destination of an active chapa whose pet was erased. Reachable by a live
      // third party: a co-owner's ownership row survives the erasure, so the
      // erased petId lands in ownedPetIds below.
      .leftJoin(pets, and(eq(pets.id, petTags.petId), isNull(pets.deletedAt)))
      .where(
        ownedPetIds.length > 0
          ? or(eq(petTags.activatedByUserId, userId), inArray(petTags.petId, ownedPetIds))
          : eq(petTags.activatedByUserId, userId),
      )
      .orderBy(petTags.createdAt)
  );
}

export default async function ChapasPage() {
  const { user } = await requireUserOrRedirect("/cuenta/chapas");
  const tags = await loadTags(user.id);

  return (
    <div className="mx-auto max-w-4xl px-8 py-7 pb-12">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Mis chapas
          </h1>
          <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
            Chapas físicas con QR vinculadas a la credencial de tus mascotas.
          </p>
        </div>
        <LnButton href="/cuenta/chapas/activar" size="md">
          Activar una chapa
        </LnButton>
      </div>

      {tags.length === 0 ? (
        <LnCard>
          <LnCardHead title="Todavía no tenés chapas" />
          <LnCardBody>
            <p className="text-sm text-[var(--color-ln-ink-2)]">
              Cuando recibas una chapa física, activala con el código impreso en el envoltorio para
              vincularla a una de tus mascotas.
            </p>
          </LnCardBody>
        </LnCard>
      ) : (
        <TagList
          tags={tags.map((t) => ({
            id: t.id,
            serial: t.serial,
            status: t.status,
            petName: t.petName,
            petToken: t.petToken,
          }))}
        />
      )}
    </div>
  );
}
