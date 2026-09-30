// capability-state — what the "Tus permisos" rows say about each capability
// for the acting member (portal-vet-p0 D12).
//
// WHY: a vet_individual without a verified matrícula used to see the clinical
// rows as "No concedido" with a "Solicitar" form under them. Both were wrong.
// Nobody can concede those capabilities to a vet — they come from the vet's own
// verified matrícula (D10, credentialGatedGrantRefusal) — so the request form
// led to a refusal, and "No concedido" never said why or where to fix it. The
// `needs_matricula` state names the reason and links to the one place that
// resolves it.
//
// PURE module (no DB, no React) so the states and their copy are asserted
// directly rather than through a page render. The admin Permisos matrix reads
// the same label, so both surfaces say the same thing.

import type { OrganizationCapability } from "@/db/schema";
import { credentialGatedGrantRefusal } from "@/src/modules/organizations/domain/capabilities";
import { NEEDS_MATRICULA_LABEL } from "./matricula-copy";

export type CapabilityState =
  | { kind: "granted" }
  | { kind: "pending" }
  | { kind: "denied"; reason: string | null }
  | { kind: "revoked"; reason: string | null }
  | { kind: "needs_matricula" }
  | { kind: "none" };

export type CapabilityStateKind = CapabilityState["kind"];

export { MATRICULA_UPGRADE_HREF, NEEDS_MATRICULA_LABEL } from "./matricula-copy";

export const STATE_PILL_TONE: Record<CapabilityStateKind, "ok" | "open" | "danger" | "neutral"> = {
  granted: "ok",
  pending: "open",
  denied: "danger",
  revoked: "danger",
  needs_matricula: "open",
  none: "neutral",
};

export const STATE_PILL_LABEL: Record<CapabilityStateKind, string> = {
  granted: "Concedido",
  pending: "Pendiente",
  denied: "Denegado",
  revoked: "Revocado",
  needs_matricula: NEEDS_MATRICULA_LABEL,
  none: "No concedido",
};

export const STATE_DOT: Record<CapabilityStateKind, string> = {
  granted: "bg-ln-op-ok",
  pending: "bg-ln-op-warn",
  denied: "bg-ln-op-danger",
  revoked: "bg-ln-op-danger",
  needs_matricula: "bg-ln-op-warn",
  none: "bg-ln-op-line",
};

export type GrantHistoryRow = {
  capability: string;
  status: string;
  decisionReason: string | null;
};

/**
 * Latest state per capability from the member's grant history, newest first
 * (the caller orders by requestedAt desc; the first row per capability wins).
 */
export function historyStates(rows: readonly GrantHistoryRow[]): Map<string, CapabilityState> {
  const byCapability = new Map<string, CapabilityState>();
  for (const row of rows) {
    if (byCapability.has(row.capability)) continue;
    if (row.status === "approved") {
      byCapability.set(row.capability, { kind: "granted" });
    } else if (row.status === "pending") {
      byCapability.set(row.capability, { kind: "pending" });
    } else if (row.status === "denied") {
      byCapability.set(row.capability, { kind: "denied", reason: row.decisionReason });
    } else if (row.status === "revoked") {
      // Review F1 (post-B1): decisionReason keeps the ORIGINAL GRANT's reason
      // (revoke is status-only, provenance preserved), so a revocation is
      // stated without a motive here.
      byCapability.set(row.capability, { kind: "revoked", reason: null });
    }
  }
  return byCapability;
}

/**
 * The state of one capability for the acting member.
 *
 * Order matters: the effective grant set wins; then the credential gate, which
 * is checked BEFORE the history because a legacy approved grant row for a
 * clinical capability is ignored by resolveGrantedCaps while the matrícula is
 * not valid — reading the history first would call it "Concedido".
 */
export function capabilityStateFor(
  capability: OrganizationCapability,
  input: {
    granted: ReadonlySet<string>;
    membershipRole: string;
    history: ReadonlyMap<string, CapabilityState>;
  },
): CapabilityState {
  if (input.granted.has(capability)) return { kind: "granted" };
  if (credentialGatedGrantRefusal(input.membershipRole, capability)) {
    return { kind: "needs_matricula" };
  }
  return input.history.get(capability) ?? { kind: "none" };
}

/** Whether the member can ask an admin for this capability from their row. */
export function canRequestFromRow(state: CapabilityState, isAdmin: boolean): boolean {
  return !isAdmin && (state.kind === "none" || state.kind === "denied" || state.kind === "revoked");
}
