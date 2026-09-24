// OpStateBadge — state badge for org pet pipeline states.
//
// Domain enum: published · paused · draft · adopted.
// (Distinct from CaseStatus — do NOT change color assignments here.)
//
// Thin semantic wrapper over OpStatusPill; public API is unchanged.
//
// A11y: meaning is conveyed by BOTH icon and text, not color alone (WCAG 1.4.1).
// The icon is aria-hidden; the text label (or override) is the accessible name.

import { Icon } from "@/components/Icon";

import { OpStatusPill, type StatusTone } from "./OpStatusPill";

type State = "published" | "paused" | "draft" | "adopted";

type Props = {
  state: State;
  /** Optional override label. Defaults to the state value. */
  label?: string;
};

// Icon name per state (retired unicode status glyphs → sober lucide icons):
//   published → filled dot (live)  · paused → pause  ·
//   draft → empty ring (not yet)   · adopted → star (special).
const STATE_CONFIG: Record<State, { label: string; tone: StatusTone; icon: string }> = {
  published: { label: "Publicado", tone: "st-ok", icon: "circle-dot" },
  paused: { label: "Pausado", tone: "st-warn", icon: "pausa" },
  draft: { label: "Borrador", tone: "neutral", icon: "circle" },
  adopted: { label: "Adoptado", tone: "st-info", icon: "estrella" },
};

/**
 * State badge for org pet pipeline states.
 *
 * A11y: meaning is conveyed by BOTH icon and text, not color alone (WCAG 1.4.1).
 * The icon is aria-hidden; the text label (or override) is the accessible name.
 *
 * Visually derived from .org-statebadge (redesign-a-org.css L27-31).
 * States: published · paused · draft · adopted.
 */
export function OpStateBadge({ state, label }: Props) {
  const { label: defaultLabel, tone, icon } = STATE_CONFIG[state];
  return (
    <OpStatusPill tone={tone} icon={<Icon name={icon} size={12} decorative />}>
      {label ?? defaultLabel}
    </OpStatusPill>
  );
}
