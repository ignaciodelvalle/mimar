// Which walk-in history rows Atender offers "Corregir" on (portal-vet-p0 D3).
//
// The SAME predicate the server applies under its lock — imported, not
// rewritten: `isAmendableEventType` for the record's type and
// `orgAmendmentScopeRefusal` for who signed it and its corrections. A screen
// that offered a correction the server then refused would be worse than one
// that offered none. The server stays the authority; this only keeps the
// button from promising what the write would refuse.

import { isAmendableEventType, orgAmendmentScopeRefusal } from "@/lib/infra/amendment";
import type { WalkInLibreta } from "@/src/modules/pets/application/tab-data/get-walk-in-libreta";

export type WalkInAmendActor = {
  userId: string;
  organizationId: string;
  /** The signer's matrícula is validated (resolveAtenderPet's signer). */
  signerVerified: boolean;
};

/** Ids of the history rows this actor may correct from Atender. */
export function walkInAmendableIds(
  history: Pick<WalkInLibreta, "past" | "correctionAuthors">,
  actor: WalkInAmendActor,
): Set<string> {
  const ids = new Set<string>();
  if (!actor.signerVerified) return ids;
  for (const row of history.past) {
    if (!isAmendableEventType(row.eventType)) continue;
    const subjects = [
      { authorOrganizationId: row.authorOrganizationId ?? null },
      ...(history.correctionAuthors[row.id] ?? []),
    ];
    const refusal = orgAmendmentScopeRefusal(
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        authorVerified: actor.signerVerified,
      },
      subjects,
    );
    if (refusal === null) ids.add(row.id);
  }
  return ids;
}
