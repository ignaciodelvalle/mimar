"use client";

// Claim wizard — 3 steps, client-side state machine.
// Step 1: pick identifier kind + value
// Step 2: render the lookup variant
// Step 3 (variant B only): submit dispute with evidence + reason
// Variant "free" (no active custody) claims directly from step 2.

import Link from "next/link";
import { useRef, useState, useTransition } from "react";

import {
  type ClaimLookupResult,
  lookupForClaimAction,
  submitClaimDisputeAction,
  submitFreeClaimAction,
} from "@/app/actions/pet-claim";
import { LnRadio } from "@/components/ui/Field";
import { useStepFocus } from "@/lib/ui/use-step-focus";

type IdKind = "microchip" | "tattoo";

type Step1State = { phase: "idle"; kind: IdKind; value: string; error: string | null };
type Step2State = {
  phase: "result";
  kind: IdKind;
  // The raw identifier value entered in step 1. Carried forward so the free-claim
  // submit can re-prove knowledge of the private identifier server-side (the
  // public pet token is NOT evidence — see submit-free-claim.ts).
  value: string;
  lookup: Extract<ClaimLookupResult, { variant: string }>;
  error: string | null;
};
type Step3State = {
  phase: "dispute";
  // Carried forward for the SAME reason the free-claim branch above carries it:
  // the dispute submit re-proves knowledge of the private identifier
  // server-side. The public pet token is NOT evidence — /perdidas hands those
  // out without a login, so a token-authorized dispute let anyone flip
  // in_custody_dispute on any animal (see submit-claim-dispute.ts).
  kind: IdKind;
  value: string;
  petName: string;
  reason: string;
  error: string | null;
};
type DoneState = { phase: "submitted"; disputeToken: string; petName: string };
type ClaimedState = { phase: "claimed"; petToken: string; petName: string };

type WizardState = Step1State | Step2State | Step3State | DoneState | ClaimedState;

const INITIAL: Step1State = {
  phase: "idle",
  kind: "microchip",
  value: "",
  error: null,
};

