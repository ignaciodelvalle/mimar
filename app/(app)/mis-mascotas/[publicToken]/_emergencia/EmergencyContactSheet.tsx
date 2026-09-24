"use client";

// EmergencyContactSheet — hosts the vet/emergency-contact edit form inside
// the pet profile's `?sheet=emergencia` (pet-document-redesign ADR-13,
// Phase 5). Narrow write: reuses EmergencyContactFields (the same UI as the
// full /cuenta/editar form) + updateEmergencyContactsAction (scoped to just
// these 4 fields, never touches displayName/phone/avatar).

import { useState, useTransition } from "react";

import { updateEmergencyContactsAction } from "@/app/actions/profile";
import {
  EmergencyContactFields,
  type EmergencyContactValues,
} from "@/components/pet-profile/EmergencyContactFields";
import { LnButton } from "@/components/ui/Button";
import { notifySaved } from "@/lib/ui/action-feedback";

type Props = {
  petPublicToken: string;
  initialValues: EmergencyContactValues;
  onSaved?: () => void;
};

export function EmergencyContactSheet({ petPublicToken, initialValues, onSaved }: Props) {
  const [values, setValues] = useState<EmergencyContactValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleChange(field: keyof EmergencyContactValues, value: string) {
    setSaved(false);
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateEmergencyContactsAction(petPublicToken, values);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      // This sheet never navigates/reloads on save — the toast is the
      // confirmation (mutation-feedback convention, lib/ui/action-feedback.ts).
      // The inline "Guardado." output below stays too: it's the durable
      // signal for anyone who dismisses the toast before reading it.
      notifySaved("Se guardó");
      onSaved?.();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Estos datos son específicos de esta mascota. Si dejás un campo vacío, mostramos el de tu
        cuenta.
      </p>

      <EmergencyContactFields values={values} onChange={handleChange} framed={false} />

      {error && (
        <p className="text-xs text-[var(--color-ln-err)]" role="alert">
          {error}
        </p>
      )}
      {saved && !error && (
        <output className="block text-xs text-[var(--color-ln-ok)]">Guardado.</output>
      )}

      <LnButton type="submit" variant="ok" size="md" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </LnButton>
    </form>
  );
}
