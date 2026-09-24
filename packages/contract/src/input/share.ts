// Client-input contract for COMPARTIR —
// `POST /api/v1/pets/{publicToken}/shares`.
//
// TWO FEATURES, ONE ENDPOINT, BECAUSE THE WEB ALREADY FUSED THEM. A libreta
// share link and the Tier-2 public window are different mechanisms — one mints a
// bearer-readable URL into `libreta_share_tokens`, the other opens a time-boxed
// window on the animal's OWN public credential by moving two columns on `pets` —
// and a reader could reasonably expect two endpoints. The web disagrees, and it
// disagrees for a product reason worth mirroring: both answer the same question
// a person actually asks, which is "how do I let the vet see this?", and
// `MergedShareSheet` (design ADR-7) puts them in one sheet with one heading
// because a person choosing between them is choosing HOW MUCH to expose, not
// which subsystem to use. Two endpoints would be the app re-splitting what the
// web deliberately joined.
//
// THE REFERENCE POINT is the web's own actions, cited at the GUARD CALL rather
// than at the function that contains it — a function's first line drifts every
// time somebody adds a parameter, and the line that matters is the one naming
// the rule:
//
//   crear link de libreta   `createLibretaShareAction`   app/actions/libreta-share.ts:78
//   revocar link            `revokeLibretaShareAction`   app/actions/libreta-share.ts:92
//   abrir ventana Tier-2    `enableTier2PublicAction`    app/actions/tier2-public.ts:19
//   cerrar ventana Tier-2   `revokeTier2PublicAction`    app/actions/tier2-public.ts:25
//
// AND THOSE FOUR GUARDS ARE NOT THE SAME GUARD, which is the single most
// important thing this file records. Three of them are `requireTitularAccess`.
// The fourth — REVOKE — is `requireLiveUser` at the shim and then a
// CREATOR-OR-ADMIN check inside the writer
// (`src/modules/pets/application/libreta-share/revoke-libreta-share.ts:35`),
// which is neither wider nor narrower than the other three but SIDEWAYS: a
// co-owner who is a perfectly good titular cannot revoke a link they did not
// mint, and the writer says why — medical-history continuity. An endpoint that
// "tidied" the four into one rule would hand a co-owner a revocation the web
// denies them.
//
// WHY THE DURATION SETS LIVE HERE AND NOT IN THE SHEETS THAT USED TO OWN THEM
// ---------------------------------------------------------------------------
// They were UI literals in TWO client components that both call the SAME action,
// and the two had already drifted:
//
//   · `_share-libreta/ShareLibretaSheet.tsx` offered 7 / 30 / sin vencimiento,
//     defaulting to 7, with `maxLength={80}` on the label.
//   · `libreta/SharesManager.tsx` offered 7 / 30 / 90 / sin vencimiento,
//     defaulting to 30, with no length cap on the label at all.
//
// Both are rendered by `MergedShareSheet` — lines 156 and 226 — so the same
// sheet showed a person two different menus for one feature depending on which
// half they scrolled to. Nothing failed, because the server validates NONE of
// it: `create-libreta-share.ts` multiplies whatever number it is handed by
// 86_400_000. That is the `MAX_WEIGHT_KG` situation exactly, and it gets the
// `MAX_WEIGHT_KG` treatment: the set moves here, and both sheets import it back
// so all three doors read ONE menu.

import { z } from "zod";

/**
 * The bounded lifetimes a libreta share link may be given, in days.
 *
 * THE UNION OF THE TWO WEB PICKERS, not the intersection. `SharesManager`
 * offers 90 and `ShareLibretaSheet` does not; taking the intersection would
 * REMOVE a duration an owner can pick on the web today, which is a product
 * change smuggled in as a parity fix. The union removes nothing from anybody.
 *
 * `null` — "sin vencimiento" — is a fourth option and deliberately NOT a member
 * of this array: it is not a number of days, and modelling it as one (0? -1?
 * Infinity?) is how a sentinel ends up multiplied by 86_400_000. It travels as
 * a literal `null` on the wire and is nullable in the schema below.
 */
export const LIBRETA_SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export type LibretaShareExpiryDays = (typeof LIBRETA_SHARE_EXPIRY_DAYS)[number];

/**
 * The longest label a share may carry, in characters.
 *
 * NARROWER THAN THE SERVER, WHICH HAS NO CAP AT ALL — the column is `text` and
 * the writer stores what it is given. It is the cap `ShareLibretaSheet.tsx:115`
 * already puts on its own input; `SharesManager.tsx:162` puts none on its. This
 * takes the one that exists rather than the absence, because "the web has no
 * limit here" is a description of an oversight, not of a decision, and an API is
 * a far easier place to post a 40 kB label from than a text input is.
 */
