"use client";

import type { EventFormState } from "@/app/actions/tattoo";
import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { TATTOO_LOCATIONS } from "@/lib/reference/lookups";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import { useActionState, useState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "tattoo-form";

export function TattooForm({ action }: { action: FormAction }) {
  // The select below keys off kept(), not live state: kept() stays "" until
  // the first submit settles, so it only forces a remount exactly once, at
  // the post-action reset — a key derived from live state remounts on EVERY
  // pick instead, the bug MinimalNewPetForm.test.tsx caught for `breed`.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side, a transition the App Router drops in production —
  // the write committed and the screen never moved.
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();
  const [tattooCode, setTattooCode] = useState("");
  const [locationOnBody, setLocationOnBody] = useState("");
  const [description, setDescription] = useState("");
  const [recordedAt, setRecordedAt] = useState(today);
  const [recordedBy, setRecordedBy] = useState("");

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="tatuaje" decorative />}
        title="Registrar tatuaje"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="Código del tatuaje" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="tattooCode"
                type="text"
                required
                placeholder="Ej: K9-2014-A"
                value={tattooCode}
                onChange={(e) => setTattooCode(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
                mono
              />
            )}
          </LnField>
          <LnField label="Ubicación en el cuerpo">
            {({ id, describedBy, invalid }) => (
              <LnSelect
                // `value=`+`onChange=` alone falls back to its FIRST option
                // on React 19's post-action reset regardless (react-dom's
                // UPDATE path never rewrites `defaultSelected`, only MOUNT
                // does — see lib/ui/use-kept-fields.ts). `key` from `kept()`
                // (not from `locationOnBody`) so the remount happens exactly
                // once, at the post-action reset — not on every pick.
                key={`location-on-body-${kept("locationOnBody")}`}
                id={id}
                name="locationOnBody"
                defaultValue={kept("locationOnBody") || locationOnBody}
                onChange={(e) => setLocationOnBody(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">Sin especificar</option>
                {TATTOO_LOCATIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>
          <LnField
            label="Descripción / origen del tatuaje"
            hint="Texto libre para anotar de dónde viene el tatuaje."
          >
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="description"
                rows={3}
                placeholder="Ej: criadero FCA, campaña de castración CABA 2018, refugio…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Fecha del tatuaje (aproximada)">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="recordedAt"
                type="date"
                mono
                value={recordedAt}
                onChange={(e) => setRecordedAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Tatuado por (criadero / vet / campaña)">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="recordedBy"
                type="text"
                value={recordedBy}
                onChange={(e) => setRecordedBy(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          {/* Tattoo photo — required, shown with AttachmentField aesthetic */}
          <LnField
            label="Foto del tatuaje"
            required
            hint="Imagen de hasta 5 MB. Permite verificar visualmente que coincide con el código."
          >
            {({ id }) => (
              <input
                id={id}
                name="attachment"
                type="file"
                accept="image/*"
                required
                className="block w-full cursor-pointer rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] px-3 py-2.5 font-ln-mono text-sm text-[var(--color-ln-mute)] file:mr-3 file:cursor-pointer file:rounded-[var(--radius-sm)] file:border file:border-[var(--color-ln-line-strong)] file:bg-[var(--color-ln-card)] file:px-2.5 file:py-[5px] file:text-sm file:font-semibold file:text-[var(--color-ln-ink)]"
              />
            )}
          </LnField>
          {state.error && (
            <p
              ref={errorRef}
              className="font-ln-mono text-sm text-[var(--color-ln-err)]"
              role="alert"
              tabIndex={-1}
            >
              {state.error}
            </p>
          )}
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="azul"
        ctaLabel="Registrar tatuaje"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
