"use client";

import { useState, useTransition } from "react";

import {
  retireServiceDogAction,
  setServiceDogVisibilityAction,
  submitServiceDogVerificationRequestAction,
  upsertServiceDogAction,
} from "@/app/actions/service-dog";
import type { PetServiceDog, ServiceDogType } from "@/db";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

const SERVICE_TYPE_OPTIONS: { value: ServiceDogType; label: string; bannerEligible: boolean }[] = [
  { value: "guia", label: "Guía (discapacidad visual)", bannerEligible: true },
  { value: "asistencia_motriz", label: "Asistencia motriz", bannerEligible: true },
  { value: "alerta_medica", label: "Alerta médica (diabetes, epilepsia)", bannerEligible: true },
  { value: "senal_auditiva", label: "Señal (auditiva)", bannerEligible: true },
  { value: "asistencia_tea", label: "Asistencia TEA (autismo)", bannerEligible: true },
  {
    value: "otro",
    label: "Otro (no enumerado por ANDIS — sin banner público)",
    bannerEligible: false,
  },
];

export function ServiceDogForm({
  petPublicToken,
  initial,
}: {
  petPublicToken: string;
  initial: PetServiceDog | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  // Full document reload after every successful mutation: this form drives
  // the Tier-0 public access banner on /p/{token} and the SSR credential
  // status on this page — stale SSR shows/hides the wrong legal banner.
  // router.refresh() is banned (silent-drop defect — see
  // lib/ui/full-page-action-nav.ts).
  const reloadCurrentPage = () => navigateAfterActionSuccess(window.location.href);

  const [confirmRetire, setConfirmRetire] = useState(false);
  const [serviceType, setServiceType] = useState<ServiceDogType>(initial?.serviceType ?? "guia");
  const [trainingCenter, setTrainingCenter] = useState(initial?.trainingCenter ?? "");
  const [trainingCertDate, setTrainingCertDate] = useState(initial?.trainingCertDate ?? "");
  const [rupgaCredential, setRupgaCredential] = useState(initial?.rupgaCredential ?? "");
  const [credentialIssueDate, setCredentialIssueDate] = useState(
    initial?.credentialIssueDate ?? "",
  );
  const [credentialExpiryDate, setCredentialExpiryDate] = useState(
    initial?.credentialExpiryDate ?? "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const canSubmitVerification =
    initial &&
    (initial.credentialStatus === "en_entrenamiento" ||
      initial.credentialStatus === "pendiente_verificacion");
  const isVigente = initial?.credentialStatus === "vigente";
  const isRevoked = initial?.credentialStatus === "revocada";

  function save() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await upsertServiceDogAction({
        petPublicToken,
        serviceType,
        trainingCenter,
        trainingCertDate: trainingCertDate || null,
        rupgaCredential: rupgaCredential.trim() || null,
        credentialIssueDate: credentialIssueDate || null,
        credentialExpiryDate: credentialExpiryDate || null,
        notes: notes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage("Datos guardados.");
      reloadCurrentPage();
    });
  }

  function submitForVerification() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await submitServiceDogVerificationRequestAction({ petPublicToken });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage(
        `Solicitud enviada (${result.approvalRequestPublicToken}). La autoridad va a revisarla.`,
      );
      reloadCurrentPage();
    });
  }

  function toggleVisibility(next: "full_banner" | "private_only") {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await setServiceDogVisibilityAction({
        petPublicToken,
        publicVisibility: next,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reloadCurrentPage();
    });
  }

  function retire() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await retireServiceDogAction({ petPublicToken });
      if ("error" in result) {
        setError(result.error);
        setConfirmRetire(false);
        return;
      }
      setConfirmRetire(false);
      reloadCurrentPage();
    });
  }

  return (
    <div className="space-y-4">
      {isVigente && initial?.inService && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--color-ln-ink)]">Banner público de acceso</p>
          <p className="text-xs text-[var(--color-ln-ink-2)]">
            Cuando lo activás, el banner aparece en{" "}
            <code className="font-ln-mono">/p/{petPublicToken}</code> con el texto del derecho de
            acceso (Arts. 1 y 7, Ley 26.858). Podés mostrarlo en la puerta de un local o transporte.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => toggleVisibility("full_banner")}
              disabled={pending || initial.publicVisibility === "full_banner"}
              className={`px-3 py-1 rounded-[var(--radius-pill)] text-sm ${
                initial.publicVisibility === "full_banner"
                  ? "bg-[var(--color-ln-ok)] text-white"
                  : "border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
              } disabled:opacity-60`}
            >
              Activar banner público
            </button>
            <button
              type="button"
              onClick={() => toggleVisibility("private_only")}
              disabled={pending || initial.publicVisibility === "private_only"}
              className={`px-3 py-1 rounded-[var(--radius-pill)] text-sm ${
                initial.publicVisibility === "private_only"
                  ? "bg-[var(--color-ln-azul)] text-white"
                  : "border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
              } disabled:opacity-60`}
            >
              Mantener privado
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="space-y-4"
      >
        <fieldset disabled={isRevoked} className="space-y-4 disabled:opacity-50">
          <div>
            <label
              htmlFor="service-type"
              className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
            >
              Tipo de servicio
            </label>
            <select
              id="service-type"
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value as ServiceDogType)}
              className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            >
              {SERVICE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--color-ln-mute)] mt-1">
              Las 5 categorías ANDIS habilitan el banner público. "Otro" guarda los datos pero no
              renderiza banner (Res. ANDIS 2588/2022).
            </p>
          </div>

          <div>
            <label
              htmlFor="training-center"
              className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
            >
              Centro de entrenamiento *
            </label>
            <input
              id="training-center"
              type="text"
              required
              value={trainingCenter}
              onChange={(e) => setTrainingCenter(e.target.value)}
              placeholder="Ej: Bocalan Argentina, IGDF/ADI miembro"
              className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            />
            <p className="text-xs text-[var(--color-ln-mute)] mt-1">
              ANDIS reconoce centros miembros de IGDF (International Guide Dog Federation) o ADI
              (Assistance Dogs International).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="training-cert-date"
                className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
              >
                Fecha del certificado del centro
              </label>
              <input
                id="training-cert-date"
                type="date"
                value={trainingCertDate}
                onChange={(e) => setTrainingCertDate(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
            </div>
            <div>
              <label
                htmlFor="rupga-credential"
                className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
              >
                Número RUPGA
              </label>
              <input
                id="rupga-credential"
                type="text"
                value={rupgaCredential}
                onChange={(e) => setRupgaCredential(e.target.value)}
                placeholder="Si ya tenés"
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm font-ln-mono outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="cred-issue"
                className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
              >
                Emisión de la credencial
              </label>
              <input
                id="cred-issue"
                type="date"
                value={credentialIssueDate}
                onChange={(e) => setCredentialIssueDate(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
            </div>
            <div>
              <label
                htmlFor="cred-expiry"
                className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
              >
                Vencimiento de la credencial
              </label>
              <input
                id="cred-expiry"
                type="date"
                value={credentialExpiryDate}
                onChange={(e) => setCredentialExpiryDate(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="sd-notes"
              className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
            >
              Notas (opcional)
            </label>
            <textarea
              id="sd-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            />
          </div>
        </fieldset>

        {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}
        {okMessage && (
          <output className="block text-sm text-[var(--color-ln-ok)]">{okMessage}</output>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={pending || isRevoked}
            className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white text-sm font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50"
          >
            {pending ? "Guardando..." : "Guardar datos"}
          </button>
          {canSubmitVerification && (
            <button
              type="button"
              onClick={submitForVerification}
              disabled={pending}
              className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              Solicitar verificación
            </button>
          )}
          {initial?.inService && !confirmRetire && (
            <button
              type="button"
              onClick={() => setConfirmRetire(true)}
              disabled={pending}
              className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] text-[var(--color-ln-seal)] text-sm hover:bg-[var(--color-ln-err-050)] disabled:opacity-50"
            >
              Retirar del servicio
            </button>
          )}
          {initial?.inService && confirmRetire && (
            <div className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)]/40 bg-[var(--color-ln-err-050)]/30 px-3 py-3 space-y-2">
              <p className="text-sm text-[var(--color-ln-ink-2)]">
                ¿Retirar el perro del servicio? Va a perder los derechos de acceso bajo Ley 26.858.
                El banner público deja de aparecer.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={retire}
                  disabled={pending}
                  className="px-3 py-1.5 rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-colors"
                >
                  {pending ? "Retirando…" : "Confirmar retiro"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRetire(false)}
                  disabled={pending}
                  className="px-3 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] disabled:opacity-60 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
