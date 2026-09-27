"use client";

// The authority-unit editor's forms (localidades-por-id C4), shared by the
// platform admin's /admin/localidades and a jurisdiction admin's
// /gob/administracion/unidades (jurisdiction-admin Phase 6). `basePath` is the
// portal's unit list; every writer behind these actions re-derives the unit's
// province and re-checks the actor's authority inside its own transaction, so
// the portal a form renders in grants nothing.
//
// Every membership change asks for a reason: it decides which authority sees
// a locality's history, and the reason is what the unit's change log shows
// next to who and when. After a success the page reloads as a full document
// navigation (navigateAfterActionSuccess) — never router.refresh, which the
// App Router can silently drop (lint:nav).

import { useState, useTransition } from "react";

import {
  closeRemovedLocalityMembershipAction,
  confirmAuthorityUnitAction,
  createAuthorityUnitAction,
  moveLocalityToUnitAction,
  removeLocalityFromUnitAction,
  renameAuthorityUnitAction,
} from "@/app/actions/authority-units";
import {
  OpButton,
  OpField,
  OpFormAlert,
  OpInput,
  OpSelect,
  OpTextarea,
} from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import { unitEditErrorMessage } from "./unit-edit-errors";

type ActionResult =
  | { ok: true }
  | { ok: true; noOp: boolean }
  | { ok: true; unitId: string }
  | { error: string };

export function useUnitAction() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult>, onSuccessUrl: (r: ActionResult) => string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        setError(unitEditErrorMessage(result.error));
        return;
      }
      navigateAfterActionSuccess(onSuccessUrl(result));
    });
  }
  return { error, pending, run };
}

/** Where the platform admin's unit editor lives; the default `basePath`. */
export const ADMIN_UNITS_BASE = "/admin/localidades";

export type LocalityOption = {
  id: string;
  label: string;
  /** Holders of this unit's grants: they gain the locality (verify S4). */
  gaining: string[];
  /** Holders of its current unit at this level: they lose it. */
  losing: string[];
};

/** Whom the move reaches, shown before it is made. */
export function MoveReachNotice({ option }: { option: LocalityOption }) {
  if (option.gaining.length === 0 && option.losing.length === 0) {
    return (
      <p className="text-sm text-ln-op-mute">
        Ninguna concesión de gobierno cambia de alcance con este movimiento.
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-2 text-sm">
      <p className="font-medium text-ln-op-ink">A quiénes alcanza este cambio</p>
      {option.gaining.length > 0 && (
        <p className="text-ln-op-ink-2">Pasan a ver esta localidad: {option.gaining.join(", ")}.</p>
      )}
      {option.losing.length > 0 && (
        <p className="text-ln-op-ink-2">Dejan de verla: {option.losing.join(", ")}.</p>
      )}
    </div>
  );
}

/** Place a locality of the province in this unit (closing its previous one). */
export function MoveLocalityForm({
  unitId,
  options,
  levelLabel,
  basePath = ADMIN_UNITS_BASE,
}: {
  unitId: string;
  options: LocalityOption[];
  levelLabel: string;
  basePath?: string;
}) {
  const [localityId, setLocalityId] = useState("");
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();
  const canSubmit = localityId !== "" && reason.trim() !== "" && !pending;
  const selected = options.find((o) => o.id === localityId);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => moveLocalityToUnitAction({ localityId, toUnitId: unitId, reason }),
          () => `${basePath}/${unitId}`,
        );
      }}
    >
      <OpField
        label="Localidad"
        hint={`Si ya está en otra unidad ${levelLabel}, deja esa unidad y pasa a esta.`}
      >
        {({ id, describedBy }) => (
          <OpSelect
            id={id}
            aria-describedby={describedBy}
            value={localityId}
            onChange={(e) => setLocalityId(e.target.value)}
          >
            <option value="">Elegí una localidad…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </OpSelect>
        )}
      </OpField>
      {selected && <MoveReachNotice option={selected} />}
      <OpField label="Motivo" required>
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" disabled={!canSubmit} loading={pending}>
        Sumar a esta unidad
      </OpButton>
    </form>
  );
}

