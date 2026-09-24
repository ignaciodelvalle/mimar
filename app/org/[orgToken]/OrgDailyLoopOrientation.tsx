"use client";

// Post-onboarding transition (task #18, Lens 1). When the OrgSetupChecklist
// completes it auto-hides — and before this, nothing took its place: the
// operator went from a guided first-run straight to the ops panel with no
// "you're set up, here's your daily loop" orientation.
//
// This is that orientation: a one-time, org-type-aware "your daily loop"
// summary that points at the queues the operator should check each day. It is
// dismissable and the dismissal persists in localStorage keyed by orgToken —
// the cheapest honest option (no migration, no profile-flag write; per-browser
// is acceptable for a one-time welcome). It renders nothing until mounted (no
// hydration flash) and nothing once dismissed.

import Link from "next/link";
import { useEffect, useState } from "react";

import { OpButton } from "@/components/ui/dashboard/OpButton";

type LoopItem = { label: string; path: string; hint: string };

// Daily-loop entry points per org type — the queues that matter for that type's
// steady state. Mirrors the panel surfaces (Pendientes + KPIs + module grids).
const DAILY_LOOP: Record<string, LoopItem[]> = {
  shelter: [
    { label: "Censo y ocupación", path: "censo", hint: "Cuántos animales tenés y tu cupo." },
    { label: "Requieren acción", path: "mascotas", hint: "Vacunas vencidas, estadías largas." },
    { label: "Ingresos", path: "intake", hint: "Registrar animales que entran a custodia." },
    { label: "Adopciones", path: "adopciones", hint: "Postulaciones en evaluación." },
    { label: "Check-ins", path: "checkins", hint: "Seguimiento de adoptantes." },
  ],
  rescue_network: [
    { label: "Casos", path: "casos", hint: "Expedientes abiertos de la red." },
    {
      label: "Propuestas de tránsito",
      path: "voluntarios/propuestas",
      hint: "Respuestas de voluntarios.",
    },
    { label: "Tránsitos activos", path: "transitos", hint: "Animales en cuidado de voluntarios." },
    { label: "Adopciones", path: "adopciones", hint: "Postulaciones en evaluación." },
  ],
  clinic: [
    { label: "Agenda del día", path: "agenda", hint: "Los turnos que atendés hoy." },
    { label: "Registrar evento clínico", path: "atender", hint: "Cargar vacunas, cirugías, etc." },
    { label: "Servicios", path: "servicios", hint: "Publicar y gestionar ofrecimientos." },
  ],
  sanitary_authority: [
    { label: "Casos", path: "casos", hint: "Expedientes abiertos por la autoridad." },
    {
      label: "Maltrato derivado",
      path: "maltrato/recibidos",
      hint: "Denuncias para seguimiento en campo.",
    },
  ],
  other: [
    { label: "Casos", path: "casos", hint: "Expedientes abiertos de la organización." },
    {
      label: "Transferencias",
      path: "transferencias/recibidas",
      hint: "Custodias entrantes por aceptar.",
    },
  ],
};

function loopFor(orgType: string): LoopItem[] {
  return DAILY_LOOP[orgType] ?? DAILY_LOOP.other;
}

export function OrgDailyLoopOrientation({
  orgToken,
  orgType,
}: {
  orgToken: string;
  orgType: string;
}) {
  const storageKey = `dim:org-oriented:${orgToken}`;
  const [state, setState] = useState<"loading" | "shown" | "dismissed">("loading");

  useEffect(() => {
    try {
      setState(localStorage.getItem(storageKey) === "1" ? "dismissed" : "shown");
    } catch {
      // localStorage unavailable (private mode / SSR mismatch) — show once.
      setState("shown");
    }
  }, [storageKey]);

  if (state !== "shown") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // ignore — worst case the welcome shows again next visit.
    }
    setState("dismissed");
  };

  const items = loopFor(orgType);

  return (
    <section
      aria-label="Organización configurada"
      className="rounded-[var(--radius-md)] border border-ln-op-ok bg-ln-op-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-md font-semibold text-ln-op-ink">
            ¡Listo! Tu organización quedó configurada.
          </p>
          <p className="text-sm text-ln-op-mute">
            Esta es tu rutina diaria: lo que conviene revisar cada día. Vas a encontrar todo esto en
            el menú y en la tarjeta de Pendientes de abajo.
          </p>
        </div>
        <OpButton variant="ghost" size="sm" onClick={dismiss} className="shrink-0">
          Entendido
        </OpButton>
      </div>
      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {items.map((item) => (
          <li key={item.path}>
            <Link
              href={`/org/${orgToken}/${item.path}`}
              className="block rounded-[var(--radius-md)] border border-ln-op-line-2 p-3 hover:bg-ln-op-stripe transition-colors no-underline"
            >
              <p className="text-md font-medium text-ln-op-ink">{item.label}</p>
              <p className="text-sm text-ln-op-mute">{item.hint}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
