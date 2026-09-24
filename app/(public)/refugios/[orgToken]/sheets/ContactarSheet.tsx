"use client";

// Contactar sheet — public contact form on /refugios/[orgToken].
// Handoff P2-8 + D3 override (rate limit only, no captcha).
//
// Layout:
//   - mailto / tel links above the form when the org exposes them
//   - inquirerName (opcional), inquirerEmail (required), message (≤ 500)
//   - Submit → server action with rate limit (3/min IP + 5/day IP + 20/day org)
//   - Success: confirmation copy with the email the org will reply to
//   - Error: inline message under the submit button

import { useActionState, useEffect } from "react";

import { Icon } from "@/components/Icon";
import { LnInput, LnTextarea } from "@/components/ui/Field";
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
  orgEmail: string | null;
  orgPhone: string | null;
}

const initialState: SubmitOrgContactState = { ok: false, error: null };

export function ContactarSheet({ orgToken, orgDisplayName, orgEmail, orgPhone }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const open = searchParams.get("sheet") === "contactar";

  // React 19 resets a `<form action>` once its action settles, and a refusal
  // settles it: the rate limit this form is explicitly built around ("si no
  // entra, esperá un rato y volvé a intentar") used to empty all three fields
  // on its way out, including a 500-character message. The visitor is anonymous
  // — there is no draft anywhere and no account to come back to. `useKeptFields`
  // re-seeds from the form's own submitted `FormData`; contract measured in
  // `__tests__/react19-form-reset-contract.test.tsx`.
  const { boundAction: keptAction, kept } = useKeptFields(
    submitOrgContactAction.bind(null, orgToken, "contact"),
  );
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  // Auto-close 4s after success so the URL clears and the panel reopens
  // cleanly next time. Not blocking — the success copy renders meanwhile.
  useEffect(() => {
    if (!state.ok || !open) return;
    const timer = setTimeout(() => {
      closeSheetNav(buildCloseSheetUrl(pathname, searchParams));
    }, 4000);
    return () => clearTimeout(timer);
  }, [state.ok, open, pathname, searchParams]);

  return (
    <Sheet
      id="contactar"
      title={`Contactar a ${orgDisplayName}`}
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="md"
    >
      <div className="space-y-5">
        {/* Direct channels — when set, give the visitor the fastest path
            before the form. */}
        {(orgEmail || orgPhone) && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3 text-sm space-y-1.5">
            <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">
              Canales directos
            </p>
            {orgEmail && (
              <p>
                <a
                  href={`mailto:${orgEmail}`}
                  className="inline-flex items-center gap-1.5 text-[var(--color-ln-azul)] underline"
                >
                  <Icon name="mail" size="sm" decorative />
                  {orgEmail}
                </a>
              </p>
            )}
            {orgPhone && (
              <p>
                <a
                  href={`tel:${orgPhone}`}
                  className="inline-flex items-center gap-1.5 text-[var(--color-ln-azul)] underline"
                >
                  <Icon name="telefono" size="sm" decorative />
                  {orgPhone}
                </a>
              </p>
            )}
          </div>
        )}

        {state.ok ? (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)]/40 bg-[var(--color-ln-ok)]/10 p-4 text-sm text-[var(--color-ln-ink)]">
            <p className="font-medium">Mensaje enviado.</p>
            <p className="mt-1 text-xs text-[var(--color-ln-ink-2)]">
              Tu mensaje entra en la bandeja de {orgDisplayName} y les avisamos. La respuesta llega
              al correo que dejaste, y depende de ellos: miMAR no responde por la organización.
            </p>
          </div>
        ) : (
          <form action={formAction} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="inquirerName"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Tu nombre <span className="text-[var(--color-ln-mute)] text-xs">(opcional)</span>
              </label>
              <LnInput
                id="inquirerName"
                name="inquirerName"
                defaultValue={kept("inquirerName")}
                type="text"
                maxLength={100}
                autoComplete="name"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="inquirerEmail"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Tu email <span className="text-[var(--color-ln-err)] ml-0.5">*</span>
              </label>
              <LnInput
                id="inquirerEmail"
                name="inquirerEmail"
                defaultValue={kept("inquirerEmail")}
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="vos@ejemplo.com"
              />
              <p className="text-xs text-[var(--color-ln-mute)]">
                Solo lo usamos para que {orgDisplayName} pueda responderte.
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="message"
                className="block text-sm font-medium text-[var(--color-ln-ink)]"
              >
                Mensaje <span className="text-[var(--color-ln-err)] ml-0.5">*</span>
              </label>
              <LnTextarea
                id="message"
                name="message"
                defaultValue={kept("message")}
                required
                rows={5}
                maxLength={500}
                placeholder="Contales por qué los contactás…"
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
              {isPending ? "Enviando…" : "Enviar mensaje"}
            </button>

            <p className="text-sm text-[var(--color-ln-mute)] text-center">
              Hay un límite diario de mensajes por persona para evitar abuso. Si no entra, esperá un
              rato y volvé a intentar.
            </p>
          </form>
        )}
      </div>
    </Sheet>
  );
}
