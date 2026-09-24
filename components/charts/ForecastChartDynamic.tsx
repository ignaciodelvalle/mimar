"use client";

// Client-side lazy wrapper for ForecastChart (Paquete J, Fase J1).
// next/dynamic with ssr:false must live in a "use client" module — it cannot
// be called directly from a Server Component in Next.js 15. Mirrors
// TimeSeriesChartDynamic so the projection card lazy-loads recharts client-side.
import dynamic from "next/dynamic";

export const ForecastChartDynamic = dynamic(
  () => import("./ForecastChart").then((m) => m.ForecastChart),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-64 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe animate-pulse" />
    ),
  },
);
