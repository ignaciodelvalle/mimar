"use client";

// VaccinationForm — Libreta Nacional redesign (green tone, §8 handoff).
// Presentation ONLY: action, useActionState wiring, field names, and submit
// logic are untouched.

import { Icon } from "@/components/Icon";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnRow, LnTextarea } from "@/components/ui/Field";
import { LnCombobox } from "@/components/ui/LnCombobox";
import { MutationErrorCard } from "@/components/ui/MutationErrorCard";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { suggestNextDueDate } from "@/lib/domain/libreta-health-status";
import { findVaccineByName, vaccinesForSpecies } from "@/lib/reference/lookups";
import { formIsSilentlyValid } from "@/lib/ui/silent-form-validity";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useRetryableAction } from "@/lib/ui/use-retryable-action";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

const FORM_ID = "vaccination-form";

export function VaccinationForm({
  action,
  species,
  initialVaccineName,
  sourceReminderId,
  defaults,
  autoConfirm,
  signedContext,
}: {
  action: FormAction;
  species: string;
  initialVaccineName?: string;
  sourceReminderId?: string;
  defaults?: { occurredAt: string | null; notes: string | null };
  /**
   * True when the surrounding surface signs the event with a verified
   * matrícula (atender). Suppresses the owner-facing "Queda como dato
   * declarado" callout, which is FALSE in that context — the header right
   * above it says "Firmás como matrícula … verificado por profesional", and
   * both texts were rendering together (9-role external run, 2026-08-18).
   * Display-only: free-text behavior and submission are untouched.
   */
  signedContext?: boolean;
  /**
   * Notification quick-reply autoconfirm (capture-console surface #4): when
   * true AND the required fields (vaccine name, application date) are
   * already prefilled and valid, submits the form once on mount — no
   * additional owner tap. Reuses the form's OWN `required` constraint
   * validation via `formRef.current.checkValidity()`; the quick-reply island
   * never builds a FormData or calls `action` itself. If validation fails
   * (e.g. no reminder title AND no matcher-extracted vaccine name), the form
   * just renders normally in edit mode — never a silent failure.
   */
  autoConfirm?: boolean;
}) {
  const { key: idempotencyKey } = useIdempotencyKey();
  // degraded-states: a rejected dispatch (503/abort) becomes a recoverable
  // `transientFailure` state instead of an error-boundary unmount. Retry
  // replays the same form — same hidden clientIdempotencyKey — so the server
  // dedupe resolves a persisted write as confirmation, not a duplicate.
  const retryableAction = useRetryableAction(action, { idempotencyKey });
  const [state, formAction, isPending] = useActionState(retryableAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  // Wave 2 Item 9: focus error region on submit failure (mobile a11y)
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const vaccines = vaccinesForSpecies(species);
  const today = todayIsoInAr();

  const formRef = useRef<HTMLFormElement>(null);

  // P4 item 4 — SUSPICIOUS same-day duplicate warn (non-blocking). Mirrors the
  // P2 soft-dedupe pattern in MinimalNewPetForm.tsx: the action returns a
  // sameDayPrompt state instead of inserting; confirming sets the override
  // hidden input and resubmits the SAME form (all fields stay controlled, so
  // nothing is lost across the round trip).
  const [overrideSameDay, setOverrideSameDay] = useState(false);
  const resubmitAfterOverride = useRef(false);

  useEffect(() => {
    if (overrideSameDay && resubmitAfterOverride.current) {
      resubmitAfterOverride.current = false;
      formRef.current?.requestSubmit();
    }
  }, [overrideSameDay]);

  function confirmSameDay() {
    resubmitAfterOverride.current = true;
    setOverrideSameDay(true);
  }

  // Notification quick-reply autoconfirm (capture-console surface #4). Runs
  // ONCE on mount — the ref guard matters because `autoConfirm` itself never
  // changes after mount, but StrictMode double-invokes effects in dev.
  // The silent validity scan reuses the form's OWN `required` constraints
  // (Vacuna, Fecha de aplicación) — this is the ONLY validation gate; the
  // island that sent us here never inspected form validity itself. Invalid →
  // do nothing, the form just renders normally in edit mode (never a silent
  // failure).
  const autoConfirmSubmitted = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmSubmitted.current) return;
    autoConfirmSubmitted.current = true;
    const form = formRef.current;
    // Silent check, NOT checkValidity(): that fires `invalid` on every
    // failing control, and the LN controls now scroll to the first invalid
    // one — a mount effect must never jump the viewport by itself.
    if (form && formIsSilentlyValid(form)) {
      form.requestSubmit();
    }
  }, [autoConfirm]);

  const sameDayPrompt = !overrideSameDay ? state.sameDayPrompt : undefined;

  const [vaccineName, setVaccineName] = useState(initialVaccineName ?? "");
  // Controlled suggestion list. The field WAS a native <input list>+<datalist>,
  // whose popup never opened reliably for a human tester (Cowork B10 — and some
  // browsers/devices, e.g. iOS Safari, never render datalist suggestions at all).
  // A real app-controlled combobox opens on focus and filters as you type; free
  // text stays allowed (the input value is untouched). Keyboard nav, aria wiring
  // and the listbox shell live in the shared LnCombobox (extracted from this
  // field + LocalityPickerAcross); this component just owns the match algorithm
  // (substring filter over the species catalog) and each option's markup.
  const [vaccineOpen, setVaccineOpen] = useState(false);
  const vaccineMatches = useMemo(() => {
    const q = vaccineName.trim().toLowerCase();
    if (!q) return vaccines;
    return vaccines.filter((v) => v.name.toLowerCase().includes(q));
  }, [vaccineName, vaccines]);

  function pickVaccine(name: string) {
    setVaccineName(name);
    setVaccineOpen(false);
  }

  const [nextDueAt, setNextDueAt] = useState("");
  const [nextDueOverridden, setNextDueOverridden] = useState(false);
  const [occurredAt, setOccurredAt] = useState(defaults?.occurredAt ?? today);
  const [brand, setBrand] = useState("");
  const [batch, setBatch] = useState("");
  const [administeredBy, setAdministeredBy] = useState("");
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  // Counted from the APPLICATION date, through the same calendar helper the
  // server uses to derive next_due_at — see suggestNextDueDate's doc comment
  // for the blind-QA finding that made `occurredAt` a dependency here.
  const suggestedNextDue = useMemo(() => {
    const def = findVaccineByName(vaccineName);
    if (!def) return "";
    return suggestNextDueDate(occurredAt, def.intervalMonths ?? null);
  }, [vaccineName, occurredAt]);

  const effectiveNextDue = nextDueOverridden ? nextDueAt : suggestedNextDue || nextDueAt;

  return (
    <>
      <LnSheetHeader
        tone="verde"
        icon={<Icon name="vacuna" decorative />}
        title="Registrar vacuna"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} ref={formRef} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="sameDayOverride" value={overrideSameDay ? "1" : "0"} />
          {sourceReminderId && (
            <input type="hidden" name="sourceReminderId" value={sourceReminderId} />
          )}

          <LnField label="Vacuna" required>
            {({ id, describedBy, invalid }) => (
              <LnCombobox
                id={id}
                name="vaccineName"
                type="text"
                required
                placeholder="Empezá a tipear o elegí…"
                autoComplete="off"
                value={vaccineName}
                onFocus={() => setVaccineOpen(true)}
                onChange={(e) => {
                  setVaccineName(e.target.value);
                  setVaccineOpen(true);
                }}
                aria-describedby={describedBy}
                invalid={invalid}
                items={vaccineMatches}
                getItemKey={(v) => v.name}
                onSelect={(v) => pickVaccine(v.name)}
                open={vaccineOpen}
                onOpenChange={setVaccineOpen}
                // Original delay was 120ms (vs LocalityPickerAcross's 150ms) —
                // preserved exactly, not worth unifying for an imperceptible diff.
                blurCloseDelayMs={120}
                listClassName="absolute left-0 right-0 z-20 mt-1 max-h-60 overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] py-1 shadow-lg"
                renderItem={(v, { active }) => (
                  <div
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--color-ln-ink)] transition-colors ${
                      active ? "bg-[var(--color-ln-stripe)]" : "hover:bg-[var(--color-ln-stripe)]"
                    }`}
                  >
                    <span>{v.name}</span>
                    {v.isCore && (
                      <span className="font-ln-mono text-xs uppercase tracking-wide text-[var(--color-ln-mute)]">
                        Núcleo
                      </span>
                    )}
                  </div>
                )}
              />
            )}
          </LnField>

          <LnRow>
            <LnField label="Fecha de aplicación" required>
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="occurredAt"
                  type="date"
                  required
                  mono
                  value={occurredAt}
                  onChange={(e) => setOccurredAt(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
            <LnField
              label="Próxima dosis"
              hint={
                !nextDueOverridden && suggestedNextDue
                  ? "Sugerencia automática según catálogo."
                  : undefined
              }
            >
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="nextDueAt"
                  type="date"
                  mono
                  value={effectiveNextDue}
                  onChange={(e) => {
                    setNextDueOverridden(true);
                    setNextDueAt(e.target.value);
                  }}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>
          </LnRow>

          <LnRow>
            <LnField label="Marca / laboratorio">
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="brand"
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>
            <LnField label="Lote">
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="batch"
                  type="text"
                  mono
                  value={batch}
                  onChange={(e) => setBatch(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>
          </LnRow>

          {/* In the signed (atender) context, a blank field defaults to the
              SIGNER's name+matrícula server-side — the vet transcribing a
              colleague's dose must know that blank means "me", or the record
              asserts an applier nobody chose (pre-push review 2026-08-18). */}
          <LnField
            label="Aplicada por (vet / clínica)"
            hint={
              signedContext
                ? "Si lo dejás vacío, queda registrada como aplicada por vos (firmante). Si la aplicó otro profesional, nombralo acá."
                : undefined
            }
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                name="administeredBy"
                type="text"
                value={administeredBy}
                onChange={(e) => setAdministeredBy(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          {/* Was titled "Asiento certificable" and promised that naming the vet
              could make the entry official. It cannot: `administeredBy` is free
              text in the payload, and the server stamps OWNER_AUTHORSHIP
              (authorRole "owner", authorVerified false) on every event written
              from this form — see lib/infra/pet-access.ts. Nothing typed here
              can reach `professional_verified`, so the callout was selling a
              path that does not exist.

              The replacement says what IS true and what the owner can actually
              do about it, reusing the wording pet-compliance.ts already shows
              them on the pet's own card so the two surfaces agree.

              CORRECTED SAME DAY, by a review of this very commit: the first
              draft replaced the false promise with a DIFFERENT false claim —
              "no se puede editar ni borrar despues". Vaccination IS in
              AMENDABLE_EVENT_TYPES and the owner has a working "Corregir
              registro" button on the event page, so that sentence would have
              hidden a feature the product offers. Append-only means the record
              cannot be DELETED or overwritten; a correction adds a new entry
              and the original stays in the history, which is exactly what
              AmendEventForm tells them. Pinned by
              __tests__/event-form-amendability-copy.test.ts. */}
          {!signedContext && (
            <LnCallout tone="azul" title="Queda como dato declarado">
              Este registro entra en la libreta a tu nombre. Si te equivocás podés corregirlo
              después: la corrección agrega un registro nuevo y el original queda visible en el
              historial. Para figurar “al día” en el registro oficial, un veterinario matriculado
              tiene que firmarla: mostrale el código de la credencial de tu mascota y la firma con
              su matrícula.
            </LnCallout>
          )}

          <LnField label="Notas">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          <AttachmentField />

          {state.error && !state.transientFailure && (
            <p
              ref={errorRef}
              className="font-ln-mono text-sm text-[var(--color-ln-err)]"
              role="alert"
              // Wave 2 Item 9: tabIndex={-1} makes the element programmatically focusable
              tabIndex={-1}
            >
              {state.error}
            </p>
          )}

          {/* degraded-states: recoverable transport failure — the card owns the
              cause line (the plain error <p> above is gated off to avoid saying
              it twice) and replays this same form with the same key. */}
          <MutationErrorCard
            transientFailure={state.transientFailure}
            error={state.error}
            formRef={formRef}
          />

          {sameDayPrompt && (
            <LnCallout tone="warn" title="¿Registrar de nuevo?">
              <p className="m-0" role="alert">
                {sameDayPrompt.message}
              </p>
            </LnCallout>
          )}
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="verde"
        ctaLabel="Registrar vacuna"
        formId={FORM_ID}
        isPending={isPending}
        customCta={
          sameDayPrompt ? (
            <button
              type="button"
              onClick={confirmSameDay}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 active:scale-[0.98] active:opacity-90"
            >
              Sí, registrar otra igual
            </button>
          ) : undefined
        }
      />
    </>
  );
}
