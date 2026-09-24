// Nueva mascota — onboarding alta (Item 13, 2026-06-18).
//
// Entry point from /mis-mascotas empty-state or post-signup.
// On success → /mis-mascotas/nueva/[token]/credencial (aha moment).
//
// PO decision 2026-07-08: the alta is a 2-step wizard (identidad → foto y más).
// The wizard chrome + step state live in the client MinimalNewPetForm; this
// server component only resolves the auth + first-pet framing.
//
// UX 3.5 item 1: first-pet framing ("Registrar tu primera mascota") is gated on
// the owner having zero pets. Owners who already have ≥1 pet receive neutral
// copy ("Registrar mascota").

import { and, count, eq, isNull } from "drizzle-orm";

import { db, ownerships } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import { createPetAction } from "@/src/modules/pets/actions";
import { MinimalNewPetForm } from "./MinimalNewPetForm";

export default async function NewPetPage({
  searchParams,
}: {
  // `string | string[]`, not `string`: Next passes an ARRAY when a key repeats
  // (`?microchipId=a&microchipId=b`), which made the old `sp.microchipId?.trim()`
  // throw and render a raw 500. See lib/utils/search-params.ts.
  searchParams: Promise<{ chipConflict?: string | string[]; microchipId?: string | string[] }>;
}) {
  // Auth is enforced by the (app) layout above us, but we need the user id to
  // count their existing pets — a single SQL COUNT, never loads pet rows.
  const { user } = await requireUserOrRedirect();

  const [{ petCount }] = await db
    .select({ petCount: count() })
    .from(ownerships)
    .where(and(eq(ownerships.ownerUserId, user.id), isNull(ownerships.endedAt)));

  const isFirstPet = petCount === 0;

  // Chip-conflict return path (RA-2 F6). The vecino match card sends the finder
  // back here after they answer "No es la misma", carrying the disputed code
  // plus the signed force token that createPetAction accepts as the receipt for
  // that decision. Until this page read searchParams it took NO props at all,
  // so the card's "?chipMismatched=true" was read by nobody and the finder of a
  // lost animal could never complete the registration.
  //
  // Both halves or neither: a code with no token would just re-trigger the
  // cross-check, and a token with no code cannot be validated (the HMAC is
  // bound to the code).
  const sp = await searchParams;
  const conflictToken = trimmedSearchParam(sp.chipConflict);
  const conflictChip = trimmedSearchParam(sp.microchipId);
  const chipConflict =
    conflictToken && conflictChip
      ? { microchipId: conflictChip, forceToken: conflictToken }
      : undefined;

  // The wizard chrome (step counter, progress bar, back navigation) and the
  // heading now live inside the client form, which owns the paso-1/paso-2 step
  // state. See MinimalNewPetForm.
  return (
    <MinimalNewPetForm
      action={createPetAction}
      isFirstPet={isFirstPet}
      chipConflict={chipConflict}
    />
  );
}
