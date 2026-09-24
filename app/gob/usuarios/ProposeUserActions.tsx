"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";

import { proposeVetUpgradeAction } from "@/app/actions/admin-proposals";
import { OpButton, OpInput, OpTextarea } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

type Target = {
  id: string;
  displayName: string;
  role: "owner" | "vet" | "govt" | "admin" | "national";
};

type Mode = "idle" | "vet";

export function ProposeUserActions({
  target,
  actorRole: _actorRole,
  manageHref = null,
}: {
  target: Target;
  actorRole: "admin" | "govt";
  /** Detail page where this account is actually managed (govt/admin rows,
   *  admin portal only). When present it replaces the dead "sin acciones"
   *  notice with a link to the page that carries the real controls. */
  manageHref?: string | null;
}) {
  const [mode, setMode] = useState<Mode>("idle");

  const canProposeVet = target.role === "owner";

  if (mode === "vet") {
    return <VetProposeForm target={target} onDone={() => setMode("idle")} />;
  }

  if (!canProposeVet) {
    if (manageHref) {
      return (
        <Link
          href={manageHref}
          className="text-sm font-medium text-ln-op-azul no-underline hover:underline underline-offset-4"
        >
          Gestionar cuenta {"→"}
        </Link>
      );
    }
    return (
      <p className="text-sm text-ln-op-mute">
        Sin acciones disponibles desde tu rol para este usuario.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canProposeVet && (
        <OpButton type="button" onClick={() => setMode("vet")} variant="primary" size="sm">
          Proponer vet
        </OpButton>
      )}
    </div>
  );
}

function VetProposeForm({ target, onDone }: { target: Target; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    matriculaNumber: "",
    matriculaJurisdiccion: "",
    operationalProvince: "",
    operationalLocality: "",
    especialidad: "",
    anosExperiencia: "",
  });

  if (submitted) {
    return (
      <p className="text-sm text-ln-op-ok">
        Solicitud creada. {target.displayName} fue notificado.
      </p>
    );
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await proposeVetUpgradeAction({
        targetUserId: target.id,
        matriculaNumber: form.matriculaNumber,
        matriculaJurisdiccion: form.matriculaJurisdiccion,
        operationalProvince: form.operationalProvince,
        operationalLocality: form.operationalLocality,
        especialidad: form.especialidad || null,
        anosExperiencia: form.anosExperiencia ? Number(form.anosExperiencia) : null,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSubmitted(true);
        notifySaved("Solicitud creada");
      }
    });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line p-3 space-y-2">
      <p className="text-xs uppercase tracking-wider text-ln-op-mute">
        Proponer rol vet para {target.displayName}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field
          label="Matrícula"
          value={form.matriculaNumber}
          onChange={(v) => setForm({ ...form, matriculaNumber: v })}
        />
        <Field
          label="Jurisdicción matrícula"
          value={form.matriculaJurisdiccion}
          onChange={(v) => setForm({ ...form, matriculaJurisdiccion: v })}
        />
        <Field
          label="Provincia donde ejerce"
          value={form.operationalProvince}
          onChange={(v) => setForm({ ...form, operationalProvince: v })}
        />
        <Field
          label="Localidad"
          value={form.operationalLocality}
          onChange={(v) => setForm({ ...form, operationalLocality: v })}
        />
        <Field
          label="Especialidad (opcional)"
          value={form.especialidad}
          onChange={(v) => setForm({ ...form, especialidad: v })}
        />
        <Field
          label="Años de exp. (opcional)"
          value={form.anosExperiencia}
          onChange={(v) => setForm({ ...form, anosExperiencia: v })}
          inputMode="numeric"
        />
      </div>
      {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <OpButton type="button" onClick={submit} disabled={pending} variant="primary" size="sm">
          {pending ? "Creando..." : "Crear solicitud"}
        </OpButton>
        <OpButton type="button" onClick={onDone} variant="ghost" size="sm">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: "text" | "numeric";
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs uppercase tracking-wider text-ln-op-mute">
        {label}
      </label>
      <OpInput
        id={id}
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="xs"
      />
    </div>
  );
}

function Textarea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs uppercase tracking-wider text-ln-op-mute">
        {label}
      </label>
      <OpTextarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="xs"
      />
    </div>
  );
}
