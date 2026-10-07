"use client";

// kept-fields-allowlist: the three boxes below are consents and are NEVER
// restored after a failed submit — the same PO-gated posture as the signup
// form (app/(auth)/registro/SignupForm.tsx): a box the system re-ticks on
// your behalf is one you did not tick that time. The two hidden inputs are
// constants of this render, not the person's work.

import {
  type LegalAcceptanceFormState,
  acceptLegalTermsAction,
} from "@/app/actions/legal-acceptance";
import { TransferConsentBox } from "@/components/legal/LegalConsentBoxes";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox } from "@/components/ui/Field";
import { ADULT_DECLARATION_SENTENCE, LEGAL_VERSION } from "@/lib/reference/legal-version";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import Link from "next/link";
import { useActionState } from "react";

const initialState: LegalAcceptanceFormState = { error: null };

export function LegalAcceptanceForm({ returnTo }: { returnTo: string | null }) {
  const [state, formAction, isPending] = useActionState(acceptLegalTermsAction, initialState);
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  return (
    <form action={formAction} className="space-y-4">
      {/* The version THIS render displays. The server records only its own
          current version and refuses any other, so a page left open across a
          deploy cannot record a text the person never saw. */}
      <input type="hidden" name="legalVersion" value={LEGAL_VERSION} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}

      <LnCheckbox id="tosAccepted" name="tosAccepted" required>
        Leí y acepto los{" "}
        <Link
          href="/terminos"
          target="_blank"
          className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
        >
          Términos y condiciones
        </Link>{" "}
        y la{" "}
        <Link
          href="/privacidad"
          target="_blank"
          className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
        >
          Política de privacidad
        </Link>
        .
      </LnCheckbox>

      <TransferConsentBox />

      <LnCheckbox id="adultDeclared" name="adultDeclared" required>
        {ADULT_DECLARATION_SENTENCE}
      </LnCheckbox>

      {state.error ? (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <LnButton type="submit" variant="primary" size="lg" block disabled={busy}>
        {busy ? "Guardando..." : "Aceptar y continuar"}
      </LnButton>
    </form>
  );
}
