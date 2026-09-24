"use client";

// ActivateTagForm — serial + wrapper code + owned-pet selector.
//
// Calls activateTagAction with a stable clientIdempotencyKey per mount so a
// double-submit returns the original activation instead of failing. Errors
// come back as a single generic string (uniform evidence gate — the server
// never says WHICH of serial/code/state was wrong).

import { useState, useTransition } from "react";

import { activateTagAction } from "@/app/actions/tags";
import { LnButton } from "@/components/ui/Button";
import { LnCard, LnCardBody } from "@/components/ui/Card";
import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function ActivateTagForm({
  initialSerial,
  pets,
}: {
  initialSerial: string;
  pets: Array<{ id: string; name: string }>;
}) {
  const [serial, setSerial] = useState(initialSerial);
  const [code, setCode] = useState("");
  const [petId, setPetId] = useState(pets.length === 1 ? pets[0].id : "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Stable per mount: retries reuse it so the server can dedupe.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const canSubmit = serial.trim().length > 0 && code.trim().length > 0 && petId !== "";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await activateTagAction({
        serial: serial.trim(),
        activationCode: code.trim(),
        petId,
        clientIdempotencyKey: idempotencyKey,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full document navigation — immune to the App Router silent-drop
      // defect (lint:nav tiers, 2026-07-04 handoff).
      navigateAfterActionSuccess("/cuenta/chapas");
    });
  }

  if (pets.length === 0) {
    return (
      <LnCard>
        <LnCardBody>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Para activar una chapa primero necesitás tener una mascota registrada a tu nombre.
          </p>
          <LnButton href="/mis-mascotas/nueva" size="md" className="mt-4">
            Registrar mi mascota
          </LnButton>
        </LnCardBody>
      </LnCard>
    );
  }

  return (
    <LnCard>
      <LnCardBody>
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <LnField
            label="Número de serie"
            hint="Está grabado en la chapa, con el formato TAG-XXXX-XXXX."
            required
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                aria-describedby={describedBy}
                mono
                value={serial}
                onChange={(e) => {
                  setSerial(e.target.value.toUpperCase());
                  setError(null);
                }}
                placeholder="TAG-XXXX-XXXX"
                autoComplete="off"
              />
            )}
          </LnField>

          <LnField
            label="Código de activación"
            hint="Viene impreso en el envoltorio de la chapa, no en la chapa."
            required
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                aria-describedby={describedBy}
                mono
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError(null);
                }}
                placeholder="XXXX-XXXX"
                autoComplete="off"
              />
            )}
          </LnField>

          <LnField
            label="Mascota"
            hint="La credencial que va a mostrar el QR de la chapa."
            required
          >
            {({ id, describedBy }) => (
              <LnSelect
                id={id}
                aria-describedby={describedBy}
                value={petId}
                onChange={(e) => {
                  setPetId(e.target.value);
                  setError(null);
                }}
              >
                <option value="">Elegí una mascota…</option>
                {pets.map((pet) => (
                  <option key={pet.id} value={pet.id}>
                    {pet.name}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>

          {error && (
            <p className="text-sm text-[var(--color-ln-err)]" role="alert">
              {error}
            </p>
          )}

          <div>
            <LnButton type="submit" size="lg" disabled={!canSubmit || isPending}>
              {isPending ? "Activando…" : "Activar chapa"}
            </LnButton>
          </div>
        </form>
      </LnCardBody>
    </LnCard>
  );
}