export function ClaimWizard() {
  const [state, setState] = useState<WizardState>(INITIAL);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  // A11y fix (2026-07 audit): each phase below is a full early-return (its own
  // JSX tree, not a shared shell), so only one of the phase headlines is ever
  // mounted at a time — the same ref object attaches to whichever one is
  // currently rendered (including the ResultStep variants, via prop). See
  // lib/ui/use-step-focus.ts.
  const stepFocusRef = useRef<HTMLParagraphElement>(null);
  useStepFocus(state.phase, stepFocusRef);

  if (state.phase === "claimed") {
    return (
      <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-6 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="text-base font-semibold text-[var(--color-ln-ok)] focus:outline-none"
        >
          {state.petName} ahora está a tu nombre
        </p>
        <p className="mt-1 text-[var(--color-ln-ok)]">
          Registramos la mascota a tu nombre. Ya podés ver su credencial y completar su libreta
          sanitaria.
        </p>
        <Link
          href={`/mis-mascotas/${state.petToken}`}
          className="mt-4 inline-block text-[var(--color-ln-ok)] underline underline-offset-2"
        >
          Ver a {state.petName} →
        </Link>
      </section>
    );
  }

  if (state.phase === "submitted") {
    return (
      <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-6 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="text-base font-semibold text-[var(--color-ln-ok)] focus:outline-none"
        >
          Reclamo enviado
        </p>
        <p className="mt-1 text-[var(--color-ln-ok)]">
          Una autoridad local va a revisar tu reclamo por {state.petName}. Te avisaremos cuando haya
          una resolución.
        </p>
        <p className="mt-3 font-ln-mono text-xs text-[var(--color-ln-ok)]">
          Referencia: {state.disputeToken}
        </p>
        <Link
          href="/mis-mascotas"
          className="mt-4 inline-block text-[var(--color-ln-ok)] underline underline-offset-2"
        >
          ← Volver a mis mascotas
        </Link>
      </section>
    );
  }

  if (state.phase === "idle") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await lookupForClaimAction({ kind: state.kind, value: state.value });
            if ("error" in result) {
              setState({ ...state, error: result.error });
              return;
            }
            setState({
              phase: "result",
              kind: state.kind,
              value: state.value,
              lookup: result,
              error: null,
            });
          });
        }}
        className="space-y-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-5"
      >
        <fieldset className="space-y-2">
          {/* ref goes on an inner <span>, not <legend> itself: HTMLLegendElement
              has a `form` property HTMLParagraphElement lacks, so the single
              shared stepFocusRef (typed HTMLParagraphElement, reused across
              every other step's <p> heading) isn't structurally assignable to
              it. legend stays the direct child of fieldset (required for the
              accessible-name association) — only the text wraps in the
              focusable span. */}
          <legend className="text-sm font-medium text-[var(--color-ln-ink)]">
            <span ref={stepFocusRef} tabIndex={-1} className="focus:outline-none">
              ¿Cómo identificás a la mascota?
            </span>
          </legend>
          <LnRadio
            name="kind"
            value="microchip"
            checked={state.kind === "microchip"}
            onChange={() => setState({ ...state, kind: "microchip", value: "", error: null })}
          >
            Microchip (15 dígitos)
          </LnRadio>
          <LnRadio
            name="kind"
            value="tattoo"
            checked={state.kind === "tattoo"}
            onChange={() => setState({ ...state, kind: "tattoo", value: "", error: null })}
          >
            Tatuaje
          </LnRadio>
        </fieldset>

        <div className="space-y-1">
          <label
            htmlFor="claim-value"
            className="block text-sm font-medium text-[var(--color-ln-ink)]"
          >
            {state.kind === "microchip" ? "Número de microchip" : "Código del tatuaje"}
          </label>
          <input
            id="claim-value"
            type="text"
            inputMode={state.kind === "microchip" ? "numeric" : "text"}
            pattern={state.kind === "microchip" ? "\\d{15}" : undefined}
            value={state.value}
            onChange={(e) => setState({ ...state, value: e.target.value, error: null })}
            placeholder={state.kind === "microchip" ? "123456789012345" : "ABC-1234"}
            required
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
          />
        </div>

        {state.error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || state.value.trim().length === 0}
          className="w-full rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50"
        >
          {pending ? "Buscando…" : "Buscar"}
        </button>
      </form>
    );
  }

  if (state.phase === "result") {
    return (
      <ResultStep
        lookup={state.lookup}
        pending={pending}
        error={state.error}
        stepFocusRef={stepFocusRef}
        onBack={() => setState(INITIAL)}
        onClaim={(_t, n) =>
          setState({
            phase: "dispute",
            kind: state.kind,
            value: state.value,
            petName: n,
            reason: "",
            error: null,
          })
        }
        onFreeClaim={() => {
          startTransition(async () => {
            const result = await submitFreeClaimAction({
              identifierKind: state.kind,
              identifierValue: state.value,
            });
            if ("error" in result) {
              setState({ ...state, error: result.error });
              return;
            }
            setState({ phase: "claimed", petToken: result.petToken, petName: result.petName });
          });
        }}
      />
    );
  }

  // state.phase === "dispute"
  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        if (!formRef.current) return;
        const fd = new FormData(formRef.current);
        const fileInput = formRef.current.elements.namedItem("evidence") as HTMLInputElement | null;
        const files = fileInput?.files ? Array.from(fileInput.files) : [];
        startTransition(async () => {
          const reason = String(fd.get("reason") ?? "");
          const result = await submitClaimDisputeAction(
            { identifierKind: state.kind, identifierValue: state.value, reason },
            files,
          );
          if ("error" in result) {
            setState({ ...state, error: result.error });
            return;
          }
          setState({
            phase: "submitted",
            disputeToken: result.disputeToken,
            petName: state.petName,
          });
        });
      }}
      className="space-y-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-5 text-sm"
    >
      <div className="space-y-1">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="text-base font-semibold text-[var(--color-ln-warn)] focus:outline-none"
        >
          Iniciar disputa por {state.petName}
        </p>
        <p className="text-[var(--color-ln-warn)]">
          Tu reclamo se envía a la autoridad local para revisión y le avisa a la persona registrada
          como dueña. Contanos por qué creés que es tu mascota y adjuntá al menos una prueba (foto
          del chip escaneado, libreta sanitaria, fotos tuyas con el animal).
        </p>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="claim-reason"
          className="block text-sm font-medium text-[var(--color-ln-warn)]"
        >
          ¿Por qué creés que es tuya?
        </label>
        <textarea
          id="claim-reason"
          name="reason"
          rows={4}
          minLength={20}
          maxLength={2000}
          required
          value={state.reason}
          onChange={(e) => setState({ ...state, reason: e.target.value, error: null })}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-card)] px-3 py-2 text-sm text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        />
        <p className="text-xs text-[var(--color-ln-warn)]">Mínimo 20, máximo 2000.</p>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="claim-evidence"
          className="block text-sm font-medium text-[var(--color-ln-warn)]"
        >
          Evidencia (al menos 1 archivo, máx. 5)
        </label>
        {/* `required` is a courtesy that fails fast in the browser. The rule
            itself lives in submit-claim-dispute.ts — this action is an
            independently-addressable server action, so a client-only check
            would be worth nothing. */}
        <input
          id="claim-evidence"
          name="evidence"
          type="file"
          required
          multiple
          accept="image/*,video/*"
          capture="environment"
          aria-describedby="claim-evidence-hint"
          className="block w-full text-xs text-[var(--color-ln-warn)]"
        />
        <p id="claim-evidence-hint" className="text-xs text-[var(--color-ln-warn)]">
          Sin evidencia no podemos abrir el reclamo: la autoridad necesita algo concreto para
          revisarlo.
        </p>
      </div>

      {state.error && (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setState(INITIAL)}
          className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-warn)]"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={pending || state.reason.trim().length < 20}
          className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-warn)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Enviando…" : "Enviar reclamo"}
        </button>
      </div>
    </form>
  );
}

