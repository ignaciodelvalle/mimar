"use client";

// Client component for the create-admin form.
// Same shape as CreateGovtForm but no locality selector (admins have universal scope).

import { useState } from "react";

import { createInstitutionalAccountAction } from "@/app/actions/admin-institutional";
import { MagicLinkResultPanel } from "@/app/admin/_components/MagicLinkResultPanel";
import { OpButton, OpInput } from "@/components/ui/dashboard";
import { emailConfirmationProblem } from "@/lib/domain/email-confirmation";
import { notifySaved } from "@/lib/ui/action-feedback";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

type SuccessState = {
  profileId: string;
  magicLink: string;
  displayName: string;
  email: string;
  inviteEmailSent: boolean;
};

export function CreateAdminForm() {
  const [email, setEmail] = useState("");
  // Typed twice (security review, T1-P3): the access link is mailed to it.
  const [emailConfirmation, setEmailConfirmation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const confirmationProblem = emailConfirmationProblem(email, emailConfirmation);
    if (confirmationProblem) {
      setError(confirmationProblem);
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const result = await createInstitutionalAccountAction({
        role: "admin",
        email: email.trim(),
        displayName: displayName.trim(),
        initialLocalities: [],
      });

      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess({
          profileId: result.profileId,
          magicLink: result.magicLink,
          displayName: displayName.trim(),
          email: email.trim(),
          inviteEmailSent: result.inviteEmailSent,
        });
        notifySaved("Cuenta admin creada");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : UNKNOWN_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }

  function handleCreateAnother() {
    setSuccess(null);
    setEmail("");
    setEmailConfirmation("");
    setDisplayName("");
    setError(null);
  }

  if (success) {
    return (
      <MagicLinkResultPanel
        magicLink={success.magicLink}
        displayName={success.displayName}
        email={success.email}
        profileId={success.profileId}
        detailPath={`/admin/admins/${success.profileId}`}
        variant="create"
        inviteEmailSent={success.inviteEmailSent}
        onCreateAnother={handleCreateAnother}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ln-op-ink-2 mb-1">
            Email{" "}
            <span className="text-ln-op-danger" aria-hidden="true">
              *
            </span>
          </label>
          <OpInput
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nuevo.admin@dim.gob.ar"
          />
        </div>

        <div>
          <label
            htmlFor="emailConfirmation"
            className="block text-sm font-medium text-ln-op-ink-2 mb-1"
          >
            Escribí el correo de nuevo{" "}
            <span className="text-ln-op-danger" aria-hidden="true">
              *
            </span>
          </label>
          <OpInput
            id="emailConfirmation"
            type="email"
            required
            autoComplete="off"
            value={emailConfirmation}
            onChange={(e) => setEmailConfirmation(e.target.value)}
            placeholder="nuevo.admin@dim.gob.ar"
          />
          <p className="mt-1 text-sm text-ln-op-mute">
            El link de acceso se manda a esta dirección: si tiene un error, le llega a otra persona.
          </p>
        </div>

        <div>
          <label htmlFor="displayName" className="block text-sm font-medium text-ln-op-ink-2 mb-1">
            Nombre de display{" "}
            <span className="text-ln-op-danger" aria-hidden="true">
              *
            </span>
          </label>
          <OpInput
            id="displayName"
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Admin miMAR"
            maxLength={100}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] bg-ln-op-danger-bg border border-ln-op-danger-bd px-4 py-3">
          <p className="text-md text-ln-op-danger">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <OpButton type="submit" disabled={loading} loading={loading} variant="primary">
          {loading ? "Creando..." : "Crear cuenta admin"}
        </OpButton>
        {/* Straight to the hub tab (privileged-accounts fusion 2026-08-02) —
            /admin/admins is redirect-only now, no reason to pay the hop. */}
        <a
          href="/admin/cuentas?registro=admins"
          className="px-5 py-2 text-md border border-ln-op-line rounded-[var(--radius-md)] hover:bg-ln-op-stripe"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
