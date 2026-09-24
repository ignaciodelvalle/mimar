// Compartir — turning the server's answer into what a person reads, and what
// they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a chosen duration to a
// `ShareCommandInput`. Nothing here touches the network, so all of it is
// testable without one.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// same rule `lost-view-model.ts` follows. What lives here is the WORDS: the
// contract carries codes, the consumer owns its copy.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `payload.capabilities` says which of the four commands this caller may send,
// and `share.canRevoke` says it per row — because revocation is creator-or-admin
// while the LIST is every current holder. A screen that derived "can revoke"
// from "this is my pet" would be wrong for exactly the person most likely to
// hit it: a co-owner looking at the other owner's link.
//
// NOTHING HERE MAY LOG A `shareToken`. It is a bearer secret over the animal's
// medical record; see the header of `@dim/contract/api`'s `pet-shares.ts`. The
// functions below that receive one return it inside a string a human reads and
// never put it anywhere else — no `console.*`, and no error message that echoes
// what it was handed.

import type { LibretaShareV1, PetSharesV1, Tier2StateV1 } from "@dim/contract/api";
import type {
  LibretaShareExpiryDays,
  ShareCommandInput,
  ShareCommandInputCode,
  Tier2Window,
} from "@dim/contract/input";
import {
  LIBRETA_SHARE_EXPIRY_DAYS,
  MAX_ACTIVE_LIBRETA_SHARES,
  firstShareCommandInputCode,
  shareCommandInputSchema,
} from "@dim/contract/input";
import { deepLinkUrl } from "@dim/contract/links";

/**
 * The url a person actually shares.
 *
 * The ORIGIN is the caller's, for the reason `publicCredentialPageUrl` states at
 * length: only this build knows which backend it points at. The PATH comes from
 * the same deep-link table the web builds its own link from, so a rename moves
 * both at once instead of producing a link that resolves to a 404 with no
 * compile error anywhere.
 *
 * NOTE THE DESTINATION HAS NO `mimar://` FORM (`appPath: null` in the map) and
 * that is correct rather than missing: a share link is handed to a VET, who by
 * assumption does not have this app. It must open in a browser for anybody.
 */
export function libretaShareUrl(origin: string, shareToken: string): string {
  return deepLinkUrl(origin, "libretaShare", { shareToken });
}

/**
 * The durations this app offers, DERIVED from the contract rather than retyped.
 *
 * The web had this list twice, as two literals that disagreed, in two components
 * of the same sheet. Writing `[7, 30, 90]` here again would have been the third
 * copy — with a better excuse and the same failure mode. The only thing this
 * file adds is the WORDS.
 */
export const SHARE_DURATION_CHOICES: ReadonlyArray<{
  /** `null` is "sin vencimiento" — see the contract on why it is not a number. */
  days: LibretaShareExpiryDays | null;
  label: string;
}> = [
  ...LIBRETA_SHARE_EXPIRY_DAYS.map((days) => ({
    days: days as LibretaShareExpiryDays | null,
    label: `${days} días`,
  })),
  { days: null, label: "Sin vencimiento" },
];

/**
 * The Tier-2 windows, bounded ones first and `siempre` LAST AND MARKED.
 *
 * The web puts the permanent option behind an "Avanzado" expander
 * (`Tier2PublicView.tsx:48-53`) because it is medical detail on a public QR with
 * no expiry — the highest-risk choice on the sheet. This app has no expander, so
 * it carries the risk in the copy instead. What it must NOT do is render the
 * four as one flat list of equals, which would undo that decision silently.
 */
export const TIER2_WINDOW_CHOICES: ReadonlyArray<{
  window: Tier2Window;
  label: string;
  detail: string;
  advanced: boolean;
}> = [
  {
    window: "24h",
    label: "24 horas",
    detail: "Recomendado. Para una visita al vet o un viaje corto.",
    advanced: false,
  },
  {
    window: "7d",
    label: "7 días",
    detail: "Tránsito, cuidador temporal, escapadas de fin de semana.",
    advanced: false,
  },
  {
    window: "30d",
    label: "30 días",
    detail: "Internación, viaje largo, mudanza.",
    advanced: false,
  },
  {
    window: "siempre",
    label: "Siempre visible",
    detail: "Sin vencimiento. Para condiciones crónicas. Podés revertirlo cuando quieras.",
    advanced: true,
  },
];

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * One line describing when a link dies.
 *
 * `expired` COMES FROM THE SERVER and is not recomputed from `expiresAt`. A
 * phone's clock can be days wrong, and the failure that matters is the flattering
 * one: a screen that called a live link dead would have an owner mint a
 * replacement and walk away leaving the real one running.
 */