/**
 * The heading for variant B — the animal is already in somebody's custody.
 *
 * `ownerInitials === null` DOES NOT MEAN "NO CUSTODY", and reading it that way is
 * the bug this function exists to fix. A refugio holding an animal under
 * `shelter_custody` has no owner row and therefore no initials, and the variant is
 * still `active_owner` — so the old single sentence ("ya tiene dueño/a
 * registrado/a" with the parenthetical simply omitted) told the person a
 * shelter-held animal has a registered OWNER, which is false and is exactly the
 * claim they are about to dispute.
 *
 * The two-armed wording is the NATIVE app's, copied rather than re-invented:
 * `apps/mobile/src/claims/claim-view-model.ts` `claimVariantHeadline` already
 * splits on the same field for the same reason, and two apps answering one lookup
 * differently is how the two sentences stop agreeing.
 *
 * EXPORTED because it is the testable half of a component whose other half is a
 * three-step state machine behind two server actions. The doctrine is the one the
 * mobile view-models state: a sentence built inside a component is a sentence
 * testable only by rendering.
 */
export function activeOwnerHeadline(petName: string, ownerInitials: string | null): string {
  return ownerInitials
    ? `${petName} ya tiene dueño/a registrado/a (${ownerInitials}).`
    : `${petName} ya está bajo la custodia de otra persona u organización.`;
}

function ResultStep({
  lookup,
  pending,
  error,
  stepFocusRef,
  onBack,
  onClaim,
  onFreeClaim,
}: {
  lookup: Extract<ClaimLookupResult, { variant: string }>;
  pending: boolean;
  error: string | null;
  stepFocusRef: React.RefObject<HTMLParagraphElement | null>;
  onBack: () => void;
  onClaim: (petToken: string, petName: string) => void;
  onFreeClaim: () => void;
}) {
  // Variant D — free pet (no active custody) → direct claim
  if (lookup.variant === "free") {
    return (
      <section className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-5 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="font-medium text-[var(--color-ln-ok)] focus:outline-none"
        >
          Encontramos a {lookup.petName} y no tiene dueño/a registrado/a.
        </p>
        <p className="text-[var(--color-ln-ok)]">
          Podés reclamarla ahora: queda registrada a tu nombre y te emitimos la credencial.
        </p>
        {error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onBack}
            disabled={pending}
            className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink)] disabled:opacity-50"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={() => onFreeClaim()}
            disabled={pending}
            className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50"
          >
            {pending ? "Reclamando…" : "Reclamarla"}
          </button>
        </div>
      </section>
    );
  }
  // Variant A — not found → invite to register
  if (lookup.variant === "not_found") {
    return (
      <section className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-5 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="font-medium text-[var(--color-ln-ink)] focus:outline-none"
        >
          No encontramos una mascota con ese identificador.
        </p>
        <p className="text-[var(--color-ln-ink-2)]">
          Si la mascota es tuya, registrala ahora y le emitimos la credencial.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink)]"
          >
            Buscar otro identificador
          </button>
          <Link
            href="/mis-mascotas/nueva"
            className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-3 py-2 text-center text-sm font-medium text-white hover:bg-[var(--color-ln-azul-700)]"
          >
            Registrar mascota
          </Link>
        </div>
      </section>
    );
  }

  // Deceased gate
  if (lookup.variant === "deceased") {
    return (
      <section className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] p-5 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="font-medium text-[var(--color-ln-seal)] focus:outline-none"
        >
          Esta mascota figura como fallecida en miMAR.
        </p>
        <p className="text-[var(--color-ln-seal)]">Si creés que es un error, contactá a soporte.</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-seal)]"
        >
          Volver
        </button>
      </section>
    );
  }

  // Variant C — pet is marked lost → encourage sighting
  if (lookup.variant === "lost") {
    return (
      <section className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] p-5 text-sm">
        <p
          ref={stepFocusRef}
          tabIndex={-1}
          className="font-medium text-[var(--color-ln-azul)] focus:outline-none"
        >
          {lookup.petName} está reportada como perdida.
        </p>
        <p className="text-[var(--color-ln-azul)]">
          Si encontraste esta mascota, podés avisar a quien la busca usando el formulario de
          avistaje en lugar de iniciar un reclamo.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-azul)]"
          >
            Volver
          </button>
          <Link
            href={`/p/${lookup.petToken}/sighting`}
            className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-3 py-2 text-center text-sm font-medium text-white hover:bg-[var(--color-ln-azul-700)]"
          >
            Reportar avistaje →
          </Link>
        </div>
      </section>
    );
  }

  // Variant B — active owner → offer dispute
  return (
    <section className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-5 text-sm">
      <p
        ref={stepFocusRef}
        tabIndex={-1}
        className="font-medium text-[var(--color-ln-warn)] focus:outline-none"
      >
        {activeOwnerHeadline(lookup.petName, lookup.ownerInitials)}
      </p>
      <p className="text-[var(--color-ln-warn)]">
        Si pensás que la mascota es tuya, podés iniciar una disputa. Una autoridad local va a
        revisar la evidencia y decidir.
      </p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-warn)]"
        >
          Volver
        </button>
        <button
          type="button"
          onClick={() => onClaim(lookup.petToken, lookup.petName)}
          className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-warn)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Iniciar disputa
        </button>
      </div>
    </section>
  );
}
