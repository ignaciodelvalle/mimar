// @no-auth-required: dismissing a banner is a UX preference, not a capability.
// The action only deletes two cookies from the caller's own browser session;
// there is nothing to authorize. The cookies it clears are themselves either
// short-lived (signed token, 15min TTL) or non-sensitive (plain pet token).

import { cookies } from "next/headers";

import {
  APPLY_INTENT_COOKIE_NAME,
  APPLY_INTENT_PET_TOKEN_COOKIE_NAME,
} from "@/lib/domain/apply-intent";

export async function dismissApplyIntentAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(APPLY_INTENT_COOKIE_NAME);
  cookieStore.delete(APPLY_INTENT_PET_TOKEN_COOKIE_NAME);
}
