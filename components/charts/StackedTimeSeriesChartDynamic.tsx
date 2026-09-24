"use client";

// Client-side lazy wrapper for StackedTimeSeriesChart.
// next/dynamic with ssr:false must live in a "use client" module — it cannot
// be called directly from a Server Component in Next.js 15.
import dynamic from "next/dynamic";

export const StackedTimeSeriesChartDynamic = dynamic(
  () => import("./StackedTimeSeriesChart").then((m) => m.StackedTimeSeriesChart),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-80 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe animate-pulse" />
    ),
  },
);
