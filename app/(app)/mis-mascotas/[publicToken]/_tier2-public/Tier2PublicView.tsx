"use client";

// Shared view for the Tier 2 público temporal toggle. Rendered inside the
// merged "Compartir" sheet (MergedShareSheet, ?sheet=compartir). The old
// standalone /mostrar-libreta page that also used this now just redirects
// here (lean audit 2026-07-03).

import { AR_TIME_ZONE } from "@/lib/utils/format";
import type { Tier2Window } from "@dim/contract/input";
import Link from "next/link";

type DurationCard = {
  // FROM THE CONTRACT, so the four ids this picker can post and the four the
  // API accepts are one list. The server is lenient — `enable-tier2-public.ts:44`
  // reads `DURATION_MS[duration] ?? DAY_MS` and silently gives an unknown string
  // 24 hours — which is safe for a `<form>` that can only post one of these and
  // is not for a JSON body. `@dim/contract/input` refuses the unknown string;
  // this union is what keeps the two ends naming the same four.
  id: Tier2Window;
  title: string;
  description: string;
  enabled: boolean;
};

// Bounded windows — the default UI. A vet visit or a trip has a natural end,
// so a bounded exposure is the safe default.
const BOUNDED_CARDS: ReadonlyArray<DurationCard> = [
  {
    id: "24h",
    title: "24 horas (recomendado)",
    description: "Para una visita al vet o un viaje corto.",
    enabled: true,
  },
  {
    id: "7d",
    title: "7 días",
    description: "Tránsito, cuidador temporal, escapadas de fin de semana.",
    enabled: true,
  },
  {
    id: "30d",
    title: "30 días",
    description: "Internación, viaje largo, mudanza.",
    enabled: true,
  },
];

// Permanent exposure is the highest-risk option (medical detail on the public
// QR with no expiry), so it lives behind an "Avanzado" expander rather than
// sitting inline as a peer of the bounded windows (lean audit 2026-07-03).
// Still fully available — chronic-condition pets are a real use case — and
// revoke stays instant.
const PERMANENT_CARD: DurationCard = {
  id: "siempre",
  title: "Siempre visible",
  description: "Útil para mascotas con condiciones crónicas. Podés revertirlo cuando quieras.",
  enabled: true,
};

type Props = {
  petPublicToken: string;
  petName: string;
  isActive: boolean;
  /** True when the permanent "siempre" option is active (no expiry). */
  isPermanent: boolean;
  /** The bounded window expiry. Null when inactive or when isPermanent is true. */
  activeUntil: Date | null;
  enableAction: (formData: FormData) => Promise<void>;
  revokeAction: () => Promise<void>;
};

export function Tier2PublicView({
  petPublicToken,
  isActive,
  isPermanent,
  activeUntil,
  enableAction,
  revokeAction,
}: Props) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Habilitá temporalmente el Tier 2 de la credencial pública —{" "}
        <strong>sólo la información médicamente relevante</strong>.
      </p>

      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-4 text-xs leading-relaxed text-[var(--color-ln-ink-2)]">
        Al escanear el QR de la chapita, hoy se ve solo identidad básica (Tier 0). Con esta acción,
        durante el lapso elegido se muestra también vacunas vigentes, antiparasitario reciente,
        esterilización, condiciones permanentes y medicación activa.{" "}
        <strong className="text-[var(--color-ln-ink)]">
          No se expone tu contacto, dirección, DNI ni notas privadas.
        </strong>
      </div>

      {isActive ? (
        <ActiveStatusCard
          until={isPermanent ? null : activeUntil}
          petPublicToken={petPublicToken}
          revokeAction={revokeAction}
        />
      ) : (
        <EnableForm enableAction={enableAction} />
      )}
    </div>
  );
}

function DurationOption({ card, defaultChecked }: { card: DurationCard; defaultChecked: boolean }) {
  return (
    <label
      className={`flex items-start gap-3 rounded-[var(--radius-sm)] border px-4 py-3 ${
        card.enabled
          ? "cursor-pointer border-[var(--color-ln-line-strong)] has-[:checked]:border-[var(--color-ln-ok)] has-[:checked]:bg-[var(--color-ln-ok-050)]"
          : "border-dashed border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] opacity-60 cursor-not-allowed"
      }`}
      title={card.enabled ? undefined : "Próximamente"}
    >
      <input
        type="radio"
        name="duration"
        value={card.id}
        defaultChecked={defaultChecked}
        disabled={!card.enabled}
        className="mt-0.5 h-4 w-4"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-ln-ink)]">{card.title}</span>
          {!card.enabled && (
            <span className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-mute)] px-1.5 py-0.5 rounded-full border border-[var(--color-ln-line-strong)]">
              Próximamente
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--color-ln-ink-2)]">{card.description}</p>
      </div>
    </label>
  );
}

function EnableForm({ enableAction }: { enableAction: (formData: FormData) => Promise<void> }) {
  return (
    <form action={enableAction} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-mute)] mb-1.5">
          Duración
        </legend>
        {BOUNDED_CARDS.map((card, idx) => (
          <DurationOption key={card.id} card={card} defaultChecked={idx === 0} />
        ))}

        {/* Permanent exposure behind an expander — off the default path
            (lean audit 2026-07-03). The radio still shares name="duration",
            so a bounded default stays selected until the user opens this and
            picks "Siempre visible". */}
        <details className="group">
          <summary className="cursor-pointer list-none py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-ln-mute)] [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="mr-1 inline-block transition-transform group-open:rotate-90"
            >
              ▸
            </span>
            Avanzado
          </summary>
          <div className="mt-2">
            <DurationOption card={PERMANENT_CARD} defaultChecked={false} />
          </div>
        </details>
      </fieldset>

      <button
        type="submit"
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] hover:opacity-90 text-white font-medium"
      >
        Habilitar Tier 2
      </button>

      <p className="text-xs text-[var(--color-ln-mute)] text-center">
        Vas a poder revocarlo en cualquier momento desde acá.
      </p>
    </form>
  );
}

function ActiveStatusCard({
  until,
  petPublicToken,
  revokeAction,
}: {
  /** Bounded window expiry. Null when permanent ("siempre" option). */
  until: Date | null;
  petPublicToken: string;
  revokeAction: () => Promise<void>;
}) {
  const fmt = until
    ? until.toLocaleString("es-AR", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: AR_TIME_ZONE,
      })
    : null;
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-4 space-y-3">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-ok)]">
          Tier 2 activo
        </p>
        {fmt ? (
          <p className="text-sm font-medium text-[var(--color-ln-ink)]">
            Hasta el <strong>{fmt}</strong>
          </p>
        ) : (
          <p className="text-sm font-medium text-[var(--color-ln-ink)]">
            <strong>Siempre visible</strong> — Activo de forma permanente
          </p>
        )}
        <p className="text-xs text-[var(--color-ln-ink-2)]">
          Quien escanee el QR ve identidad básica + vacunas vigentes, antiparasitario reciente,
          esterilización, condiciones permanentes y medicación activa.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <Link
          href={`/p/${petPublicToken}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 text-center px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-ok)] text-[var(--color-ln-ok)] text-sm font-medium hover:bg-[var(--color-ln-ok-050)]"
        >
          Ver la credencial pública →
        </Link>
        <form action={revokeAction} className="flex-1">
          <button
            type="submit"
            className="w-full px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white text-sm font-medium hover:bg-[var(--color-ln-azul-700)]"
          >
            Revocar ahora
          </button>
        </form>
      </div>
    </div>
  );
}
