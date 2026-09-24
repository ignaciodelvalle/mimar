"use client";

// RevokeSessionsDialog — B11, "cerrar sesión en todos los dispositivos".
//
// The counterpart that makes B9's long citizen session defensible: sessions now
// last weeks, so the person holding one has to be able to end it from somewhere
// else. This is that somewhere else.
//
// WHY IT SITS IN "Privacidad y datos" AND NOT IN "Zona de riesgo"
// ---------------------------------------------------------------------------
// The danger zone is for acts that DESTROY something and cannot be undone from
// the panel — deactivating the account. This one is protective and completely
// reversible: the worst case is you sign in again. Filing it under a red heading
// would teach people to hesitate over precisely the control we want them to
// reach for the moment they think a device was lost.
//
// "Privacidad y datos" is also the one section every account type sees — the
// danger zone is personal-accounts-only, and an institutional operator loses a
// laptop as easily as anyone else.
//
// It still confirms, because it logs the user out of the machine they are
// standing at and that should not happen on a mis-click. No motivo textarea,
// unlike DeactivateAccountDialog: a reason exists there to slow down an
// irreversible act, and here it would be friction charged to someone who may be
// in a hurry for a good reason.
//
// ON SUCCESS: window.location.replace, NOT a router push. The session cookies
// are gone by the time this resolves, so every cached RSC payload in the client
// router refers to a session that no longer exists. A soft navigation would
// render them and show a logged-in shell over a dead session; a full document
// load asks the server, which bounces to login. Same reason
// DeactivateAccountDialog does it.

import { useRef, useState, useTransition } from "react";

// From app/actions/sessions.ts and NOT the auth barrel — see that file's header:
// putting it in the barrel drags requireLiveUser's whole import subtree into
// signup and login.
import { revokeAllSessionsAction } from "@/app/actions/sessions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function RevokeSessionsDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleOpen() {
    setError(null);
    setOpen(true);
  }

  function handleClose() {
    setOpen(false);
    setError(null);
  }

  function handleConfirm() {
    startTransition(async () => {
      const result = await revokeAllSessionsAction();
      if (!result.ok) {
        // Kept OPEN on failure. Closing would leave the user believing it
        // worked, which on a security control is the one outcome worth
        // engineering against.
        setError(result.error);
        return;
      }
      setOpen(false);
      window.location.replace("/iniciar-sesion?motivo=sesiones-cerradas");
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        // The gutter MUST equal ActionRow's (cuenta/page.tsx), because this
        // button renders as one more row inside the same bordered group — 2px of
        // drift shows up as a misaligned item in a stacked list. ActionRow uses
        // the raw 18px arbitrary value, which is grandfathered in the
        // design-token baseline; a NEW file may not add one, so this reaches for
        // the sanctioned token of the same size instead.
        //
        // And the size is NOT written out as an arbitrary-value class anywhere in
        // this comment, deliberately: check-design-tokens.ts matches the pattern
        // as text, so prose that quotes the thing it is explaining trips the
        // fence — measured here, on the first attempt at this note. Same shape as
        // the authz-scanner warning in app/api/v1/me/route.ts.
        //
        // If a third caller ever needs this row chrome, the fix is to lift
        // ActionRow out of page.tsx and let it render a button, not to copy the
        // class string a third time.
        className="flex w-full items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-[var(--space-sheet)] py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-paper-2)] transition-colors text-left"
      >
        <div className="min-w-0">
          <p className="text-md font-medium leading-tight text-[var(--color-ln-ink)]">
            Cerrar sesión en todos los dispositivos
          </p>
          <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
            Si perdiste un teléfono o usaste una compu prestada, cerrá todas las sesiones
          </p>
        </div>
        <span aria-hidden="true" className="flex-shrink-0 text-[var(--color-ln-mute)] text-base">
          ›
        </span>
      </button>

      <ConfirmDialog
        open={open}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title="Cerrar sesión en todos los dispositivos"
        description="Vas a salir de miMAR en todos tus dispositivos, incluido este. Vas a tener que volver a iniciar sesión."
        confirmLabel="Cerrar todas las sesiones"
        cancelLabel="Cancelar"
        tone="danger"
        pending={isPending}
        triggerRef={triggerRef}
      >
        {error && (
          <div className="px-5 pb-3">
            <p className="text-sm text-[var(--color-ln-err)]">{error}</p>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
