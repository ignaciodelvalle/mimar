// What the `aviso/{id}` screen does with the server's answer
// (notificaciones-destinos, 2026-10). Pure, so the decision is testable without
// a router.

import type { NotificationTargetV1 } from "@dim/contract/api";
import { isSafeExternalUrl, isSafeInternalPath } from "@dim/contract/notifications";

import type { ApiResult } from "../api/client";

/**
 * GO when the server resolved a native screen; OPEN the outside link for an
 * `external` outcome; STAY and explain otherwise.
 *
 * The screen stays for two outcomes and both are answers, not errors:
 *   · `explain` — the case or the pet is gone for this reader; the screen prints
 *     why and who has to act;
 *   · `webOnly` — the destination exists, on the web only (an org or authority
 *     console); the screen explains and offers the browser.
 * `external` (an official information page the writer linked) opens in the
 * browser AND keeps the explanation on screen, so coming back lands somewhere.
 * Everything else replaces this screen with `appRoute`, so the back gesture
 * from the case returns to wherever the tap came from, not to a spinner.
 */
export type TargetStep =
  | { kind: "go"; route: string }
  | { kind: "external"; url: string; target: NotificationTargetV1 }
  | { kind: "explain"; target: NotificationTargetV1 };

export function targetStep(target: NotificationTargetV1): TargetStep {
  if (target.outcome === "external") {
    return target.externalUrl && isSafeExternalUrl(target.externalUrl)
      ? { kind: "external", url: target.externalUrl, target }
      : { kind: "explain", target };
  }
  if (target.outcome === "explain" || target.webOnly) return { kind: "explain", target };
  return { kind: "go", route: target.appRoute };
}

/**
 * The refusal for a failed read, and whether a retry makes sense.
 *
 * `not_found` has its own words and NO retry (code review R6): the id is not
 * this person's — a push for another account on a shared phone — or the row was
 * deleted. An ARCHIVED row still resolves, so the copy does not blame archiving.
 */
export function targetFailure(
  result: ApiResult<NotificationTargetV1>,
): { message: string; retry: boolean } | null {
  if (result.outcome === "ok") return null;
  if (result.outcome === "api-error" && result.code === "not_found") {
    return {
      message:
        "No encontramos esta notificación en tu cuenta. Puede que se haya borrado o que sea de otra cuenta.",
      retry: false,
    };
  }
  return null;
}

/** The web address a `webOnly` destination opens in the browser — same origin only. */
export function webOnlyUrl(origin: string, target: NotificationTargetV1): string | null {
  if (!isSafeInternalPath(target.webHref)) return null;
  return `${origin.replace(/\/+$/, "")}${target.webHref}`;
}
