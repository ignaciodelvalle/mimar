"use client";

// The door to the reporter view. Asks for the email the reporter left when they
// denounced; the action mails a 30-minute link to that address if — and only if
// — it matches what is on file.
//
// The copy carries the honest limitation up front rather than after a failed
// attempt: a reporter who left a phone or nothing at all cannot be verified by
// this product today, and telling them so before they type is the difference
// between a limitation and a dead end. The response message is identical on
// every outcome (see actions.ts), so this component must never render a
// success/failure distinction — there isn't one to render.

import { useActionState } from "react";

import { LnButton } from "@/components/ui/Button";
import { LnInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { type SolicitarAccesoState, solicitarAccesoDenunciaAction } from "./actions";

const INITIAL: SolicitarAccesoState = { message: null };

export function SolicitarAccesoForm({ code }: { code: string }) {
  // forms/react19-reset-data-loss-inventory: "email" is a bare uncontrolled
  // field — the form settles (this action never redirects, it always shows
  // the same message and stays put) and wipes the typed address every time.
  const { boundAction, kept } = useKeptFields<SolicitarAccesoState>(solicitarAccesoDenunciaAction);
  const [state, formAction, isPending] = useActionState(boundAction, INITIAL);

  return (
    <section className="space-y-4 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-5 py-5">
      <div className="space-y-1.5">
        <h2
          className="text-lg font-semibold text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Ver el seguimiento de mi denuncia
        </h2>
        <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
          Si dejaste un email cuando denunciaste, te mandamos un enlace para ver el estado de tu
          denuncia, tu propio relato y los datos de contacto que guardamos. No necesitás crear una
          cuenta.
        </p>
      </div>

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="code" value={code} />
        <div className="space-y-1.5">
          <label
            htmlFor="accesoEmail"
            className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            Email que dejaste
          </label>
          <LnInput
            id="accesoEmail"
            name="email"
            type="email"
            required
            defaultValue={kept("email")}
            placeholder="tu@email.com"
            autoComplete="email"
          />
        </div>
        <LnButton type="submit" variant="primary" size="lg" block loading={isPending}>
          {isPending ? "Enviando enlace…" : "Enviarme el enlace"}
        </LnButton>
      </form>

      {/* <output> rather than <p role="status">: it carries the same implicit
          live-region role and is the semantic element for a form result. */}
      {state.message && (
        <output className="block text-sm text-[var(--color-ln-ink-2)] leading-relaxed rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] border border-[var(--color-ln-line)] px-3 py-2.5">
          {state.message}
        </output>
      )}

      <p className="text-xs text-[var(--color-ln-mute)] leading-relaxed">
        Todavía no podemos mandar el enlace por SMS. Si dejaste solo un teléfono o denunciaste de
        forma anónima, presentá este código ante el organismo para que te informen el estado.
      </p>
    </section>
  );
}
