// Whether to show the in-app notification priming line, before the OS dialog
// is ever offered — decision 10A (finding M-1).
//
// THE WHOLE POINT OF THE PEEK. This is the one place that turns "is this
// worth asking" into a yes/no, and it must be decidable WITHOUT ever showing
// the system dialog itself — that is what `getPushPermissionStatusSafely`
// (native-free at this layer, the real read behind the seam) is for.
//
// WHY BOTH CHECKS AND NOT EITHER ALONE
// ---------------------------------------------------------------------------
//   · Skipping the dismissal check would nag someone who already said "Ahora
//     no" every time they register a second pet.
//   · Skipping the permission peek would show the priming line to someone who
//     already granted (or was denied) through Ajustes or an earlier install —
//     asking again would be either redundant or, worse, a prompt the OS would
//     not even show (a permanent refusal), making the "Sí" button lie.
//
// `undetermined` IS THE ONLY OUTCOME WORTH OFFERING. `granted` and `denied` are
// both settled; `unavailable` is a build with no push module at all, where
// showing a priming line for a system dialog that can never appear would be
// its own kind of dishonesty; `failed` is a read that did not answer anything,
// and the safe default there is also "do not ask" — a broken read is not
// license to interrupt.

import { getPushPermissionStatusSafely } from "../native/push-port";
import { readPushPrimingDismissed } from "./push-priming-preference";

/**
 * Whether `AltaScreen`'s success path (or Ajustes) should offer the priming
 * line to this signed-in account right now.
 */
export async function shouldOfferPushPriming(userId: string): Promise<boolean> {
  const [dismissed, status] = await Promise.all([
    readPushPrimingDismissed(userId),
    getPushPermissionStatusSafely(),
  ]);
  return !dismissed && status.outcome === "undetermined";
}
