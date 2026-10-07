// "Esperan tu respuesta" — the card on top of Mis mascotas, in words.
//
// The web's twin is `app/(app)/_components/PendingIncomingBanner.tsx`, and the
// reason both exist is the same staging case: an invitation to look after a
// ferret, pending and linked to the invitee's account, that he never saw because
// it surfaced only in the notification inbox and on Transferencias.
//
// PURE. It picks, from the two hub payloads the Transferencias screen already
// reads, the rows that wait on THIS person's yes — `capabilities.canAccept`, the
// server's own answer, never a status this phone re-derives — and writes the one
// sentence each row needs to be decided from: who asked (the display name the
// hub already shows, never an address), which animal and what kind, and the
// dates of the care or the day the offer lapses.

import type { MyCaretakerGrantsV1, MyTransfersV1 } from "@dim/contract/api";
import { pluralizeEs } from "@dim/contract/reference";

import { speciesLabel } from "../pets/species";
import { caretakerGrantRoute, transferRoute } from "../ui/routes";

export type PendingIncomingRow = {
  key: string;
  kind: "caretaker" | "transfer";
  /** The in-app screen where the answer is given. */
  route: ReturnType<typeof caretakerGrantRoute> | ReturnType<typeof transferRoute>;
  /** "Cuidado temporal" / "Transferencia". */
  eyebrow: string;
  sentence: string;
  cta: string;
};

/** Rows the card draws before it hands the rest to Transferencias. */
export const PENDING_INCOMING_MAX_ROWS = 3;

/**
 * "07/10", pinned to Argentina — a UTC day is already tomorrow from 21:00 ART.
 *
 * Built from the en-CA ISO day (`libreta-view-model.ts` does the same) rather
 * than es-AR's own pattern, which drops the zero ("7/10") under some ICU builds
 * and keeps it under others — the web banner prints "07/10" for the same row.
 */
function dayMonth(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  const [, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  })
    .format(date)
    .split("-");
  return `${day}/${month}`;
}

export function pendingIncomingRows(
  transfers: MyTransfersV1 | null,
  caretakerGrants: MyCaretakerGrantsV1 | null,
): PendingIncomingRow[] {
  const invitations: PendingIncomingRow[] = (caretakerGrants?.incoming ?? [])
    .filter((g) => g.status === "pending" && g.capabilities.canAccept)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .map((g) => {
      const pet = `${g.pet.name} (${speciesLabel(g.pet.species)})`;
      const who = g.counterpartyName === null ? "Te pidieron" : `${g.counterpartyName} te pidió`;
      return {
        key: `caretaker:${g.grantToken}`,
        kind: "caretaker",
        route: caretakerGrantRoute(g.grantToken),
        eyebrow: "Cuidado temporal",
        sentence: `${who} que cuides a ${pet} del ${dayMonth(g.startsAt)} al ${dayMonth(g.endsAt)}.`,
        cta: "Ver invitación",
      };
    });

  const offers: PendingIncomingRow[] = (transfers?.incoming.pending ?? [])
    .filter((t) => t.capabilities.canAccept)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
    .map((t) => {
      const pet = `${t.pet.name} (${speciesLabel(t.pet.species)})`;
      const who =
        t.counterpartyName === null
          ? "Te quieren transferir"
          : `${t.counterpartyName} quiere transferirte`;
      return {
        key: `transfer:${t.transferToken}`,
        kind: "transfer",
        route: transferRoute(t.transferToken),
        eyebrow: "Transferencia",
        sentence: `${who} a ${pet}. Vence el ${dayMonth(t.expiresAt)}.`,
        cta: "Ver transferencia",
      };
    });

  return [...invitations, ...offers];
}

/** The card's heading: the count only when there is more than one. */
export function pendingIncomingHeading(count: number): string {
  return count === 1
    ? "Esperan tu respuesta"
    : `Esperan tu respuesta · ${count} ${pluralizeEs(count, "pedido")}`;
}

/** The hand-off line under the capped rows, or `null` when nothing is hidden. */
export function pendingIncomingMoreLabel(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `Ver ${hidden} ${pluralizeEs(hidden, "pedido")} más en Transferencias`;
}
