// DiscList / DiscRow — thin progressive-disclosure primitive for the pet
// profile's front face (3b improvement B, 2026-07-12).
//
// A DiscRow is a glanceable summary (icon tile + title + one-line summary +
// optional trailing status stamp) that expands inline to reveal richer content.
// It is a styled native <details>/<summary>, so it is keyboard-operable out of
// the box (Enter/Space toggle, <summary> is focusable, chevron rotates on
// [open]) with ZERO client JS — it stays a server component.
//
// Used on the credential front face to collapse the always-expanded compliance
// grid into a single row on MOBILE, expanding to the exact same
// provenance-gated ComplianceObligationsPanel (integrity untouched — the
// disclosure only changes the presentation, never the gated content). Desktop
// renders the panel inline (see CredentialFace) and never mounts this.

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

export function DiscList({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`ln-disc-list ${className}`.trim()}>{children}</div>;
}

export function DiscRow({
  icon,
  title,
  summary,
  trailing,
  defaultOpen = false,
  children,
}: {
  /** Leading credential icon (an Icon.tsx name, e.g. "shield"). */
  icon: string;
  /** es-AR row title (e.g. "Obligaciones"). */
  title: string;
  /** es-AR one-line summary (e.g. "3 de 4 al día · falta esterilización"). */
  summary: string;
  /** Optional trailing status cue (e.g. an LnVstamp) — sits before the chevron. */
  trailing?: ReactNode;
  /** Start expanded. Default collapsed (glance-first). */
  defaultOpen?: boolean;
  /** The disclosed content revealed on expand. */
  children: ReactNode;
}) {
  return (
    <details className="op-disclosure ln-disc" open={defaultOpen}>
      <summary className="ln-disc-row">
        <span className="ln-disc-ic">
          <Icon name={icon} size="sm" decorative />
        </span>
        <span className="ln-disc-txt">
          <b>{title}</b>
          <span>{summary}</span>
        </span>
        {trailing}
        <span className="ln-disc-chev">
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div className="ln-disc-body">{children}</div>
    </details>
  );
}
