// Use-case: signTimelineAttachmentsForPet — strangler migration 43/61.
//
// Pure use-case: receives petPublicToken + eventIds, handles auth, queries
// DB, and signs attachment URLs. No Next.js request context.
//
// The outer shim (app/actions/sign-timeline-attachments.ts) re-exports these
// functions for page.tsx and test coverage.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { attachments, db } from "@/db";
import { withholdUnreadableDecomisoEvidence } from "@/lib/infra/decomiso-evidence-access";
import { requirePetAccess } from "@/lib/infra/pet-access";
import { eventAttachmentSignedUrl } from "@/lib/infra/storage";

import type { SignTimelineAttachmentsResult } from "./types";

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  petPublicToken: z.string().min(1, "petPublicToken is required"),
  eventIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Bound-action factory — returns a server action already bound to a petPublicToken.
//
// Use this in page.tsx: pass `createTimelineSigner(pet.publicToken)` as the
// `signAttachments` prop to <PetHealthTimeline>. The returned fn matches the
// component's `SignerFn` type — errors are swallowed and return `{}` so the
// timeline degrades gracefully (no thumbnails) rather than crashing.
// ---------------------------------------------------------------------------

// @no-auth-required: delegates entirely to signTimelineAttachments which calls
// requirePetAccess before touching the DB. This wrapper exists only to adapt
// the return type (Record<string,string> vs Record|{error}) for page.tsx binding.
export async function signTimelineAttachmentsForPet(
  petPublicToken: string,
  eventIds: string[],
): Promise<Record<string, string>> {
  const result = await signTimelineAttachments(petPublicToken, eventIds);
  if ("error" in result) return {};
  return result;
}

export async function signTimelineAttachments(
  petPublicToken: string,
  eventIds: string[],
): Promise<SignTimelineAttachmentsResult> {
  // 1. Validate input.
  const parsed = InputSchema.safeParse({ petPublicToken, eventIds });
  if (!parsed.success) {
    return { error: "Invalid input" };
  }

  // 2. Empty event list — return fast, no DB round-trip.
  if (parsed.data.eventIds.length === 0) {
    return {};
  }

  // 3. Pet access check — owner and org custody paths are both permitted
  //    (timeline is visible to anyone who has access to the pet profile).
  const access = await requirePetAccess(petPublicToken);
  if (!access.ok) {
    return { error: "Pet not found or access denied" };
  }

  const { pet, user } = access;

  // 4. Query attachments for the given event ids, SCOPED TO THIS PET.
  //    The `eq(attachments.petId, pet.id)` fence is load-bearing security:
  //    requirePetAccess authorizes the caller for `pet`, but the eventIds are
  //    caller-supplied. Without this fence a caller with access to pet A could
  //    pass pet B's eventIds and sign B's clinical attachments (cross-tenant
  //    IDOR). Event attachments carry both pet_id and event_id (schema §"content
  //    group", kept in sync by app code), so the pet_id filter is exact.
  const allRows = await db
    .select({
      eventId: attachments.eventId,
      storagePath: attachments.storagePath,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.petId, pet.id),
        isNotNull(attachments.eventId),
        inArray(attachments.eventId, parsed.data.eventIds),
      ),
    );

  // 4b. Decomiso evidence keeps its metadata (PO decision D7), so pet access
  //     is not enough to sign it — only a viewer who reads the decomiso itself.
  const rows = await withholdUnreadableDecomisoEvidence(allRows, user.id);

  if (rows.length === 0) {
    return {};
  }

  // 5. Sign URLs via the event-attachments bucket. Signing runs as service role
  //    (migration 0172) — the pet access check and the pet_id fence above are
  //    the authorization, and the bucket no longer has an authenticated SELECT
  //    policy to enumerate it through.
  const signed: Record<string, string> = {};

  await Promise.all(
    rows.map(async (row) => {
      if (!row.eventId || !row.storagePath) return;
      const url = await eventAttachmentSignedUrl(row.storagePath, 3600);
      if (!url) return;
      // Last attachment wins if multiple exist for the same event. In
      // practice the timeline preview shows one thumbnail per event.
      signed[row.eventId] = url;
    }),
  );

  return signed;
}
