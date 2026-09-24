"use client";

// Ser voluntario — public form (handoff P2-9 + D3 + D4 overrides).
//
// Reuses submitOrgContactAction with kind='volunteer' so the inbox is
// separate from regular contact messages but the rate limit policy +
// validation are shared. Visible from HelpPanel "Sumate como voluntario".
//
// Distinct from the foster pool (ofrecerme-como-transito): voluntario
// means "I want to help — events, walking, cleaning, fundraising". The
// refugio reads the inbox and decides how to use each candidate.

import { useActionState, useEffect } from "react";

import { LnInput } from "@/components/ui/Field";
import { LnTextarea } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import {
  type SubmitOrgContactState,
  submitOrgContactAction,
} from "@/src/modules/organizations/actions";
import { usePathname, useSearchParams } from "next/navigation";

interface Props {
  orgToken: string;
  orgDisplayName: string;
}

const initialState: SubmitOrgContactState = { ok: false, error: null };

export function SerVoluntarioSheet({ orgToken, orgDisplayName }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const open = searchParams.get("sheet") === "ser-voluntario";

  // Same loss as ContactarSheet, same shape, same anonymous visitor: React 19
  // resets a `<form action>` when its action settles, a refusal included, so
  // the shared rate limit emptied name, email and a 500-character offer to
  // help. See `__tests__/react19-form-reset-contract.test.tsx`.
  const { boundAction: keptAction, kept } = useKeptFields(
    submitOrgContactAction.bind(null, orgToken, "volunteer"),
  );
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  useEffect(() => {
    if (!state.ok || !open) return;
    const timer = setTimeout(() => {
      closeSheetNav(buildCloseSheetUrl(pathname, searchParams));
    }, 4000);
    return () => clearTimeout(timer);
  }, [state.ok, open, pathname, searchParams]);

  return (
    <Sheet
      id="ser-voluntario"
      title={`Sumate como voluntario en ${orgDisplayName}`}
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="md"
    >
      <div className="space-y-5">
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Tu ofrecimiento entra en la bandeja de {orgDisplayName} y les avisamos. Si te convocan, te
          escriben al correo que dejes. Pueden ser tareas puntuales (eventos, traslados) o ayuda más
          regular.
        </p>

        {state.ok ? (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)]/40 bg-[var(--color-ln-ok)]/10 p-4 text-sm text-[var(--color-ln-ink)]">
            <p className="font-medium">¡Genial! Tu mensaje llegó.</p>
            <p className="mt-1 text-xs text-[var(--color-ln-ink-2)]">
              El equipo de {orgDisplayName} te va a escribir por email cuando puedan.
            </p>
          </div>
        ) : (
          <form action={formAction} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="vol-inquirerName"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Tu nombre <span className="text-[var(--color-ln-mute)] text-xs">(opcional)</span>
              </label>
              <LnInput
                id="vol-inquirerName"
                name="inquirerName"
                defaultValue={kept("inquirerName")}
                type="text"
                maxLength={100}
                autoComplete="name"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="vol-inquirerEmail"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Tu email <span className="text-[var(--color-ln-err)] ml-0.5">*</span>
              </label>
              <LnInput
                id="vol-inquirerEmail"
                name="inquirerEmail"
                defaultValue={kept("inquirerEmail")}
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="vos@ejemplo.com"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="vol-message"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Contales en qué te interesa ayudar{" "}
                <span className="text-[var(--color-ln-err)] ml-0.5">*</span>
              </label>
              <LnTextarea
                id="vol-message"
                name="message"
                defaultValue={kept("message")}
                required
                rows={5}
                maxLength={500}
                placeholder="Ej: tengo auto y puedo hacer traslados los sábados; ayudo con eventos; quiero pasear perros…"
              />
              <p className="text-xs text-[var(--color-ln-mute)]">Máximo 500 caracteres.</p>
            </div>

            {state.error && (
              <p className="text-sm text-[var(--color-ln-err)] rounded-[var(--radius-sm)] bg-[var(--color-ln-err)]/10 border border-[var(--color-ln-err)]/30 px-3 py-2">
                {state.error}
              </p>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white text-sm font-semibold px-4 py-2.5 hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
            >
              {isPending ? "Enviando…" : "Enviar"}
            </button>
          </form>
        )}
      </div>
    </Sheet>
  );
}