export const LIBRETA_SHARE_LABEL_MAX = 80;

/**
 * How many active (unrevoked) share links one animal may hold at once.
 *
 * MIRRORED FROM `create-libreta-share.ts:53`, where it is enforced, and carried
 * here so a client can DISABLE the create control with an explanation instead of
 * offering a button that answers with a refusal. It is an affordance hint and
 * NOT the rule — the rule runs in the writer, inside the same query that counts,
 * and a client that ignored this number would simply be refused there.
 */
export const MAX_ACTIVE_LIBRETA_SHARES = 5;

/**
 * The Tier-2 exposure windows, by the card id the web's own picker uses.
 *
 * `siempre` IS ONE OF THEM AND IS NOT LIKE THE OTHER THREE. It is permanent
 * medical exposure on a public QR with no expiry, and the web puts it behind an
 * "Avanzado" expander for exactly that reason (`Tier2PublicView.tsx:48-53`)
 * rather than inline as a peer of the bounded windows. A client that rendered
 * the four as one flat radio group would have undone that decision — the option
 * is fully available, and it is not a default.
 *
 * ENUMERATED, WHERE THE WEB IS LENIENT. `enable-tier2-public.ts:44` reads
 * `DURATION_MS[duration] ?? DAY_MS`, so an unknown string there quietly becomes
 * 24 hours. That is fine for a `<form>` that can only post one of four values
 * and wrong for a JSON body that can post anything: a client sending `"7days"`
 * would get a 24-hour window and a success, and would have no way to notice.
 * Refusing the unknown string is narrower than the web in the direction where
 * being wrong is visible.
 */
export const TIER2_WINDOWS = ["24h", "7d", "30d", "siempre"] as const;
export type Tier2Window = (typeof TIER2_WINDOWS)[number];

export const SHARE_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "EXPIRY_INVALID",
  "LABEL_TOO_LONG",
  "SHARE_ID_REQUIRED",
  "WINDOW_INVALID",
] as const;
export type ShareCommandInputCode = (typeof SHARE_COMMAND_INPUT_CODES)[number];

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalLabel = z
  .string()
  .trim()
  .max(LIBRETA_SHARE_LABEL_MAX, { error: "LABEL_TOO_LONG" })
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * Mint a share link.
 *
 * `expiresInDays` IS REQUIRED AND NULLABLE, which is not the same as optional.
 * Both web sheets always post a duration — neither has a "leave it unset" path —
 * and the two disagree about what the DEFAULT would be (7 vs 30). A contract
 * with an optional field would have to pick one of those two numbers and would
 * therefore be inventing a third opinion about how long an unspecified link
 * lives. Making the field required means a client cannot ask for the ambiguity,
 * and `null` remains available for the deliberate "sin vencimiento".
 */
const createLibretaShare = z.object({
  command: z.literal("create_libreta_share"),
  expiresInDays: z
    .literal(LIBRETA_SHARE_EXPIRY_DAYS, { error: "EXPIRY_INVALID" })
    .nullable()
    .describe("Days until the link stops resolving; null for no expiry."),
  label: optionalLabel,
});

/**
 * Revoke a share link, by the ROW id and never by the token.
 *
 * The web's own control passes `share.id` (`SharesManager.tsx` hands the row to
 * `revokeLibretaShareAction`), and keeping that is a privacy decision rather
 * than a convention: `share_token` is the credential itself. A revoke that took
 * the token would put a live bearer secret into a request body, an access log,
 * a proxy trace and a retry queue — for the one operation whose entire purpose
 * is that the secret should stop working. The row id grants nothing.
 */
const revokeLibretaShare = z.object({
  command: z.literal("revoke_libreta_share"),
  shareId: z.uuid({ error: "SHARE_ID_REQUIRED" }),
});

/** Open the Tier-2 window on the public credential. */
const enableTier2 = z.object({
  command: z.literal("enable_tier2"),
  window: z.enum(TIER2_WINDOWS, { error: "WINDOW_INVALID" }),
});

/** Close it. Takes nothing — the web's revoke is a single button. */
const revokeTier2 = z.object({ command: z.literal("revoke_tier2") });

export const shareCommandInputSchema = z.discriminatedUnion("command", [
  createLibretaShare,
  revokeLibretaShare,
  enableTier2,
  revokeTier2,
]);

export type ShareCommandInput = z.infer<typeof shareCommandInputSchema>;
export type ShareCommand = ShareCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstLostCommandInputCode` — same shape, same reason.
 */
export function firstShareCommandInputCode(
  error: z.ZodError<unknown>,
): ShareCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((SHARE_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as ShareCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
