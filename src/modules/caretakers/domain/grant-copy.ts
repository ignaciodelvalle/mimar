// The caretaker copy that carries a PROMISE, in one place.
//
// Not every string in this module lives here — button labels and headings stay
// with their components. What lives here is the copy that ASSERTS SOMETHING
// ABOUT REALITY and would be a lie if it drifted:
//
//   - the scope sentence, read at the moment of consent;
//   - the two end-of-period notices, read after access was taken away.
//
// Pure by construction: no DB, no Next.js, no `new Date()`. `now` is a
// parameter because the DD/MM formatter appends a year only when the date falls
// outside the CURRENT Argentine calendar year, and a boundary you cannot pin is
// a boundary you cannot test.
//
// WHY EXPIRY COPY IS ITS OWN CONCERN. `ends_at` passing ends ACCESS. It says
// nothing about where the animal physically is. Every draft of this feature
// that wrote "el cuidado terminó" and stopped there was telling a worried owner
// that their pet came home, on the strength of a cron job's clock. The notices
// below stay CONDITIONAL and hand the owner the next action for the case the
// animal did NOT come back — that asymmetry is the whole point of them.

import { formatDateArOmitCurrentYear } from "@/lib/utils/format";

/**
 * The refusal an account sees when the invitation IS addressed to its e-mail
 * address but nobody ever proved the account controls that address (audit
 * A09-1, PO decision 2026-09-02).
 *
 * It is WRITTEN FOR somebody invited by address who created the account by hand
 * instead of following the invitation link, and it names the one action that
 * would unblock them. "Esta invitación no es para tu cuenta." would be a lie by
 * omission — the invitation IS for their address.
 *
 * AS OF 2026-09-03 THAT PERSON NEVER READS IT, and this paragraph replaces one
 * that claimed otherwise. Its single producer is `accept-caretaker-grant.ts`,
 * and every published route to that accept is closed before it: the web page
 * `app/(app)/cuidado/[grantToken]/page.tsx` renders the invitee's buttons only
 * for `relation === "invitee"`, which `get-grant-for-viewer.ts` refuses to an
 * unconfirmed address; the list read behind every hub
 * (`list-caretaker-grants-for-user.ts`) blanks `callerEmail` for that same
 * account, so the row is never offered there either; and the mobile surface
 * answers `/api/v1/me/caretaker-grants` with the CODE `caretaker_forbidden`,
 * never with this sentence. What it does today is be the exact literal
 * `app/api/v1/me/caretaker-grants/commands.ts` keys its 403 rule on — a mapping
 * that stops the same refusal degrading to a 500 — and be the right words the
 * day a surface does show it.
 *
 * TRANSFERS IS NOT LIKE THIS, and the difference is a gap rather than a policy:
 * `UNCONFIRMED_EMAIL_TRANSFER_ERROR` travels `get-transfer-for-viewer.ts` →
 * `getTransferForViewerAction` → the callout in
 * `app/(app)/transferencias/[transferToken]/page.tsx`, so on that side the person
 * IS told what to do. Naming the remedy on the cuidado page means changing
 * user-facing copy, which is a PO decision nobody has taken — see the field
 * comment on `RejectCaretakerGrantInput.callerEmailConfirmed`.
 *
 * HERE RATHER THAN BESIDE THE USE-CASE THAT RETURNS IT, and the reason is
 * mechanical: `app/api/v1/me/caretaker-grants/commands.ts` builds its refusal
 * table from the sentence itself so the two cannot drift, and the route test
 * replaces every `application/*` module with a mock. A constant imported from a
 * mocked module is `undefined` at module load, which takes the whole test file
 * down with a collection error rather than a failing assertion.
 */
export const UNCONFIRMED_EMAIL_CARETAKER_ERROR =
  "Confirmá tu correo electrónico para aceptar esta invitación.";

/**
 * What an active caretaker MAY do. Mirrors the allowed set in the spec
 * ("Allowed caretaker actions") — medical events, notes, photos, lost/found.
 */
export const CARETAKER_SCOPE_ALLOWED =
  "Podés cargar eventos médicos, notas y marcar perdido/encontrado.";

/**
 * What an active caretaker MAY NOT do. The user-facing face of the deny-list
 * (lib/domain/titular-only.ts). If a row is added there, this sentence is the
 * other half of the change — a permission wall discovered by pressing a button
 * is exactly the failure the deny-list UI work exists to prevent.
 */
export const CARETAKER_SCOPE_DENIED =
  "No podés transferir, publicar en adopción ni cambiar datos de identidad.";

/** Both halves. Never render only the permissions. */
export function caretakerScopeSentence(): string {
  return `${CARETAKER_SCOPE_ALLOWED} ${CARETAKER_SCOPE_DENIED}`;
}

/** The titular's cockpit line while an arrangement is running. */
export function activeCaretakerSummary(input: {
  caretakerName: string;
  endsAt: Date;
  now?: Date;
}): string {
  const date = formatDateArOmitCurrentYear(input.endsAt, input.now ?? new Date());
  return `Al cuidado de ${input.caretakerName} hasta el ${date}`;
}

/**
 * The titular's notice after an arrangement AUTO-ENDED.
 *
 * DEVIATION FROM THE SPEC STRING, stated rather than buried. The spec writes
 * "Si Pampa sigue con ella" — a feminine pronoun, correct for Ana and wrong for
 * every male caretaker. `profiles` carries no gender or pronoun, so there is
 * nothing to agree with; repeating the caretaker's name is gender-neutral,
 * unambiguous about WHO the animal might still be with, and preserves the
 * sentence's meaning exactly. Everything the spec's version promises —
 * conditional phrasing, the devolución, the reclamo — is intact.
 *
 * No CTA button rides this notice on purpose. "Iniciá un reclamo" has no single
 * destination today (a denuncia is about maltrato, not about an unreturned
 * animal), and a button that lands somewhere wrong is worse than a sentence
 * that asks the owner to choose.
 */
export function ownerAutoEndNotice(input: {
  caretakerName: string;
  petName: string;
  endedAt: Date;
  now?: Date;
}): string {
  const date = formatDateArOmitCurrentYear(input.endedAt, input.now ?? new Date());
  return `El cuidado temporal de ${input.caretakerName} terminó el ${date}. Si ${input.petName} sigue con ${input.caretakerName}, coordiná la devolución o iniciá un reclamo.`;
}

/**
 * The caretaker's own notice after their period ended.
 *
 * Says ACCESS ended, and nothing about the animal's whereabouts — the mirror of
 * the titular's notice. The pet disappearing from their `/mis-mascotas` with no
 * explanation was the failure this replaces (PO decision 3, 2026-08-19).
 */
export function caretakerAutoEndNotice(input: {
  petName: string;
  endedAt: Date;
  now?: Date;
}): string {
  const date = formatDateArOmitCurrentYear(input.endedAt, input.now ?? new Date());
  return `Tu período de cuidado de ${input.petName} terminó el ${date}. Ya no tenés acceso para cargar eventos.`;
}
