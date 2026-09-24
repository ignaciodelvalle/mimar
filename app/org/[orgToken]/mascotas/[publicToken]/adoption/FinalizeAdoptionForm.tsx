"use client";

import { LnCheckbox, LnField, LnFileInput, LnInput, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { ACTION_STALL_COPY, ACTION_STALL_MS } from "@/lib/ui/action-stall";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import {
  type FinalizeAdoptionFormState,
  checkAdopterAccountAction,
  finalizeAdoptionAction,
} from "@/src/modules/adoption/actions";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

const initialState: FinalizeAdoptionFormState = { error: null };

export type ApprovedApplication = {
  applicationEventId: string;
  applicantName: string | null;
};

/**
 * Pre-submit account check state (org-pilot-pack D8). The manual-DNI path can
 * only finalize onto a REGISTERED miMAR account, so the operator verifies the
 * DNI first: found → finalize (and contract print) unlock; not found → refusal
 * panel with the signup QR. "Volver a verificar" resets to idle WITHOUT any
 * navigation, so the in-progress finalize context survives a mid-flow signup
 * (spec 2.5).
 */
type AccountCheck =
  | { status: "idle" }
  | { status: "found"; displayName: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

export function FinalizeAdoptionForm({
  orgToken,
  publicToken,
  fosterShortcut,
  approvedApplications,
  signupQrSvg,
}: {
  orgToken: string;
  publicToken: string;
  fosterShortcut: { adopterUserId: string; displayName: string } | null;
  approvedApplications: ApprovedApplication[];
  /** Server-rendered SVG QR pointing at the signup flow (refusal panel). */
  signupQrSvg: string;
}) {
  const action = finalizeAdoptionAction.bind(null, orgToken, publicToken);
  // forms/react19-reset-data-loss-inventory #4: adopterDisplayName and
  // adopterPhone had neither `value` nor `defaultValue` — a rejected submit
  // (e.g. the DNI check failing server-side) wiped both, on top of the DNI
  // field the operator had just re-typed to fix. `useKeptFields` re-seeds
  // them from the FormData actually submitted.
  const { boundAction, kept } = useKeptFields<FinalizeAdoptionFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // On success the action returns `redirectTo`; navigate via a full document
  // load (immune to the Next 15.5.x router-drop that stranded this flow — see
  // the FinalizeAdoptionFormState.redirectTo docblock).
  const navigating = useActionRedirect(state.redirectTo, state);

  // D.12 noisy failure. Finalizing an adoption rides the same dropped
  // post-action navigation as the atender signing surface: the action commits
  // and the button stays on "Finalizando adopción…" forever, so the operator
  // finalizes again and the append-only spine keeps both. Once the submit has
  // been pending past ACTION_STALL_MS we stop implying progress and say what we
  // actually know — nothing — instead of nothing at all.
  // `navigating` is excluded on purpose: once the full document load has
  // started the flow IS working, it is just slow.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!isPending || navigating) {
      setStalled(false);
      return;
    }
    const t = setTimeout(() => setStalled(true), ACTION_STALL_MS);
    return () => clearTimeout(t);
  }, [isPending, navigating]);

  const hasApproved = approvedApplications.length > 0;
  // Default to the approved-application path when one exists — it transfers the
  // pet to the adopter's real account. The typed-DNI / foster path is the
  // secondary "offline adoption" fallback.
  const [offline, setOffline] = useState(!hasApproved);
  const [selectedAppId, setSelectedAppId] = useState(
    approvedApplications[0]?.applicationEventId ?? "",
  );
  const [useFosterShortcut, setUseFosterShortcut] = useState(Boolean(fosterShortcut));

  // Manual-DNI account check (org-pilot-pack). The DNI input is controlled so
  // the check binds to exactly what will be submitted; editing the DNI resets
  // the check — a stale "found" must never authorize a different number.
  const [dniValue, setDniValue] = useState("");
  const [check, setCheck] = useState<AccountCheck>({ status: "idle" });
  const [checkPending, startCheck] = useTransition();
  // Mirror of dniValue for the in-flight guard below: the onChange reset only
  // covers the SYNC case — an in-flight response landing AFTER an edit would
  // override the reset (transition updates batch after urgent ones) and show
  // "Cuenta encontrada: <name for A>" beside an input holding B (ultrareview
  // 2026-08-07, bug_001). The ref lets the response bail when the operator
  // moved on. Server-side both consumers re-verify regardless.
  const dniValueRef = useRef(dniValue);
  dniValueRef.current = dniValue;

  // Controlled so the sibling contract-print form (below) can mirror them into
  // its hidden inputs — the printed document carries the same follow-up and
  // notes the finalize will submit.
  const [followupValue, setFollowupValue] = useState("6");
  // The native control printed the chosen filename; hiding it (LnFileInput)
  // moves that feedback here.
  const [contractFileName, setContractFileName] = useState("");
  const [notesValue, setNotesValue] = useState("");

  function verifyAccount() {
    const requested = dniValue;
    startCheck(async () => {
      const r = await checkAdopterAccountAction(orgToken, requested);
      // The operator edited the DNI while this check was in flight — the
      // response belongs to a number no longer in the field. Drop it.
      if (requested !== dniValueRef.current) return;
      if ("error" in r) setCheck({ status: "error", message: r.error });
      else if (r.found) setCheck({ status: "found", displayName: r.displayName });
      else setCheck({ status: "not_found" });
    });
  }

  const usingApplication = hasApproved && !offline;
  const manualDniPath = offline && !useFosterShortcut;
  // The manual-DNI path finalizes only onto a verified-found account.
  const submitBlocked = manualDniPath && check.status !== "found";

  return (
    <>
      {/* ⚠ `onSubmitCapture` IS LOAD-BEARING — DO NOT REMOVE IT. On the atender
        signing surface, registering a capture-phase `submit` listener above the
        form is what stops the dropped-navigation wedge outright: measured there
        at 0/16 navigated without it and 16/16 with it, against an extra bare
        <div> (0/16) and an extra client component without the handler (0/16), so
        the listener — not the element and not the component — is the cause. That
        A/B was run on atender, NOT here: this surface is not reachable from the
        harness without staging a live adoption, so the same wedge is assumed to
        share the mechanism and is not proven to. The `stalled` notice below stays
        regardless, because an unproven fix is exactly when D.12's truthful
        failure has to still be there. */}
      <form
        action={formAction}
        onSubmitCapture={() => setStalled(false)}
        className="space-y-4"
        encType="multipart/form-data"
      >
        {usingApplication && (
          <section className="rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-4 space-y-3">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ln-op-ok">
                Postulante aprobado
              </h2>
              <p className="text-ln-op-ok text-sm">
                La mascota queda registrada en la cuenta de la persona que se postuló online. La va
                a ver en <strong>Mis mascotas</strong> al instante y recibe una notificación.
              </p>
            </div>

            <fieldset className="space-y-2">
              <legend className="sr-only">Elegí la postulación a finalizar</legend>
              {approvedApplications.map((app) => (
                <label
                  key={app.applicationEventId}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-ln-op-ok-bd bg-white/40 px-3 py-2 text-md text-ln-op-ink cursor-pointer"
                >
                  <input
                    // Residual from forms/react19-reset-data-loss-inventory
                    // batch 1: a controlled radio ("checked=") falls back to
                    // its MOUNT value on React 19's post-action reset (same
                    // "counter-intuitive pair" as a controlled checkbox — see
                    // lib/ui/use-kept-fields.ts). The submitted value itself
                    // (the hidden `applicationEventId` input below) is a
                    // controlled text-ish input and survives on its own, but
                    // the VISIBLE radio desyncing from it — snapping back to
                    // the first application after any error — is confusing
                    // enough on its own to fix. No `kept()` involved: this
                    // isn't FormData-echo, it's parent state, so the fix is
                    // the same one LegalMetadataFieldset's select used —
                    // uncontrolled `defaultChecked` plus a `key` derived from
                    // the source of truth, which remounts (and re-writes the
                    // correct default) on every real selection change.
                    key={`app-choice-${app.applicationEventId}-${selectedAppId}`}
                    type="radio"
                    name="__appChoice"
                    defaultChecked={selectedAppId === app.applicationEventId}
                    onChange={() => setSelectedAppId(app.applicationEventId)}
                  />
                  <span>{app.applicantName ?? "Postulante"}</span>
                </label>
              ))}
            </fieldset>

            <input type="hidden" name="applicationEventId" value={selectedAppId} />

            <button
              type="button"
              onClick={() => setOffline(true)}
              className="text-sm text-ln-op-azul underline hover:text-ln-op-ink"
            >
              ¿Adopción por fuera de las postulaciones?
            </button>
          </section>
        )}

        {offline && (
          <>
            {hasApproved && (
              <button
                type="button"
                onClick={() => setOffline(false)}
                className="text-sm text-ln-op-azul underline hover:text-ln-op-ink"
              >
                ← Volver a las postulaciones aprobadas
              </button>
            )}

            {fosterShortcut && (
              <section className="rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-4 space-y-3">
                <LnCheckbox
                  // Same residual and same fix as the __appChoice radio
                  // above: a controlled checkbox falls back to its MOUNT
                  // value (here: checked, since this section only renders
                  // when fosterShortcut exists) on the post-action reset —
                  // so choosing the manual-DNI path instead, then hitting a
                  // server error there, silently flipped this back ON and
                  // hid the DNI fields the operator was filling.
                  key={`foster-shortcut-${useFosterShortcut}`}
                  id="use-foster-shortcut"
                  defaultChecked={useFosterShortcut}
                  onChange={(e) => setUseFosterShortcut(e.target.checked)}
                >
                  <strong className="block text-md text-ln-op-ok">
                    Finalizar adopción al tránsito actual ({fosterShortcut.displayName})
                  </strong>
                  <span className="text-ln-op-ok text-sm block mt-1">
                    El voluntario que está cuidando a esta mascota se convierte en dueño/a. Saltamos
                    el paso de pedirte el DNI.
                  </span>
                </LnCheckbox>
                {useFosterShortcut && (
                  <input type="hidden" name="adopterUserId" value={fosterShortcut.adopterUserId} />
                )}
              </section>
            )}

            {!useFosterShortcut && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-ln-op-mute">
                  Adoptante
                </h2>
                <LnField
                  label="DNI"
                  required
                  hint="La persona tiene que tener cuenta miMAR con ese DNI"
                >
                  {({ id, describedBy, invalid }) => (
                    <LnInput
                      id={id}
                      name="adopterDni"
                      required={!useFosterShortcut}
                      inputMode="numeric"
                      placeholder="12345678"
                      value={dniValue}
                      onChange={(e) => {
                        setDniValue(e.target.value);
                        // A stale check must never authorize a different DNI.
                        setCheck({ status: "idle" });
                      }}
                      aria-describedby={describedBy}
                      invalid={invalid}
                    />
                  )}
                </LnField>

                {check.status !== "found" && check.status !== "not_found" && (
                  <OpButton
                    type="button"
                    onClick={verifyAccount}
                    disabled={checkPending || !dniValue.trim()}
                    variant="ghost"
                  >
                    {checkPending ? "Verificando…" : "Verificar cuenta"}
                  </OpButton>
                )}

                {check.status === "error" && (
                  <p className="text-sm rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
                    {check.message}
                  </p>
                )}

                {check.status === "found" && (
                  <div className="rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-4 space-y-2">
                    <p className="text-md font-semibold text-ln-op-ok">
                      Cuenta encontrada: {check.displayName}
                    </p>
                    <p className="text-sm text-ln-op-ok">
                      La adopción se registra en esa cuenta miMAR. La persona va a ver la mascota en{" "}
                      <strong>Mis mascotas</strong> al finalizar.
                    </p>
                    {/* Submits the SIBLING print form (forms can't nest) — opens
                      the print-ready contract in a new tab. Stateless read:
                      printing writes nothing. */}
                    {/* Copy realigned 2026-08-08. It still called the contract
                        a "borrador pendiente de revisión legal" — the wording
                        from BEFORE the PO approved the 7-clause model as an
                        orientative template (2026-08-07). The printed document
                        itself already banners the approved wording, so the
                        button and the sheet were telling the org two different
                        things about the same page's legal weight. */}
                    <OpButton type="submit" form="adoption-contract-print" variant="ghost">
                      Imprimir modelo de contrato
                    </OpButton>
                    <p className="text-sm text-ln-op-ok">
                      Es un modelo orientativo de miMAR — revisalo con tu organización. Una vez
                      firmado, subilo en «Contrato firmado» antes de finalizar.
                    </p>
                  </div>
                )}

                {check.status === "not_found" && (
                  <div
                    role="alert"
                    className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg p-4 space-y-3"
                  >
                    <p className="text-md font-semibold text-ln-op-warn">
                      No encontramos una cuenta miMAR con ese DNI
                    </p>
                    <p className="text-sm text-ln-op-warn">
                      Para finalizar la adopción, la persona adoptante tiene que registrarse en
                      miMAR con <strong>ese mismo DNI</strong>. Puede escanear este QR desde su
                      celular para crear la cuenta ahora; cuando termine, tocá «Volver a verificar».
                      No se crean perfiles provisorios.
                    </p>
                    <div
                      className="w-40 rounded-[var(--radius-sm)] bg-white p-2"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from qrcode lib
                      dangerouslySetInnerHTML={{ __html: signupQrSvg }}
                    />
                    <OpButton
                      type="button"
                      onClick={verifyAccount}
                      disabled={checkPending}
                      variant="ghost"
                    >
                      {checkPending ? "Verificando…" : "Volver a verificar"}
                    </OpButton>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <LnField label="Nombre completo" required>
                    {({ id, describedBy, invalid }) => (
                      <LnInput
                        id={id}
                        name="adopterDisplayName"
                        required={!useFosterShortcut}
                        maxLength={200}
                        defaultValue={kept("adopterDisplayName")}
                        aria-describedby={describedBy}
                        invalid={invalid}
                      />
                    )}
                  </LnField>
                  <LnField label="Teléfono">
                    {({ id, describedBy }) => (
                      <LnInput
                        id={id}
                        name="adopterPhone"
                        maxLength={30}
                        defaultValue={kept("adopterPhone")}
                        aria-describedby={describedBy}
                      />
                    )}
                  </LnField>
                </div>
              </section>
            )}
          </>
        )}

        <section className="space-y-3 pt-2 border-t border-ln-op-line">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ln-op-mute">
            Seguimiento
          </h2>
          <LnField
            label="Meses de seguimiento post-adopción"
            hint="Generará recordatorios de check-in con el adoptante (default: 6)."
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                name="followupMonths"
                type="number"
                min={0}
                max={36}
                value={followupValue}
                onChange={(e) => setFollowupValue(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>
          <LnField label="Notas del contrato">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                maxLength={500}
                placeholder="Condiciones especiales, observaciones, referencia al contrato firmado…"
                value={notesValue}
                onChange={(e) => setNotesValue(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>
          <LnField
            label="Contrato firmado (PDF o imagen)"
            hint="Si lo subís, queda enlazado al evento de adopción y al expediente del animal."
          >
            {({ id, describedBy }) => (
              <LnFileInput
                id={id}
                name="contract"
                accept="application/pdf,image/*"
                aria-describedby={describedBy}
                status={contractFileName}
                onChange={(e) => setContractFileName(e.target.files?.[0]?.name ?? "")}
              />
            )}
          </LnField>
        </section>

        {state.error && (
          <p className="text-sm rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
            {state.error}
          </p>
        )}

        {stalled && (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3"
          >
            <p className="text-md font-semibold text-ln-op-warn">
              {ACTION_STALL_COPY.adoption.title}
            </p>
            <p className="mt-1 text-sm text-ln-op-warn">{ACTION_STALL_COPY.adoption.body}</p>
            <p className="mt-2">
              {/* A hard document GET on purpose: the router transition is exactly
                what is broken here, so `next/link` is not a safe way out. */}
              <a
                href={`/org/${orgToken}/mascotas/${publicToken}`}
                className="text-sm font-semibold text-ln-op-warn underline"
              >
                Volver a la ficha de esta mascota
              </a>
            </p>
          </div>
        )}

        {submitBlocked && (
          <p className="text-sm text-ln-op-mute">
            Verificá la cuenta miMAR del adoptante para habilitar la finalización.
          </p>
        )}

        <OpButton type="submit" disabled={isPending || submitBlocked} variant="ok">
          {isPending ? "Finalizando adopción…" : "Finalizar adopción"}
        </OpButton>
      </form>

      {/* Sibling contract-print form (org-pilot-pack C2) — forms can't nest,
          so the print POST lives OUTSIDE the finalize form and the button in
          the found panel targets it via form="adoption-contract-print". POST
          keeps the DNI out of the URL/logs; target=_blank opens the print
          view without abandoning the in-progress finalize. Rendered only once
          the account check succeeded — the route re-validates server-side
          anyway. */}
      {check.status === "found" && (
        <form
          id="adoption-contract-print"
          method="post"
          action={`/org/${orgToken}/mascotas/${publicToken}/adoption/contrato`}
          target="_blank"
        >
          <input type="hidden" name="adopterDni" value={dniValue} />
          <input type="hidden" name="followupMonths" value={followupValue} />
          <input type="hidden" name="notes" value={notesValue} />
        </form>
      )}
    </>
  );
}
