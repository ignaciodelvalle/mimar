"use client";

// GlossaryTerm — renders an operator-jargon term (an acronym like "ENO") with a
// subtle dotted underline and its plain-es-AR definition one hover/focus away,
// via the shared HoverTip primitive (red-team-admin-2 P2.5). A term with no
// glossary entry renders plainly (no underline, no tip) so an unknown term never
// signals a definition that isn't there.

import type { ReactNode } from "react";

import { HoverTip } from "@/components/ui/HoverTip";
import { lookupGlossary } from "@/lib/reference/glossary";

export function GlossaryTerm({
  term,
  children,
  className,
}: {
  /** The term to look up (also the fallback visible text). */
  term: string;
  /** Optional visible label if it differs from `term` (e.g. "SLA ENO"). */
  children?: ReactNode;
  className?: string;
}) {
  const definition = lookupGlossary(term);
  const label = children ?? term;
  if (!definition) return <>{label}</>;

  return (
    <HoverTip content={definition} className={className} width="w-72">
      <span className="cursor-help border-b border-dotted border-ln-op-line">{label}</span>
    </HoverTip>
  );
}
