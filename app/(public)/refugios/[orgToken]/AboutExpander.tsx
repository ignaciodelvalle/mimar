"use client";

import { useState } from "react";

// Client island for the "Ver más" toggle on AboutPanel (handoff P2-3).
// Server component renders this only when the description exceeds the
// truncation budget — keeps the page mostly server-rendered.

interface Props {
  text: string;
  truncateAt: number;
}

export function AboutExpander({ text, truncateAt }: Props) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? text : `${text.slice(0, truncateAt).trimEnd()}…`;

  return (
    <>
      <p className="text-sm text-[var(--color-ln-ink-2)] whitespace-pre-line leading-relaxed">
        {shown}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="mt-2 text-sm font-medium text-[var(--color-ln-azul)] hover:underline focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] focus-visible:ring-offset-2 rounded"
      >
        {expanded ? "Ver menos" : "Ver más"}
      </button>
    </>
  );
}
