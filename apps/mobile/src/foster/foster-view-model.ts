// Tránsito — turning the server's proposals and fosters into what a person
// reads, and what they chose into what the contract accepts.
//
// PURE, like every other view-model in this app. Nothing here touches the
// network.
//
// `capabilities` DOES NOT EXIST ON THIS PAYLOAD, unlike `MyCaretakerGrantV1`,
// and that is not an omission: `MyFosterProposalV1` carries only
// `status: "pending"` rows (the hub's own filter — see `my-foster.ts`), so
// every proposal in it is, by construction, one this caller may answer. There
// is no second flag to gate the buttons on.
//
// `expired` MUST NOT GATE THE BUTTONS EITHER. `acceptFosterProposal` never
// checks `expiresAt` — only `status === "pending"` — because the nightly sweep
// is what actually closes a stale proposal, so a screen that disabled "Aceptar"
// on an expired-but-unswept row would refuse something the server still
// honours. `expired` is informational only: it greys the caption, nothing
// else.

import type { MyFosterOwnershipV1, MyFosterProposalV1 } from "@dim/contract/api";
import {
  FOSTER_REJECTION_REASONS,
  type FosterCommandInput,
  type FosterCommandInputCode,
  type FosterRejectionReason,
  firstFosterCommandInputCode,
  fosterCommandInputSchema,
} from "@dim/contract/input";

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/** `1 semana` / `3 semanas`, or `null` when the org gave no estimate. */
function weeksLabel(weeks: number | null): string | null {
  if (weeks === null) return null;
  return weeks === 1 ? "1 semana" : `${weeks} semanas`;
}

/** The six reasons `ProposalActions.tsx` offers, in the web's own words and order. */
export const FOSTER_REJECTION_REASON_LABELS: Readonly<Record<FosterRejectionReason, string>> = {
  capacity: "No tengo capacidad ahora",
  health_mismatch: "No me siento preparado/a para esta condición",
  timing: "Mal momento",
  distance: "Muy lejos",
  household: "Razones del hogar",
  other: "Otro",
};

export { FOSTER_REJECTION_REASONS };
export type { FosterRejectionReason };

/** The headline over one pending proposal. */
export function fosterProposalHeadline(proposal: MyFosterProposalV1): string {
  return `${proposal.organizationName} te propone cuidar a ${proposal.pet.name}`;
}

/** Duración estimada · vence el DD/MM/AAAA, greyed by the server's own clock. */
export function fosterProposalMetaLabel(proposal: MyFosterProposalV1): string {
  const duration = weeksLabel(proposal.proposedDurationWeeks);
  const parts = [duration ?? "Sin duración estimada", `expira ${formatDate(proposal.expiresAt)}`];
  if (proposal.expired) parts.push("la propuesta ya venció");
  return parts.join(" · ");
}

/** One line per foster row: active vs. ended, with the org and the period. */
export function fosterOwnershipHeadline(foster: MyFosterOwnershipV1): string {
  return foster.active ? `Estás cuidando a ${foster.pet.name}` : `Cuidaste a ${foster.pet.name}`;
}

export function fosterOwnershipMetaLabel(foster: MyFosterOwnershipV1): string {
  const org = foster.organizationName ?? "organización";
  const duration = weeksLabel(foster.proposedDurationWeeks);
  if (foster.active) {
    const parts = [`Refugio: ${org}`, `desde ${formatDate(foster.startedAt)}`];
    if (duration !== null) parts.push(`estimado: ${duration}`);
    return parts.join(" · ");
  }
  const endedAt = foster.endedAt === null ? null : formatDate(foster.endedAt);
  return [`Refugio: ${org}`, `del ${formatDate(foster.startedAt)} al ${endedAt ?? "—"}`].join(
    " · ",
  );
}

export type CommandResult =
  | { ok: true; input: FosterCommandInput }
  | { ok: false; message: string; code: FosterCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = fosterCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstFosterCommandInputCode(parsed.error);
  return { ok: false, code, message: fosterInputCodeMessage(code) };
}

/** ACEPTAR LA PROPUESTA. `allowCoFoster` mirrors the web's checkbox, off by default. */
export function buildAcceptFosterProposal(
  proposalToken: string,
  allowCoFoster: boolean,
  responseNotes: string,
): CommandResult {
  return validated({
    command: "accept",
    proposalToken,
    allowCoFoster,
    responseNotes: responseNotes.trim() || null,
  });
}

/** RECHAZAR LA PROPUESTA. A reason is required — the web's form has no "sin motivo". */
export function buildRejectFosterProposal(
  proposalToken: string,
  rejectionReason: FosterRejectionReason,
  responseNotes: string,
): CommandResult {
  return validated({
    command: "reject",
    proposalToken,
    rejectionReason,
    responseNotes: responseNotes.trim() || null,
  });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function fosterInputCodeMessage(code: FosterCommandInputCode | null): string {
  if (code === null) {
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "PROPOSAL_TOKEN_REQUIRED":
      return "No pudimos identificar la propuesta. Actualizá la pantalla y volvé a intentar.";
    case "REJECTION_REASON_INVALID":
      return "Elegí un motivo de la lista.";
    case "NOTE_TOO_LONG":
      return "La nota es demasiado larga.";
  }
}