/** Close a regional or submunicipal (CABA comuna) membership; see manage-units.ts. */
export function RemoveMemberForm({
  unitId,
  localityId,
  localityName,
  basePath = ADMIN_UNITS_BASE,
}: {
  unitId: string;
  localityId: string;
  localityName: string;
  basePath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();

  if (!open) {
    return (
      <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Quitar
      </OpButton>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() === "" || pending) return;
        run(
          () => removeLocalityFromUnitAction({ unitId, localityId, reason }),
          () => `${basePath}/${unitId}`,
        );
      }}
    >
      <OpField label={`Motivo para quitar ${localityName}`} required>
        {({ id }) => (
          <OpInput
            id={id}
            size="sm"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton
          type="submit"
          variant="danger"
          size="sm"
          disabled={reason.trim() === "" || pending}
          loading={pending}
        >
          Quitar de la unidad
        </OpButton>
        <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}

/**
 * E3: close the membership of a locality the INDEC import removed. A reason
 * is required; the close is audited and never happens on its own.
 */
export function CloseRemovedMembershipForm({
  unitId,
  localityId,
  localityName,
}: {
  unitId: string;
  localityId: string;
  localityName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();

  if (!open) {
    return (
      <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Cerrar pertenencia
      </OpButton>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() === "" || pending) return;
        run(
          () => closeRemovedLocalityMembershipAction({ unitId, localityId, reason }),
          () => "/admin/localidades",
        );
      }}
    >
      <OpField label={`Motivo para cerrar la pertenencia de ${localityName}`} required>
        {({ id }) => (
          <OpInput
            id={id}
            size="sm"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton
          type="submit"
          variant="danger"
          size="sm"
          disabled={reason.trim() === "" || pending}
          loading={pending}
        >
          Cerrar pertenencia
        </OpButton>
        <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}

export function RenameUnitForm({
  unitId,
  name,
  basePath = ADMIN_UNITS_BASE,
}: {
  unitId: string;
  name: string;
  basePath?: string;
}) {
  const [value, setValue] = useState(name);
  const { error, pending, run } = useUnitAction();
  const canSubmit = value.trim() !== "" && value.trim() !== name && !pending;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => renameAuthorityUnitAction({ unitId, name: value }),
          () => `${basePath}/${unitId}`,
        );
      }}
    >
      <OpField label="Nombre de la unidad">
        {({ id }) => (
          <OpInput
            id={id}
            maxLength={200}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" variant="ghost" disabled={!canSubmit} loading={pending}>
        Renombrar
      </OpButton>
    </form>
  );
}

export function ConfirmUnitButton({
  unitId,
  basePath = ADMIN_UNITS_BASE,
}: {
  unitId: string;
  basePath?: string;
}) {
  const { error, pending, run } = useUnitAction();
  return (
    <div className="space-y-2">
      <OpButton
        type="button"
        variant="ok"
        loading={pending}
        onClick={() =>
          run(
            () => confirmAuthorityUnitAction({ unitId }),
            () => `${basePath}/${unitId}`,
          )
        }
      >
        Confirmar con la autoridad
      </OpButton>
      {error && <OpFormAlert>{error}</OpFormAlert>}
    </div>
  );
}

const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "municipio", label: "Municipio" },
  { value: "region", label: "Región (agrupa varios municipios)" },
  { value: "ciudad", label: "Ciudad" },
  { value: "comuna", label: "Comuna" },
  { value: "departamento", label: "Departamento" },
];

export function CreateUnitForm({
  provinceCode,
  basePath = ADMIN_UNITS_BASE,
}: {
  provinceCode: string;
  basePath?: string;
}) {
  const [kind, setKind] = useState("municipio");
  const [name, setName] = useState("");
  const { error, pending, run } = useUnitAction();
  const canSubmit = name.trim() !== "" && !pending;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => createAuthorityUnitAction({ kind, provinceCode, name }),
          (r) => ("unitId" in r ? `${basePath}/${r.unitId}` : basePath),
        );
      }}
    >
      <OpField label="Tipo">
        {({ id }) => (
          <OpSelect id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </OpSelect>
        )}
      </OpField>
      <OpField label="Nombre" required>
        {({ id }) => (
          <OpInput id={id} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" disabled={!canSubmit} loading={pending}>
        Crear unidad
      </OpButton>
    </form>
  );
}
