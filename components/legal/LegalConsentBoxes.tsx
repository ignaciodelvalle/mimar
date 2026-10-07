// The international-transfer consent box, shared by the signup form and the
// re-acceptance screen so the two cannot drift (2026-10-07).
//
// WHY IT IS ITS OWN, SET-APART BOX (legal review 2026-10-02, row P10). A
// transfer to a country without adequate protection rests on the holder's
// express consent (Ley 25.326 art. 12; Dec. 1558/2001 art. 12), and when that
// consent is given beside other declarations it has to appear "en forma expresa
// y destacada" (Dec. 1558/2001 art. 5 inc. 1). Folded into "acepto los Términos
// y la Política" it may not qualify. So: its own required checkbox, inside its
// own bordered group with a heading, naming Brasil and Estados Unidos. The
// sentence lives in @dim/contract/reference (TRANSFER_CONSENT_SENTENCE) so the
// Android app says the same words.
//
// CONSERVATIVE INTERIM (PO decision D2 = b): counsel may later replace the
// consent with model clauses (review row P12) and loosen this.

import { LnCheckbox } from "@/components/ui/Field";
import { TRANSFER_CONSENT_NOTICE, TRANSFER_CONSENT_SENTENCE } from "@/lib/reference/legal-version";
import Link from "next/link";

export function TransferConsentBox({ id = "transferAccepted" }: { id?: string }) {
  return (
    <fieldset className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-paper-2)] p-3">
      <legend className="px-1 text-sm font-semibold text-[var(--color-ln-ink)]">
        Transferencia internacional de tus datos
      </legend>
      <LnCheckbox id={id} name="transferAccepted" required>
        {TRANSFER_CONSENT_SENTENCE}
      </LnCheckbox>
      {/* The art. 6 notice, BEFORE the person ticks and beside the box
          (legal review T3-1): purpose, recipients, withdrawal, rights. */}
      <div className="space-y-1 pl-6 text-sm text-[var(--color-ln-ink-2)]">
        {TRANSFER_CONSENT_NOTICE.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <p className="pl-6 text-sm text-[var(--color-ln-ink-2)]">
        <Link
          href="/privacidad#proveedores"
          target="_blank"
          className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
        >
          Ver qué proveedores son y qué datos reciben
        </Link>
        .
      </p>
    </fieldset>
  );
}
