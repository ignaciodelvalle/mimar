"use client";

// InviteForm — calls inviteMemberAction and shows the generated invite URL on success.

import { useState, useTransition } from "react";

import { Icon } from "@/components/Icon";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { OpButton, OpCallout } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";
import { inviteMemberAction } from "@/src/modules/organizations/actions";

type RoleOption = { value: string; label: string };

type Props = {
  organizationId: string;
  orgToken: string;
  grantableRoles: RoleOption[];
  /** Least-privileged grantable role — pre-selected so an unchanged submit
   *  never invites someone as admin by accident. Falls back to the first
   *  option if the caller doesn't provide one. */
  defaultRole?: string;
};

export function InviteForm({ organizationId, grantableRoles, defaultRole }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState(defaultRole ?? grantableRoles[0]?.value ?? "");
  const [canWritePetEvents, setCanWritePetEvents] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await inviteMemberAction({
        organizationId,
        email,
        invitedRole: role,
        canWritePetEvents,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setInviteUrl(result.inviteUrl);
      notifySaved("Invitación creada");
    });
  }

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — nothing to do.
    }
  }

  if (inviteUrl) {
    return (
      <div className="space-y-4">
        <OpCallout
          title="Invitación creada"
          body="Compartí este link con la persona que querés sumar al equipo."
          icon={<Icon name="check-circle" decorative />}
        />
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
          <p className="break-all font-ln-mono text-sm text-ln-op-ink">{inviteUrl}</p>
          <div className="flex flex-wrap gap-2">
            <OpButton variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? "¡Copiado!" : "Copiar link"}
            </OpButton>
            <a
              href={`https://wa.me/?text=${encodeURIComponent(inviteUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-ln-op-line px-4 py-[7px] text-sm font-semibold text-ln-op-ink transition-colors hover:bg-ln-op-stripe no-underline"
            >
              WhatsApp
            </a>
          </div>
          <p className="text-sm text-ln-op-mute">
            Este link vence en 14 días. Solo puede ser aceptado por la cuenta con el email indicado.
          </p>
        </div>
        <LnButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setInviteUrl(null);
            setCopied(false);
            setEmail("");
            setRole(defaultRole ?? grantableRoles[0]?.value ?? "");
            setCanWritePetEvents(false);
          }}
        >
          Invitar a otra persona
        </LnButton>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-1">
      <LnField label="Email" required>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
            placeholder="nombre@ejemplo.com"
            required
          />
        )}
      </LnField>

      <LnField label="Rol" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
            required
          >
            {grantableRoles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      <div className="pb-4">
        <LnCheckbox
          checked={canWritePetEvents}
          onChange={(e) => setCanWritePetEvents(e.target.checked)}
        >
          Puede registrar eventos clínicos/sanitarios
        </LnCheckbox>
      </div>

      {error && (
        <p
          className="rounded-[var(--radius-sm)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-sm text-ln-op-danger"
          role="alert"
        >
          {error}
        </p>
      )}

      <LnButton type="submit" variant="primary" loading={pending} className="w-full">
        Crear invitación
      </LnButton>
    </form>
  );
}