export function shareExpiryLabel(share: LibretaShareV1): string {
  if (share.expiresAt === null) return "Sin vencimiento";
  if (share.expired) return `Venció el ${formatDate(share.expiresAt)}`;
  return `Vence el ${formatDate(share.expiresAt)}`;
}

/** "Sin vistas" / "1 vista" / "N vistas · última el DD/MM/AAAA". */
export function shareViewsLabel(share: LibretaShareV1): string {
  if (share.viewCount === 0) return "Sin vistas";
  const base = share.viewCount === 1 ? "1 vista" : `${share.viewCount} vistas`;
  if (share.lastViewedAt === null) return base;
  return `${base} · última el ${formatDate(share.lastViewedAt)}`;
}

/** The label the owner gave a link, or an honest stand-in. */
export function shareTitle(share: LibretaShareV1): string {
  return share.label ?? "Link sin nombre";
}

/**
 * Why a revoke control is not offered on this row.
 *
 * `null` means it IS offered. The sentence names the rule rather than the
 * refusal, because "sin permisos" over a link the person can plainly see reads
 * like a bug.
 */
export function shareRevokeBlockedReason(share: LibretaShareV1): string | null {
  if (share.canRevoke) return null;
  return "Solo quien creó este link puede revocarlo.";
}

/** One sentence for the Tier-2 window's current state. */
export function tier2StateLabel(tier2: Tier2StateV1): string {
  if (!tier2.isActive) return "La libreta no se muestra en la credencial pública.";
  if (tier2.isPermanent) return "La libreta se muestra siempre en la credencial pública.";
  if (tier2.activeUntil === null) return "La libreta se muestra en la credencial pública.";
  return `La libreta se muestra en la credencial pública hasta el ${formatDate(tier2.activeUntil)}.`;
}

/**
 * Why the create control is disabled, or `null` when it is not.
 *
 * TWO DIFFERENT REFUSALS BEHIND ONE FLAG, which is why the payload carries
 * `remainingShareSlots` alongside it: "you are not the titular" and "revoke one
 * first" are different problems with different fixes, and a screen that said
 * "no podés" for both would send a titular hunting for a permission they already
 * have.
 */
export function createBlockedReason(payload: PetSharesV1): string | null {
  if (payload.capabilities.canCreateLibretaShare) return null;
  if (payload.capabilities.remainingShareSlots <= 0) {
    return `Llegaste al máximo de ${MAX_ACTIVE_LIBRETA_SHARES} links activos. Revocá uno para crear otro.`;
  }
  return "Solo el titular puede crear links de la libreta.";
}

/** Why the Tier-2 control is disabled, or `null`. */
export function tier2BlockedReason(payload: PetSharesV1): string | null {
  if (payload.capabilities.canEnableTier2) return null;
  return "Solo el titular puede mostrar la libreta en la credencial pública.";
}

export type CommandResult =
  | { ok: true; input: ShareCommandInput }
  | { ok: false; message: string; code: ShareCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = shareCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstShareCommandInputCode(parsed.error);
  return { ok: false, code, message: shareInputCodeMessage(code) };
}

/** CREAR UN LINK, from the chosen duration and the optional label. */
export function buildCreateShare(draft: {
  days: number | null;
  label: string;
}): CommandResult {
  return validated({
    command: "create_libreta_share",
    expiresInDays: draft.days,
    label: draft.label.trim() || null,
  });
}

/** REVOCAR UN LINK, by its ROW id — never by its token. See the contract. */
export function buildRevokeShare(shareId: string): CommandResult {
  return validated({ command: "revoke_libreta_share", shareId });
}

/** ABRIR LA VENTANA TIER-2. */
export function buildEnableTier2(window: Tier2Window): CommandResult {
  return validated({ command: "enable_tier2", window });
}

/** CERRARLA. Unconditional and idempotent, exactly as on the web. */
export function buildRevokeTier2(): CommandResult {
  return validated({ command: "revoke_tier2" });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function shareInputCodeMessage(code: ShareCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "EXPIRY_INVALID":
      return "Elegí una duración de la lista.";
    case "LABEL_TOO_LONG":
      return "El nombre del link es demasiado largo.";
    case "SHARE_ID_REQUIRED":
      return "No pudimos identificar el link. Actualizá la pantalla y volvé a intentar.";
    case "WINDOW_INVALID":
      return "Elegí una duración de la lista.";
  }
}
