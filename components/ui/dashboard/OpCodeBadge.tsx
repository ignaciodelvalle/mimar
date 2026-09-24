import type { ReactNode } from "react";

type Tone = "danger" | "warn" | "blue" | "viol" | "ok" | "neutral";

type Props = {
  tone: Tone;
  children: ReactNode;
};

// Mirrors .gob-codebadge[data-tone="..."] from the handoff.
const toneClasses: Record<Tone, string> = {
  danger: "bg-ln-op-danger-bg text-ln-op-danger border-ln-op-danger-bd",
  warn: "bg-ln-op-warn-bg text-ln-op-warn border-ln-op-warn-bd",
  blue: "bg-ln-op-blue-bg text-ln-op-azul border-ln-op-blue-bd",
  viol: "bg-ln-op-viol-bg text-ln-op-viol border-ln-op-viol-bd",
  ok: "bg-ln-op-ok-bg text-ln-op-ok border-ln-op-ok-bd",
  neutral: "bg-ln-op-stripe text-ln-op-ink-2 border-ln-op-line",
};

/**
 * Mono-spaced bordered badge for codes, tokens, and identifiers.
 * Mimics .gob-codebadge from the handoff.
 */
export function OpCodeBadge({ tone, children }: Props) {
  return (
    <span
      className={[
        "inline-flex w-fit items-center gap-[5px] rounded-[var(--radius-op-chip)] border",
        "px-2 py-0.5",
        "font-ln-mono text-sm font-bold",
        toneClasses[tone],
      ].join(" ")}
    >
      {children}
    </span>
  );
}
