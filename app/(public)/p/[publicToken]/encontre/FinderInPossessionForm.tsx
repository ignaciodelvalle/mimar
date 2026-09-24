"use client";

// Heavy finder form: "I physically have the pet, come get it."
// Sibling of PetSightingForm — that one is for "I saw it from afar" (no custody).
// This form captures contact, current location (L1), condition, availability, and
// an optional current photo.
//
// Name and contact are OPTIONAL (PO decision 2026-07-24): the finder can
// report anonymously — one muted line explains why leaving a contact helps.
// No prefill (PO decision 2026-07-16): even when the user is logged in, the
// finder types every field by hand. Logged-in detection remains only to render
// the "¿No sos vos? Salí de la sesión" advisory banner.

import Link from "next/link";
import { useActionState, useState } from "react";

import { logoutAndReturnAction } from "@/app/actions/auth";
import { LocationFields } from "@/components/LocationFields";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { TimeInputAr } from "@/components/ui/TimeInputAr";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { type FinderInPossessionState, reportFinderInPossessionAction } from "./action";

const initialState: FinderInPossessionState = { ok: false, error: null };

const PET_CONDITIONS: Array<{ value: string; label: string; urgent?: boolean }> = [
  { value: "bien", label: "Bien" },
  { value: "herida", label: "Herida o lastimada" },
  { value: "asustada", label: "Asustada o agitada" },
  { value: "necesita_vet_urgente", label: "Necesita veterinario urgente", urgent: true },
];

