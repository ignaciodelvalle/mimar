// WeightSparkline — SVG-only weight trend line, extracted from
// PetWeightChart.tsx (two-face redesign, 2026-07-01, design ADR-8). No card
// chrome — meant to render inline inside a Libreta weight-event row detail.
//
// Token ratchet: the polyline/circle stroke used to be a raw hex (#0F6E56);
// this extraction converts it to var(--color-ln-ok) (design risk item).

export type WeightSample = {
  /** UTC midnight is fine — only relative position matters. */
  date: Date;
  /** Kilograms. Decimal allowed. */
  kg: number;
};

interface Props {
  samples: WeightSample[];
  /** Pixel height; width is 100%. */
  height?: number;
}

export function WeightSparkline({ samples, height = 70 }: Props) {
  if (samples.length < 2) {
    return (
      <p className="text-xs text-[var(--color-ln-mute)]">
        Cargá al menos dos pesos para ver la curva.
      </p>
    );
  }

  const sorted = [...samples].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = sorted[sorted.length - 1];
  const min = Math.min(...sorted.map((s) => s.kg));
  const max = Math.max(...sorted.map((s) => s.kg));
  const padY = Math.max((max - min) * 0.15, 0.05);
  const yMin = Math.max(0, min - padY);
  const yMax = max + padY;
  const dx = 300 / (sorted.length - 1);
  const points = sorted
    .map((s, i) => {
      const x = i * dx;
      const y = ((yMax - s.kg) / (yMax - yMin)) * (height - 20) + 10;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 300 ${height}`}
      width="100%"
      height={height}
      aria-hidden
      className="block"
      preserveAspectRatio="none"
    >
      <title>Tendencia de peso</title>
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-ln-ok)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={(sorted.length - 1) * dx}
        cy={((yMax - last.kg) / (yMax - yMin)) * (height - 20) + 10}
        r="3.5"
        fill="var(--color-ln-ok)"
      />
    </svg>
  );
}
