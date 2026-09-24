"use client";

import { useState, useTransition } from "react";

import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { speciesLabel } from "@/lib/utils/format";
import { proposeFosterAction } from "@/src/modules/foster/actions";

type Row = {
  userId: string;
  displayName: string;
  availableSlots: number;
  acceptedCount: number;
  matchScore: number | null;
  matchWarnings: string[];
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

type OrgPet = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
};

export function VolunteerRow({
  row,
  orgToken,
  orgPets,
  preselectedPetToken,
}: {
  row: Row;
  orgToken: string;
  orgPets: OrgPet[];
  preselectedPetToken: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [petToken, setPetToken] = useState(preselectedPetToken ?? orgPets[0]?.publicToken ?? "");
  const [durationWeeks, setDurationWeeks] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  function propose() {
    setError(null);
    if (!petToken) {
      setError("Elegí una mascota.");
      return;
    }
    startTransition(async () => {
      const result = await proposeFosterAction({
        orgToken,
        volunteerUserId: row.userId,
        petPublicToken: petToken,
        proposedDurationWeeks: durationWeeks.trim()
          ? Math.max(1, Number.parseInt(durationWeeks, 10) || 0)
          : null,
        proposedNotes: notes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage(`Propuesta enviada (${result.proposalPublicToken}).`);
      // Full document reload so the volunteer's SSR slot count reflects the
      // new pending proposal (router.refresh() is banned — see
      // lib/ui/full-page-action-nav.ts).
      //
      // The reload also WIPES the okMessage set one line above, which is why
      // sending a proposal used to leave no trace on screen (A-3-a). Carry the
      // receipt in the URL so it survives the trip and the page can render it.
      const back = new URL(window.location.href);
      back.searchParams.set("propuesta", result.proposalPublicToken);
      navigateAfterActionSuccess(back.toString());
    });
  }

  return (
    <li className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="space-y-1">
          <p className="text-md font-medium text-ln-op-ink">{row.displayName}</p>
          <p className="text-sm text-ln-op-mute space-x-2">
            <span>{row.availableSlots} slot(s)</span>
            <span>·</span>
            <span>{row.acceptedCount} aceptadas</span>
            {(row.jurisdictionProvince || row.jurisdictionLocality) && (
              <>
                <span>·</span>
                <span>
                  {row.jurisdictionLocality}
                  {row.jurisdictionLocality && row.jurisdictionProvince ? ", " : ""}
                  {row.jurisdictionProvince}
                </span>
              </>
            )}
            {row.matchScore != null && (
              <>
                <span>·</span>
                <span className="text-ln-op-mute">match {row.matchScore}/100</span>
              </>
            )}
          </p>
          {row.matchWarnings.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm text-ln-op-warn">
              {row.matchWarnings.map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          )}
        </div>
        {!open && (
          <OpButton
            variant="primary"
            size="sm"
            className="whitespace-nowrap"
            onClick={() => setOpen(true)}
            disabled={orgPets.length === 0}
          >
            Proponer tránsito
          </OpButton>
        )}
      </div>

      {open && !okMessage && (
        <div className="border-t border-ln-op-line pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor={`propose-pet-${row.userId}`}
                className="mb-1 block text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
              >
                Mascota
              </label>
              <OpSelect
                id={`propose-pet-${row.userId}`}
                value={petToken}
                onChange={(e) => setPetToken(e.target.value)}
                size="sm"
              >
                {orgPets.map((p) => (
                  <option key={p.id} value={p.publicToken}>
                    {p.name} ({speciesLabel(p.species)})
                  </option>
                ))}
              </OpSelect>
            </div>
            <div>
              <label
                htmlFor={`propose-duration-${row.userId}`}
                className="mb-1 block text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
              >
                Duración (semanas)
              </label>
              <OpInput
                id={`propose-duration-${row.userId}`}
                type="number"
                min={1}
                value={durationWeeks}
                onChange={(e) => setDurationWeeks(e.target.value)}
                placeholder="Opcional"
                size="sm"
              />
            </div>
          </div>
          <OpTextarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Notas para el voluntario (opcional)"
            size="sm"
          />
          {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
          <div className="flex gap-2">
            <OpButton variant="ok" size="sm" onClick={propose} disabled={pending}>
              {pending ? "Enviando..." : "Enviar propuesta"}
            </OpButton>
            <OpButton variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </OpButton>
          </div>
        </div>
      )}

      {okMessage && <output className="block text-sm text-ln-op-ok">{okMessage}</output>}
    </li>
  );
}