export function FinderInPossessionForm({
  publicToken,
  petName,
  biasProvince,
  biasLocality,
  loggedIn,
  sessionDisplayName,
}: {
  publicToken: string;
  petName: string;
  biasProvince: string | null;
  biasLocality: string | null;
  loggedIn?: boolean;
  /** Display name of the logged-in session, banner-only — never a form value. */
  sessionDisplayName?: string | null;
}) {
  // WHAT THE PO REPRODUCED ON A REAL PHONE, 2026-09-16. The text fields below
  // are controlled and survive React 19's post-action form reset; three things
  // on this page did not, and the measured contract
  // (`__tests__/react19-form-reset-contract.test.tsx`) says why each one is a
  // separate case rather than an oversight:
  //
  //   - "¿Cómo está la mascota?" is a REQUIRED radio group with no `checked`,
  //     so the reset cleared it outright. A finder who missed something else on
  //     the form came back to a blank answer on the one question that decides
  //     whether this is an emergency.
  //   - "Puedo tenerla indefinidamente" WAS controlled, which is not enough for
  //     a tick: React skips `defaultChecked` whenever `checked` is set, so the
  //     box fell back to its MOUNT value (unticked) while React state stayed
  //     true — the box read "no" and the hidden field still sent "yes". Making
  //     it DOM-owned with a kept default is what puts those two back together;
  //     `onChange` still drives the state the conditional block reads.
  //   - The photo is beyond any re-seed (a page may not set a file input), so
  //     the picked `File` lives in React state and is re-attached to the
  //     `FormData` when the reset emptied the posted entry — `MinimalNewPetForm`
  //     already does exactly this for its own photo.
  //
  // None of it changes what the form SENDS: a resubmit carries what the first
  // submit carried.
  const [photoNowFile, setPhotoNowFile] = useState<File | null>(null);
  // Only `keptChecked` is pulled: every text field on this form is already
  // controlled and already safe, and pairing `defaultValue` with `value` is a
  // React warning, not a belt-and-braces.
  const { boundAction: keptAction, keptChecked } = useKeptFields(
    (prev: FinderInPossessionState, formData: FormData) => {
      const posted = formData.get("photoNow");
      if (photoNowFile && (!(posted instanceof File) || posted.size === 0)) {
        formData.set("photoNow", photoNowFile);
      }
      return reportFinderInPossessionAction(publicToken, prev, formData);
    },
  );
  const [state, formAction, isPending] = useActionState(keptAction, initialState);

  // Client-side contact validation state.
  const [clientError, setClientError] = useState<string | null>(null);
  const [canKeepIndefinite, setCanKeepIndefinite] = useState(false);

  // B-2: stable id for the error paragraph so required inputs can reference it
  const errorId = "finder-possession-form-error";

  // Controlled field state — preserves typed input on validation error.
  // Always starts EMPTY (no session prefill — PO 2026-07-16).
  const [finderName, setFinderName] = useState("");
  const [finderPhone, setFinderPhone] = useState("");
  const [finderEmail, setFinderEmail] = useState("");
  const [message, setMessage] = useState("");

  // "¿Hasta cuándo podés cuidarla?" is entered as two AUTHOR-OWNED fields
  // (dd/mm/aaaa + HH:mm) instead of one `<input type="datetime-local">`, whose
  // visible text follows the BROWSER's locale — a finder on an en-US machine
  // was offered month/day order and an AM/PM clock inside es-AR copy, on a
  // citizen-facing crisis form. Same treatment PetSightingForm's "¿Cuándo la
  // viste?" already got; the halves are recomposed client-side into the exact
  // "YYYY-MM-DDTHH:mm" string the action already parses (parseArDatetimeLocal),
  // carried by a hidden `canKeepUntil`, so the action is untouched and the wire
  // format is byte-identical.
  const [canKeepUntilDate, setCanKeepUntilDate] = useState("");
  const [canKeepUntilTime, setCanKeepUntilTime] = useState("");
  // `onHiddenValueChange` (not `onValueChange`) is deliberate — it MIRRORS each
  // control's hidden value, so a half-typed or impossible entry empties its
  // half here too instead of leaving the composed field holding a stale value.
  //
  // Either half blank ⇒ empty composed value, which is exactly what an emptied
  // datetime-local submitted. The field stays OPTIONAL in the same conditional
  // sense it always was: empty is allowed only when "puedo tenerla
  // indefinidamente" is ticked, and handleSubmit below enforces that pair.
  const canKeepUntil =
    canKeepUntilDate && canKeepUntilTime ? `${canKeepUntilDate}T${canKeepUntilTime}` : "";

  /**
   * Toggling "puedo tenerla indefinidamente" UNMOUNTS the date/time block, and
   * a remount gives DateInputAr/TimeInputAr fresh (empty) internal state — but
   * THESE two states live in the parent and survived, so unticking showed two
   * blank fields while the hidden `canKeepUntil` still carried the old,
   * invisible datetime. Clearing both halves on every toggle keeps what the
   * finder SEES and what the action RECEIVES the same thing.
   */
  function handleCanKeepIndefiniteChange(checked: boolean) {
    setCanKeepIndefinite(checked);
    setCanKeepUntilDate("");
    setCanKeepUntilTime("");
  }

  if (state.ok) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] p-4 text-sm text-[var(--color-ln-ok)]">
          <p className="font-medium">¡Gracias!</p>
          <p className="mt-1 text-xs">
            Le avisamos al dueño/a con urgencia. Vas a recibir noticias pronto.
          </p>
          {state.warning && (
            <p className="mt-2 text-xs text-[var(--color-ln-warn)]">{state.warning}</p>
          )}
        </div>
        <Link
          href={`/p/${publicToken}`}
          className="block text-center text-sm font-medium text-[var(--color-ln-azul)] underline underline-offset-4"
        >
          Volver al perfil de {petName}
        </Link>
      </div>
    );
  }

  const inputClass =
    "w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]";
  const labelClass = "block text-sm font-medium text-[var(--color-ln-ink-2)]";
  const requiredMark = <span className="text-[var(--color-ln-seal)] ml-0.5">*</span>;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // Name/contact are optional (PO 2026-07-24) — only availability is checked.
    if (!canKeepIndefinite && !canKeepUntil.trim()) {
      e.preventDefault();
      setClientError(
        "Indicá hasta cuándo podés cuidarla o marcá que podés tenerla indefinidamente.",
      );
      return;
    }
    setClientError(null);
  }

  return (
    <>
      {/* Logged-in banner — rendered outside the main form: forms cannot nest,
          and the main form's onSubmit validation would block the logout submit. */}
      {loggedIn && (
        <div className="mb-5 rounded-lg border border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] px-4 py-3 text-sm text-[var(--color-ln-azul)]">
          {sessionDisplayName ? (
            <>
              Tenés una sesión iniciada como{" "}
              <span className="font-medium">{sessionDisplayName}</span>.
            </>
          ) : (
            <>Tenés una sesión iniciada.</>
          )}{" "}
          El aviso no queda vinculado a tu cuenta: el dueño solo ve lo que escribas acá.{" "}
          <form
            action={logoutAndReturnAction.bind(null, `/p/${publicToken}/encontre`)}
            className="inline"
          >
            <button
              type="submit"
              className="underline underline-offset-4 hover:opacity-80 bg-transparent border-0 p-0 text-inherit text-sm cursor-pointer"
            >
              ¿No sos vos? Salí de la sesión.
            </button>
          </form>
        </div>
      )}

      <form
        action={formAction}
        onSubmit={handleSubmit}
        className="space-y-5"
        encType="multipart/form-data"
      >
        {/* Finder name — optional (PO 2026-07-24: anonymous handoff allowed) */}
        <div className="space-y-1.5">
          <label htmlFor="finderName" className={labelClass}>
            Tu nombre{" "}
            <span className="font-normal text-[var(--color-ln-faint)] text-xs">(opcional)</span>
          </label>
          <input
            id="finderName"
            name="finderName"
            type="text"
            autoComplete="name"
            maxLength={80}
            value={finderName}
            onChange={(e) => setFinderName(e.target.value)}
            placeholder="Nombre y apellido"
            aria-describedby={(clientError ?? state.error) ? errorId : undefined}
            className={inputClass}
          />
        </div>

        {/* Contact: phone (tel) + email — both optional (PO 2026-07-24) */}
        <fieldset className="space-y-3">
          <legend className={`${labelClass} mb-1`}>
            Contacto{" "}
            <span className="font-normal text-[var(--color-ln-faint)] text-xs">(opcional)</span>
          </legend>
          <p className="text-xs text-[var(--color-ln-mute)]">
            Dejar un contacto ayuda a coordinar la entrega, pero no es obligatorio.
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor="finderPhone"
              className="block text-xs font-medium text-[var(--color-ln-mute)]"
            >
              Teléfono
            </label>
            <input
              id="finderPhone"
              name="finderPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={40}
              value={finderPhone}
              onChange={(e) => setFinderPhone(e.target.value)}
              placeholder="11-1234-5678"
              aria-describedby={(clientError ?? state.error) ? errorId : undefined}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="finderEmail"
              className="block text-xs font-medium text-[var(--color-ln-mute)]"
            >
              Email
            </label>
            <input
              id="finderEmail"
              name="finderEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={120}
              value={finderEmail}
              onChange={(e) => setFinderEmail(e.target.value)}
              placeholder="vos@ejemplo.com"
              aria-describedby={(clientError ?? state.error) ? errorId : undefined}
              className={inputClass}
            />
          </div>
        </fieldset>

        {/* Current location — exact point (L2). A finder in possession needs to
            tell the owner WHERE to pick the pet up; a pin is far more useful than
            a locality. Mirrors the sighting flow. */}
        <div className="space-y-1.5">
          <p className={labelClass}>¿Dónde la tenés ahora?{requiredMark}</p>
          <p className="text-xs text-[var(--color-ln-faint)]">
            Marcá el punto exacto en el mapa así el dueño/a sabe dónde encontrarte.
          </p>
          <LocationFields
            mode="l2"
            biasProvince={biasProvince}
            biasLocality={biasLocality}
            useMyLocationVariant="primary"
            allowAnonymous
          />
        </div>

        {/* Pet condition */}
        <fieldset className="space-y-2">
          <legend className={`${labelClass} mb-1`}>¿Cómo está la mascota?{requiredMark}</legend>
          {PET_CONDITIONS.map(({ value, label, urgent }) => (
            <label
              key={value}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer text-sm transition-colors ${
                urgent
                  ? "border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)] font-medium hover:bg-[var(--color-ln-err-100)]"
                  : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
              }`}
            >
              <input
                type="radio"
                name="petCondition"
                value={value}
                defaultChecked={keptChecked("petCondition", false, value)}
                required
                className="accent-[var(--color-ln-azul)]"
              />
              {label}
            </label>
          ))}
        </fieldset>

        {/* Availability */}
        <fieldset className="space-y-3">
          <legend className={`${labelClass} mb-1`}>
            ¿Hasta cuándo podés cuidarla?{requiredMark}
          </legend>
          <label className="flex items-center gap-2 text-sm text-[var(--color-ln-ink)] cursor-pointer">
            <input
              type="checkbox"
              name="canKeepIndefiniteToggle"
              className="accent-[var(--color-ln-azul)]"
              defaultChecked={keptChecked("canKeepIndefiniteToggle", false)}
              onChange={(e) => handleCanKeepIndefiniteChange(e.target.checked)}
            />
            <input type="hidden" name="canKeepIndefinite" value={String(canKeepIndefinite)} />
            Puedo tenerla indefinidamente
          </label>
          {!canKeepIndefinite && (
            <div className="space-y-1.5">
              <p className="block text-xs font-medium text-[var(--color-ln-mute)]">
                Hasta cuándo (fecha y hora)
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label
                    htmlFor="canKeepUntilDate"
                    className="block text-xs font-medium text-[var(--color-ln-faint)]"
                  >
                    Fecha
                  </label>
                  <DateInputAr
                    id="canKeepUntilDate"
                    name="canKeepUntilDate"
                    onHiddenValueChange={setCanKeepUntilDate}
                    ariaDescribedBy={(clientError ?? state.error) ? errorId : undefined}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="canKeepUntilTime"
                    className="block text-xs font-medium text-[var(--color-ln-faint)]"
                  >
                    Hora (24 h)
                  </label>
                  <TimeInputAr
                    id="canKeepUntilTime"
                    name="canKeepUntilTime"
                    onHiddenValueChange={setCanKeepUntilTime}
                    ariaDescribedBy={(clientError ?? state.error) ? errorId : undefined}
                    className={inputClass}
                  />
                </div>
              </div>
              {/* The single field the action reads — recomposed from the two
                  halves above into the same "YYYY-MM-DDTHH:mm" the
                  datetime-local used to submit. */}
              <input type="hidden" name="canKeepUntil" value={canKeepUntil} />
            </div>
          )}
        </fieldset>

        {/* Optional message */}
        <div className="space-y-1.5">
          <label htmlFor="message" className={labelClass}>
            Algo más que quieras decirle al dueño{" "}
            <span className="font-normal text-[var(--color-ln-faint)] text-xs">(opcional)</span>
          </label>
          <textarea
            id="message"
            name="message"
            rows={3}
            maxLength={500}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Lugar donde la encontraste, collar, comportamiento…"
            className={inputClass}
          />
        </div>

        {/* Optional current photo */}
        <details className="rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)]">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-ln-ink)]">
            ¿Le sacás una foto ahora para confirmar? (opcional)
          </summary>
          <div className="p-4 border-t border-[var(--color-ln-line)] space-y-2">
            {/* B-1: explicit label for the file input */}
            <label htmlFor="photoNow" className="sr-only">
              Foto actual de la mascota (opcional)
            </label>
            <input
              id="photoNow"
              type="file"
              name="photoNow"
              accept="image/*"
              capture="environment"
              onChange={(e) => setPhotoNowFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-[var(--color-ln-ink)]"
            />
            {/* Said out loud because the control itself cannot say it: after a
                refused submit the file input is empty again, and without this
                line the photo looks lost even though it is still going to be
                sent. */}
            {photoNowFile && (
              <p className="text-xs text-[var(--color-ln-ok)]">
                Foto lista para enviar: {photoNowFile.name}
              </p>
            )}
            <p className="text-xs text-[var(--color-ln-faint)]">
              JPG/PNG hasta 5 MB. Ayuda al dueño/a a confirmar que es su mascota.
            </p>
          </div>
        </details>

        {/* B-2: stable id so required inputs above can reference via aria-describedby */}
        {(clientError ?? state.error) && (
          <p id={errorId} className="text-xs text-[var(--color-ln-seal)]" role="alert">
            {clientError ?? state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={isPending}
          className="w-full px-4 py-3 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white text-sm font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Enviando..." : "Avisar al dueño/a"}
        </button>
      </form>
    </>
  );
}
