"use client";

// Post-create / post-reset success panel.
// Displays the magic link returned by createInstitutionalAccountAction or
// resetInstitutionalCredentialsAction behind a reveal toggle, with a copy
// button and guided copy.
//
// Security: the link is a one-time provisioning credential. It is MASKED by
// default (only the copy action works from state) and revealed only on an
// explicit user action.

import { useState } from "react";

import { Icon } from "@/components/Icon";

import { OpButton } from "@/components/ui/dashboard";
import { MAGIC_LINK_TTL_SECONDS, formatTtl } from "@/lib/utils/magic-link-ttl";

// ––– variant copies ––––––––––––––––––––––––––––––––––––––––––––––––––––––––

type Variant = "create" | "reset" | "mfaReset";

const VARIANT_COPY: Record<Variant, { title: string; subtitle: string }> = {
  create: {
    title: "Cuenta institucional creada",
    subtitle: "Compartí el link con el operador para que entre y elija su contraseña.",
  },
  reset: {
    title: "Credenciales restablecidas",
    subtitle: "El link anterior fue invalidado. Compartí el nuevo link con el operador.",
  },
  mfaReset: {
    title: "Segundo factor y credenciales restablecidos",
    subtitle:
      "Cerramos todas sus sesiones y su contraseña anterior ya no sirve. Compartí el link: con él elige una contraseña nueva y configura otra vez la app de autenticación.",
  },
};

// ––– mask helper ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

/** Returns a fixed-length masked placeholder regardless of actual link length. */
export function maskLink(_link: string): string {
  return "••••••••••••••••••••••••••••••••";
}

// ––– component ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

type CopyState = "idle" | "copied" | "error";

type Props = {
  magicLink: string;
  displayName: string;
  email: string;
  profileId: string;
  detailPath: string; // e.g. /admin/govts/[userId]
  variant?: Variant; // defaults to "create" for backwards-compat
  // Used in "create" context: show a "Crear otra" button that resets the form.
  onCreateAnother?: () => void;
  // Used in "reset credentials" context: show a dismiss/close button.
  onReset?: () => void;
  resetLabel?: string;
  // "create" only (pilot T1-P3): whether the access-link mail was accepted. When
  // it did, the link below is the FALLBACK; when it did not, it is the only way
  // in and the panel says so. Omitted (reset) → no mail line at all.
  inviteEmailSent?: boolean;
};

/** The line that tells the admin what reached the operator's inbox. */
export function inviteMailNotice(inviteEmailSent: boolean | undefined, email: string) {
  if (inviteEmailSent === undefined) return null;
  return inviteEmailSent
    ? `Le enviamos a ${email} un mail con el link para entrar y elegir su contraseña. Si no le llega, compartile el link de abajo.`
    : `No pudimos enviar el mail a ${email}. Compartile el link de abajo a mano.`;
}

export function MagicLinkResultPanel({
  magicLink,
  displayName,
  email,
  profileId: _profileId,
  detailPath,
  variant = "create",
  onCreateAnother,
  onReset,
  resetLabel = "Cerrar",
  inviteEmailSent,
}: Props) {
  const mailNotice = inviteMailNotice(inviteEmailSent, email);
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const { title, subtitle } = VARIANT_COPY[variant];
  const ttlLabel = formatTtl(MAGIC_LINK_TTL_SECONDS);

  async function handleCopy() {
    if (!magicLink) return;
    try {
      // Copy from state — not from the visible text — so this works while masked.
      await navigator.clipboard.writeText(magicLink);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  const copyLabel =
    copyState === "copied" ? (
      <span className="inline-flex items-center gap-1">
        Copiado <Icon name="check" size={14} decorative />
      </span>
    ) : copyState === "error" ? (
      "Error al copiar"
    ) : (
      "Copiar"
    );

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-6 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-ln-op-ok">{title}</h3>
        <p className="mt-1 text-md text-ln-op-ok">
          {displayName} &middot; {email}
        </p>
        {mailNotice && (
          <p
            className={`mt-2 text-md ${inviteEmailSent ? "text-ln-op-ok" : "text-ln-op-danger"}`}
            role={inviteEmailSent ? undefined : "alert"}
          >
            {mailNotice}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-md font-medium text-ln-op-ink-2">Link de acceso (magic link)</p>
        <div className="flex gap-2">
          <code
            aria-label={revealed ? "Link de acceso visible" : "Link de acceso oculto"}
            className="flex-1 block overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card px-3 py-2 font-ln-mono text-sm text-ln-op-ink select-none"
          >
            {magicLink
              ? revealed
                ? magicLink
                : maskLink(magicLink)
              : "(link no disponible — usá Resetear credenciales)"}
          </code>
          {magicLink && (
            <>
              <OpButton
                type="button"
                onClick={() => setRevealed((v) => !v)}
                variant="ghost"
                aria-pressed={revealed}
                className="shrink-0 px-3 py-2"
              >
                {revealed ? "Ocultar" : "Revelar"}
              </OpButton>
              <OpButton
                type="button"
                onClick={handleCopy}
                variant="primary"
                className="shrink-0 px-3 py-2"
              >
                {copyLabel}
              </OpButton>
            </>
          )}
        </div>
        {copyState === "error" && (
          <p className="text-sm text-ln-op-danger">No se pudo copiar — copialo manualmente.</p>
        )}
        <p className="text-sm text-ln-op-mute">
          {subtitle} El link expira en {ttlLabel}. Si lo perdés, podés regenerarlo desde la página
          de detalle del operador.
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <a
          href={detailPath}
          className="rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-2 text-md font-medium text-white no-underline transition-colors hover:bg-ln-op-azul-700"
        >
          Ver cuenta
        </a>
        {onCreateAnother && (
          <OpButton type="button" onClick={onCreateAnother} variant="ghost" className="px-4 py-2">
            Crear otra
          </OpButton>
        )}
        {onReset && (
          <OpButton type="button" onClick={onReset} variant="ghost" className="px-4 py-2">
            {resetLabel}
          </OpButton>
        )}
      </div>
    </div>
  );
}
