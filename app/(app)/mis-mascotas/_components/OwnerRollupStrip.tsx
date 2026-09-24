// OwnerRollupStrip — the cross-pet "is anything on fire?" glance on the
// /mis-mascotas index (owner-ia-redesign P5, decision 3; inventory §9.1).
//
// A credential is per-pet by definition, so the swipe can never answer "is any
// of my pets overdue?" — the question /inicio's greeting + health strip used to
// answer in one line. That rollup lands HERE, above the per-pet cards: próximos
// vencimientos, pets al día over the total, and open cases. Presentational —
// the server page passes the already-computed counts (same projections the
// cards below and the profile read, so the numbers can never disagree).

import { Icon, type IconName } from "@/components/Icon";
import { capCount, pluralizeEs } from "@/lib/utils/format";

function RollupCell({
  icon,
  value,
  label,
  detail,
  tone,
}: {
  icon: IconName;
  value: string;
  label: string;
  /** Optional breakdown line under the label (D-11: vencidas vs por vencer). */
  detail?: string;
  /** Calm (nothing pending) reads muted; a non-zero count reads with emphasis. */
  tone: "calm" | "attention";
}) {
  const emphasis =
    tone === "attention" ? "text-[var(--color-ln-ink)]" : "text-[var(--color-ln-ink-2)]";
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-full ${
          tone === "attention"
            ? "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]"
            : "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]"
        }`}
      >
        <Icon name={icon} size={16} decorative />
      </span>
      <div className="min-w-0">
        <p className={`font-ln-serif text-lg font-semibold leading-none ${emphasis}`}>{value}</p>
        <p className="mt-1 font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-mute)]">
          {label}
        </p>
        {detail && <p className="mt-0.5 text-xs text-[var(--color-ln-mute)]">{detail}</p>}
      </div>
    </div>
  );
}

/**
 * D-11 (Lote D): the breakdown line under "vencimientos próximos".
 *
 * The rollup used to fold "already past its date" and "due within 60 days" into
 * one number, so two owners in opposite situations read the same figure — one in
 * breach today, one with nothing to do until next month. The per-pet landing has
 * always separated them ("Vencida" / "Por vencer", with the date); this restores
 * that rigor at the household level without adding a fourth cell to a
 * three-column strip.
 *
 * Says only what is true: with nothing overdue the line names just what is
 * coming, and vice versa. es-AR agreement throughout ("1 vencida", "2 vencidas").
 */
function vencimientosDetail(vencidas: number, porVencer: number): string | undefined {
  if (vencidas === 0 && porVencer === 0) return undefined;
  const parts: string[] = [];
  if (vencidas > 0) parts.push(`${vencidas} ${pluralizeEs(vencidas, "vencida")}`);
  if (porVencer > 0) parts.push(`${porVencer} por vencer`);
  return parts.join(" · ");
}

export function OwnerRollupStrip({
  vencidas,
  porVencer,
  alDia,
  totalPets,
  casosAbiertos,
}: {
  /** Recordatorios cuyo plazo ya pasó (splitProximosReminders). */
  vencidas: number;
  /** Recordatorios en plazo que vencen dentro del horizonte de 60 días. */
  porVencer: number;
  alDia: number;
  totalPets: number;
  casosAbiertos: number;
}) {
  const proximosVencimientos = vencidas + porVencer;
  return (
    <section
      aria-label="Resumen de tus mascotas"
      data-section="owner-rollup"
      className="mb-6 grid grid-cols-1 divide-y divide-[var(--color-ln-line-2)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      <RollupCell
        icon="reloj"
        value={capCount(proximosVencimientos)}
        label={proximosVencimientos === 1 ? "vencimiento próximo" : "vencimientos próximos"}
        detail={vencimientosDetail(vencidas, porVencer)}
        tone={proximosVencimientos > 0 ? "attention" : "calm"}
      />
      <RollupCell
        icon="check-circle"
        value={`${capCount(alDia)} / ${capCount(totalPets)}`}
        label="al día"
        tone={alDia < totalPets ? "attention" : "calm"}
      />
      <RollupCell
        icon="alerta"
        value={capCount(casosAbiertos)}
        label={casosAbiertos === 1 ? "caso abierto" : "casos abiertos"}
        tone={casosAbiertos > 0 ? "attention" : "calm"}
      />
    </section>
  );
}
