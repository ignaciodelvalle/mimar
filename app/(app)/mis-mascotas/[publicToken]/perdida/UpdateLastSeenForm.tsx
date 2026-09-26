"use client";

// UpdateLastSeenForm — the "ACTUALIZAR" flow reached from LostCaseBlock's
// "Última vez visto" card while a lost_pet_episode case is open. Single-step
// (unlike MarkLostWizard's 3-step first-time flow): a place/pin + a free-text
// note, submitted as a new owner-authored sighting on the open case (see
// update-lost-last-seen-use-case.ts). On success the server action redirects
// back to the profile — no client-side success screen needed.

import { useActionState } from "react";

import { LocationFields, type LocationSuggestion } from "@/components/LocationFields";
import { LnField, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { EventFormState } from "@/src/modules/events/actions";

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

const initialState: EventFormState = { error: null };

export function UpdateLastSeenForm({
  action,
  petName,
  petJurisdictionProvince,
  petJurisdictionLocality,
  homeSuggestion = null,
  defaultPlaceName,
  defaultNote,
  defaultLat,
  defaultLng,
}: {
  action: FormAction;
  petName: string;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
  /** The animal's registered locality, as a one-tap chip — never a prefill. */
  homeSuggestion?: LocationSuggestion | null;
  /** Pre-filled from the open episode's originating status_changed event. */
  defaultPlaceName: string | null;
  defaultNote: string | null;
  defaultLat: number | null;
  defaultLng: number | null;
}) {
  // forms/react19-reset-data-loss-inventory: "reason" had a STATIC
  // defaultValue={defaultNote} — a rejected submit put back the ORIGINAL
  // note, discarding whatever the owner had just typed.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();

  return (
    <>
      <LnSheetHeader
        tone="seal"
        title={`Actualizar la búsqueda de ${petName}`}
        subtitle="Sumá un dato nuevo — no reemplaza el registro original."
      />
      <LnSheetBody>
        <form id="update-last-seen-form" action={formAction} className="flex flex-col gap-3.5">
          <input
            type="hidden"
            name="clientIdempotencyKey"
            value={idempotencyKey}
            suppressHydrationWarning
          />

          <p className="text-sm text-[var(--color-ln-mute)]">
            Marcá dónde la viste ahora — esto se suma a la actividad del caso, el registro original
            de cuando se marcó como perdida queda intacto.
          </p>

          <LocationFields
            mode="l2"
            defaultValue={{
              address: defaultPlaceName,
              lat: defaultLat,
              lng: defaultLng,
            }}
            biasProvince={petJurisdictionProvince}
            biasLocality={petJurisdictionLocality}
            suggestion={homeSuggestion}
          />

          <LnField label="Novedades">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="reason"
                rows={3}
                defaultValue={kept("reason", defaultNote ?? "")}
                placeholder="Cualquier detalle nuevo (quién la vio, comportamiento, hora aproximada)"
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          {state.error && (
            <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
              {state.error}
            </p>
          )}
        </form>
      </LnSheetBody>

      <LnSheetFooter
        tone="seal"
        formId="update-last-seen-form"
        ctaLabel="Guardar actualización"
        pendingLabel="Guardando…"
        isPending={isPending}
      />
    </>
  );
}
