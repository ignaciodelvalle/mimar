"use client";

// Client component for the create-govt form.
// On success, renders MagicLinkResultPanel instead of redirecting.
//
// Two kinds of account are born here (pilot T1-P9): a municipal official
// (`govt`, writes inside its localities) and a national observer (`national`,
// reads the whole country and writes nothing). The observer takes no
// localities, so the picker disappears when it is chosen.

import { useRef, useState } from "react";

import { createInstitutionalAccountAction } from "@/app/actions/admin-institutional";
import { MagicLinkResultPanel } from "@/app/admin/_components/MagicLinkResultPanel";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { OpButton, OpInput } from "@/components/ui/dashboard";
import { emailConfirmationProblem } from "@/lib/domain/email-confirmation";
import { notifySaved } from "@/lib/ui/action-feedback";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

// One row per assigned locality. provinceName is the canonical display
// name from ar_provincias (resolved via LocalityPickerAcross), passed to
// the server action verbatim. indecId is the INDEC id of the row the admin
// picked (C2b): the server resolves by it, so a same-named locality in the
// same province is never swapped for the alphabetically first one.
type LocalityEntry = {
  id: number;
  provinceName: string;
  locality: string;
  indecId: string;
};

/** The two roles this screen creates, with the copy that explains each. */
export const GOVT_SCREEN_ROLES = [
  {
    value: "govt",
    label: "Funcionario municipal",
    hint: "Opera en las localidades que le asignes: cola, denuncias, decomisos, reglas de su jurisdicción.",
  },
  {
    value: "national",
    label: "Observador nacional (solo lectura)",
    hint: "Ve el portal de gobierno con alcance de todo el país. No puede aprobar, denunciar, decomisar ni cambiar nada, y no lleva localidades.",
  },
] as const;

type GovtScreenRole = (typeof GOVT_SCREEN_ROLES)[number]["value"];

type SuccessState = {
  profileId: string;
  magicLink: string;
  displayName: string;
  email: string;
  inviteEmailSent: boolean;
  role: GovtScreenRole;
};

export function CreateGovtForm() {
  const [role, setRole] = useState<GovtScreenRole>("govt");
  const [email, setEmail] = useState("");
  // Typed twice (security review, T1-P3): the access link is mailed to it.
  const [emailConfirmation, setEmailConfirmation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [localities, setLocalities] = useState<LocalityEntry[]>([
    { id: 0, provinceName: "", locality: "", indecId: "" },
  ]);
  const nextId = useRef(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  function addLocality() {
    const id = nextId.current;
    nextId.current += 1;
    setLocalities((prev) => [...prev, { id, provinceName: "", locality: "", indecId: "" }]);
  }

  function removeLocality(id: number) {
    setLocalities((prev) => prev.filter((l) => l.id !== id));
  }

  function setLocalityPick(id: number, provinceName: string, locality: string, indecId: string) {
    setLocalities((prev) =>
      prev.map((l) => (l.id === id ? { ...l, provinceName, locality, indecId } : l)),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const confirmationProblem = emailConfirmationProblem(email, emailConfirmation);
    if (confirmationProblem) {
      setError(confirmationProblem);
      return;
    }
    setError(null);
    setLoading(true);

    const validLocalities = localities
      .filter((l) => l.provinceName && l.locality.trim())
      .map(({ provinceName, locality, indecId }) => ({
        province: provinceName,
        locality,
        localityIndecId: indecId || null,
      }));

    try {
      const result = await createInstitutionalAccountAction({
        role,
        email: email.trim(),
        displayName: displayName.trim(),
        initialLocalities: role === "national" ? [] : validLocalities,
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
          role,
        });
        notifySaved(
          role === "national" ? "Observador nacional creado" : "Cuenta de gobierno creada",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : UNKNOWN_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }

  function handleCreateAnother() {
    setSuccess(null);
    setRole("govt");
    setEmail("");
    setEmailConfirmation("");
    setDisplayName("");
    setLocalities([{ id: 0, provinceName: "", locality: "", indecId: "" }]);
    nextId.current = 1;
    setError(null);
  }

  if (success) {
    return (
      <MagicLinkResultPanel
        magicLink={success.magicLink}
        displayName={success.displayName}
        email={success.email}
        profileId={success.profileId}
        // A national observer has the same detail page as a govt (it is
        // where its deactivation and credential reset live).
        detailPath={`/admin/govts/${success.profileId}`}
        variant="create"
        inviteEmailSent={success.inviteEmailSent}
        onCreateAnother={handleCreateAnother}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-md font-medium text-ln-op-ink">Tipo de cuenta</legend>
          <div className="flex flex-col gap-3 pt-1">
            {GOVT_SCREEN_ROLES.map((r) => (
              <label key={r.value} className="flex items-start gap-2 text-md cursor-pointer">
                <input
                  type="radio"
                  name="role"
                  value={r.value}
                  checked={role === r.value}
                  onChange={() => setRole(r.value)}
                  className="mt-1 accent-ln-op-azul"
                />
                <span>
                  <span className="block text-ln-op-ink">{r.label}</span>
                  <span className="block text-sm text-ln-op-mute">{r.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

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
            placeholder="operador@municipio.gob.ar"
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
            placeholder="operador@municipio.gob.ar"
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
            placeholder="Municipalidad de La Plata"
            maxLength={100}
          />
        </div>

        {role === "govt" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="block text-sm font-medium text-ln-op-ink-2">Localidades iniciales</p>
              <button
                type="button"
                onClick={addLocality}
                className="text-sm text-ln-op-azul hover:text-ln-op-azul-700 underline underline-offset-4"
              >
                + Agregar localidad
              </button>
            </div>
            <p className="text-sm text-ln-op-mute mb-3">
              Opcional. Se pueden asignar más localidades luego desde la página del operador.
            </p>
            <div className="space-y-2">
              {localities.map((l) => (
                <div key={l.id} className="flex gap-2 items-start">
                  <div className="flex-1">
                    <LocalityPickerAcross
                      defaultValue={{
                        provinceName: l.provinceName || null,
                        localityName: l.locality || null,
                        indecId: l.indecId || null,
                      }}
                      onSelect={(r) =>
                        setLocalityPick(
                          l.id,
                          r?.provinceName ?? "",
                          r?.localityName ?? "",
                          r?.indecId ?? "",
                        )
                      }
                      onDeselect={() => setLocalityPick(l.id, "", "", "")}
                    />
                  </div>
                  {localities.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLocality(l.id)}
                      className="text-ln-op-mute hover:text-ln-op-danger text-sm px-2 py-2"
                      aria-label="Quitar localidad"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] bg-ln-op-danger-bg border border-ln-op-danger-bd px-4 py-3">
          <p className="text-md text-ln-op-danger">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <OpButton type="submit" disabled={loading} loading={loading} variant="primary">
          {loading
            ? "Creando..."
            : role === "national"
              ? "Crear observador nacional"
              : "Crear cuenta de gobierno"}
        </OpButton>
        {/* Straight to the hub tab (privileged-accounts fusion 2026-08-02) —
            /admin/govts is redirect-only now, no reason to pay the hop. */}
        <a
          href="/admin/cuentas?registro=govts"
          className="px-5 py-2 text-md border border-ln-op-line rounded-[var(--radius-md)] hover:bg-ln-op-stripe"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
