"use client";

// Assign a new locality to an active govt operator.
//
// State machine: idle → confirming → done | error
// Inline form (no modal wrapper) — designed to sit inside the govts detail page
// below the active-localities table, mirroring the RevokeLocalityRowActions pattern.
//
// Shared by the platform admin's /admin/govts/[userId] and a jurisdiction
// admin's /gob/administracion/funcionarios/[userId] (jurisdiction-admin
// Phase 6). `scopeProvince` narrows the pickers to that one province — a
// convenience, never the guard: assignGovtLocalityForAuthority resolves the
// catalogue province on the server and refuses anything outside the actor's.

import { useState, useTransition } from "react";

import { assignGovtLocalityAction } from "@/app/actions/admin-institutional";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { OpButton, OpSelect } from "@/components/ui/dashboard";
import { WHOLE_PROVINCE_SENTINEL } from "@/lib/domain/jurisdiction-canonical";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Mode = "idle" | "confirming" | "done";

type AssignedLocality = { province: string; locality: string };

export function AssignLocalityForm({
  targetUserId,
  onAssigned,
  scopeProvince,
}: {
  targetUserId: string;
  onAssigned?: (locality: AssignedLocality) => void;
  /** Offer only this province (a jurisdiction admin's own). */
  scopeProvince?: { code: string; name: string };
}) {
  const provinceOptions = scopeProvince
    ? PROVINCES.filter((p) => p.code === scopeProvince.code)
    : PROVINCES;
  const [mode, setMode] = useState<Mode>("idle");
  // provinceName is the canonical display name from ar_provincias, resolved
  // by LocalityPickerAcross when the user picks a result.
  const [provinceName, setProvinceName] = useState("");
  const [locality, setLocality] = useState("");
  // INDEC id of the picked row (C2b). The server resolves by it, so a
  // same-named locality in the same province cannot be granted in its place.
  const [indecId, setIndecId] = useState("");
  // D3 (PO 2026-08-04): any province can be assigned as a whole, not just CABA.
  // Kept as an explicit choice rather than an empty locality box, so nobody
  // grants a province-wide mandate by leaving a field blank.
  const [wholeProvince, setWholeProvince] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAssigned, setLastAssigned] = useState<AssignedLocality | null>(null);
  const [pending, startTransition] = useTransition();

  const localityTrimmed = wholeProvince ? WHOLE_PROVINCE_SENTINEL : locality.trim();
  const canSubmit =
    provinceName.length > 0 && (wholeProvince || localityTrimmed.length > 0) && !pending;

  if (mode === "done" && lastAssigned) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-ln-op-ok font-medium">
          {lastAssigned.locality === WHOLE_PROVINCE_SENTINEL
            ? `Provincia asignada: toda ${lastAssigned.province}`
            : `Localidad asignada: ${lastAssigned.locality}, ${lastAssigned.province}`}
        </p>
        <OpButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setMode("idle");
            setProvinceName("");
            setLocality("");
            setIndecId("");
            setWholeProvince(false);
            setLastAssigned(null);
          }}
        >
          Asignar otra
        </OpButton>
      </div>
    );
  }

  if (mode === "confirming") {
    return (
      <div className="rounded-[var(--radius-md)] border border-ln-op-blue-bd bg-ln-op-blue-bg p-3 space-y-3">
        <p className="text-xs uppercase tracking-wider font-bold text-ln-op-azul">
          Asignar nueva localidad
        </p>

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-ln-op-ink-2">
            <input
              type="checkbox"
              checked={wholeProvince}
              onChange={(e) => {
                setWholeProvince(e.target.checked);
                setProvinceName("");
                setLocality("");
                setIndecId("");
              }}
              className="h-4 w-4"
            />
            Toda la provincia
          </label>
          <p className="text-xs text-ln-op-mute">
            El operador ve todas las localidades de la provincia, incluidas las que se agreguen
            después.
          </p>
        </div>

        {wholeProvince ? (
          <div className="space-y-1">
            <label
              htmlFor="assign-locality-province"
              className="block text-xs uppercase tracking-wider text-ln-op-mute"
            >
              Provincia
            </label>
            <OpSelect
              id="assign-locality-province"
              value={provinceName}
              onChange={(e) => setProvinceName(e.target.value)}
              className="min-h-11 text-ln-op-ink"
            >
              <option value="">Elegí una provincia</option>
              {provinceOptions.map((p) => (
                <option key={p.code} value={p.name}>
                  {p.name}
                </option>
              ))}
            </OpSelect>
          </div>
        ) : (
          <div className="space-y-1">
            <label
              htmlFor="assign-locality-locality"
              className="block text-xs uppercase tracking-wider text-ln-op-mute"
            >
              Localidad
            </label>
            <LocalityPickerAcross
              id="assign-locality-locality"
              scopeProvinceCode={scopeProvince?.code ?? null}
              onSelect={(r) => {
                setProvinceName(r?.provinceName ?? "");
                setLocality(r?.localityName ?? "");
                setIndecId(r?.indecId ?? "");
              }}
              // Typing over a pick drops it here too, so "Confirmar asignación"
              // can never submit a locality the admin already wrote over (L3·1).
              onDeselect={() => {
                setProvinceName("");
                setLocality("");
                setIndecId("");
              }}
            />
            {provinceName && <p className="text-xs text-ln-op-mute">Provincia: {provinceName}</p>}
          </div>
        )}

        {error && <p className="text-sm text-ln-op-danger">{error}</p>}

        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            variant="primary"
            size="sm"
          >
            {pending ? "Asignando..." : "Confirmar asignación"}
          </OpButton>
          <OpButton
            type="button"
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
            disabled={pending}
            variant="ghost"
            size="sm"
          >
            Cancelar
          </OpButton>
        </div>
      </div>
    );
  }

  return (
    <OpButton type="button" onClick={() => setMode("confirming")} variant="primary" size="sm">
      Asignar nueva localidad
    </OpButton>
  );

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await assignGovtLocalityAction({
        targetUserId,
        province: provinceName,
        locality: localityTrimmed,
        localityIndecId: wholeProvince ? null : indecId || null,
      });

      if ("error" in result) {
        setError(result.error);
        return;
      }

      const assigned = { province: provinceName, locality: localityTrimmed };
      setLastAssigned(assigned);
      // Full document reload so the SSR institutional list reflects the
      // change immediately (router.refresh() is banned - see
      // lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
      setMode("done");
      onAssigned?.(assigned);
    });
  }
}
