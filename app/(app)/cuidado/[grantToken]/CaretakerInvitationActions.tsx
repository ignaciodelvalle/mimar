"use client";

// The invitee's response to a caretaker invitation.
//
// Shaped after app/(app)/cuenta/transitos/propuestas/[proposalToken]/
// ProposalActions.tsx — the closest living sibling: an invitee answering a
// proposal, with a consent checkbox and a trámite-style ending. Same two-step
// (choose → confirm) so a single mis-tap never accepts responsibility for
// somebody else's animal.
//
// THE SCOPE IS RENDERED HERE, NOT ON THE PAGE AROUND IT. It is what the person
// is agreeing to, and it belongs adjacent to the button that agrees. Both
// halves always render: a version that listed only the permissions would be
// recruiting caretakers on a half-truth.
//
// KEY 2 OF THE TWO-KEY PUBLIC-CONTACT MODEL lives on this screen and nowhere
// else. It is the ONLY moment the caretaker is asked, and the repository writes
// it in the same UPDATE as the status flip, so there is no later screen that
// could collect it. It starts OFF: the checkbox publishes a third party's
// contact on an unauthenticated page, and a pre-ticked box is a default nobody
// chose (PO decision 2, 2026-08-19).
//
// No redirect() and no router.refresh() — contract N3. Reject reloads this page
// so its SSR state shows the invitation as declined.
//
// ACCEPT RENDERS NOTHING HERE, AND CANNOT. This component used to end on an
// LnSuccessScreen titled "Cuidás a {petName}", behind a local `accepted` flag.
// That screen never appeared in production once, and the reason is structural,
// not a race:
//
//   acceptCaretakerGrantAction calls revalidatePath(`/cuidado/${grantToken}`) —
//   THE ROUTE THE USER IS STANDING ON. Next ships the re-rendered RSC tree back
//   with the action's response. By then the grant's status is 'accepted', so
//   `canRespond` (= invitee AND status 'pending') is false, and the page's
//   `{view.canRespond && …}` gate unmounts this island. `setAccepted(true)`
//   runs against a component that is already gone.
//
// It looked fine in jsdom because this file's test mocks the server action and
// there is no RSC refresh to unmount anything — the same family as the repo's
// "jsdom can't catch activation behaviour" trap: the harness cannot reproduce
// the mechanism, so the harness cannot see the bug.
//
// The honest success surface is the one the SERVER already renders on that same
// re-render: "Detalle del cuidado / Estado: Activo" plus the callout "Estás
// cuidando a {petName}" with a link to the libreta. It says more than the
// deleted screen did and it is the state, not a claim about the state. Do not
// re-add a client success screen here; it is unreachable by construction.

import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { LnCheckbox } from "@/components/ui/Field";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  acceptCaretakerGrantAction,
  rejectCaretakerGrantAction,
} from "@/src/modules/caretakers/actions";

type Props = {
  grantToken: string;
  petName: string;
  titularName: string;
  /** Both halves of the scope, from the caretakers domain. */
  scopeSentence: string;
};

export function CaretakerInvitationActions({
  grantToken,
  petName,
  titularName,
  scopeSentence,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"none" | "accept" | "reject">("none");
  const [publicContactConsent, setPublicContactConsent] = useState(false);

  // The scope sentence arrives pre-joined so the page and this component can
  // never disagree; splitting it back for display keeps the two halves on
  // separate lines without a second source of the words.
  const scopeParts = scopeSentence.split(/(?<=\.)\s+/).filter(Boolean);

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptCaretakerGrantAction({ grantToken, publicContactConsent });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Nothing on success. The action's revalidatePath of THIS route re-renders
      // the page around us with the grant now 'accepted', which drops
      // `canRespond` and unmounts this island — the server's own "Estás cuidando
      // a …" state replaces it. See the header for why a success screen here
      // could never paint.
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectCaretakerGrantAction({ grantToken });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full document reload so this page's SSR state shows the declined
      // invitation (router.refresh() is banned — lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="cg-scope-h"
        className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3.5"
      >
        <h2
          id="cg-scope-h"
          className="m-0 mb-2 font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]"
        >
          Qué podés hacer con esta mascota
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {scopeParts.map((part) => (
            <li key={part} className="text-md leading-snug text-[var(--color-ln-ink-2)]">
              {part}
            </li>
          ))}
        </ul>
      </section>

      {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}

      {mode === "accept" && (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-4">
          <p className="m-0 text-md text-[var(--color-ln-ink-2)]">
            Vas a quedar como cuidador/a temporal de {petName}. {titularName} puede finalizar el
            cuidado en cualquier momento.
          </p>
          <LnCheckbox
            checked={publicContactConsent}
            onChange={(e) => setPublicContactConsent(e.target.checked)}
          >
            Si {petName} se pierde, permito que {titularName} muestre mi contacto en la credencial
            pública. Podés cuidarla igual sin aceptar esto.
          </LnCheckbox>
          <div className="flex flex-wrap gap-2">
            <LnButton variant="ok" onClick={accept} disabled={pending}>
              {pending ? "Confirmando…" : "Confirmar el cuidado"}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      )}

      {mode === "reject" && (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-4">
          <p className="m-0 text-md text-[var(--color-ln-ink-2)]">
            {titularName} va a recibir el aviso de que no podés cuidar a {petName}. Si cambiás de
            idea después, te tiene que invitar de nuevo.
          </p>
          <div className="flex flex-wrap gap-2">
            <LnButton variant="seal" onClick={reject} disabled={pending}>
              {pending ? "Enviando…" : "Confirmar el rechazo"}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      )}

      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          <LnButton variant="ok" onClick={() => setMode("accept")}>
            Aceptar el cuidado
          </LnButton>
          <LnButton variant="ghost" onClick={() => setMode("reject")}>
            Rechazar la invitación
          </LnButton>
        </div>
      )}
    </div>
  );
}
