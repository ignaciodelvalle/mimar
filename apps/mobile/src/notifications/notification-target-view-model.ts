// What the `aviso/{id}` screen does with the server's answer
// (notificaciones-destinos, 2026-10). Pure, so the decision is testable without
// a router.

import type { NotificationTargetV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";

/**
 * GO when the server resolved a native screen; STAY otherwise.
 *
 * The screen stays for exactly two outcomes and both are answers, not errors:
 *   · `explain` — the case or the pet is gone for this reader; the screen prints
 *     why and who has to act;
 *   · `webOnly` — the destination exists, on the web only (an org or authority
 *     console); the screen explains and offers the browser.
 * Everything else replaces this screen with `appRoute`, so the back gesture
 * from the case returns to wherever the tap came from, not to a spinner.
 */
export type TargetStep =
  | { kind: "go"; route: string }
  | { kind: "explain"; target: NotificationTargetV1 };

export function targetStep(target: NotificationTargetV1): TargetStep {
  if (target.outcome === "explain" || target.webOnly) return { kind: "explain", target };
  return { kind: "go", route: target.appRoute };
}

/**
 * The refusal sentence for a failed read. `not_found` is the one with its own
 * words: the id is not this person's — a push meant for another account on a
 * shared phone, or a row erased since.
 */
export function targetFailureMessage(result: ApiResult<NotificationTargetV1>): string | null {
  if (result.outcome === "ok") return null;
  if (result.outcome === "api-error" && result.code === "not_found") {
    return "No encontramos esta notificación en tu cuenta. Puede que la hayas archivado o que sea de otra cuenta.";
  }
  return null;
}

/** The web address a `webOnly` destination opens in the browser. */
export function webOnlyUrl(origin: string, target: NotificationTargetV1): string {
  return `${origin.replace(/\/+$/, "")}${target.webHref}`;
}
