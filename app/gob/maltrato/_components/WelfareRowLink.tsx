"use client";

// WelfareRowLink — the client interaction wrapper for a denuncia row (task #12).
//
// Keeps the real `<a href="/gob/maltrato/[id]">` (right-click "open in new tab"
// and the no-JS fallback both still work), but intercepts a plain left-click to
// SELECT the row into the inspector via shallow history instead of navigating:
//   - preventDefault the anchor,
//   - selectCaso(...) writes `?caso=<id>` with native pushState/replaceState so
//     the queue Server Component never re-runs (tab + cursor + scroll survive).
//
// The row reads `?caso=` reactively to render the selected marker (left border +
// stripe fill — same visual language as the hover state). Only the interactive
// shell is a client component; the row's PII-free content is passed as children
// from the Server Component row, so no report fields cross to the browser.

import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { selectCaso } from "../_inspector/inspector-nav";

export function WelfareRowLink({
  // The PUBLIC reference code (DEN-XXXX-XXXX) — what `?caso=` carries and the row
  // is keyed by. Never the internal uuid (privacy: no raw UUID in a user URL).
  casoParam,
  href,
  children,
  className,
}: {
  casoParam: string;
  href: string;
  children: ReactNode;
  /** Extra classes merged onto the anchor — used by WelfareDenunciaRow (C6c
   * workqueue grammar) to make this link a flex sibling of the row's
   * Tomar/Actuar buttons instead of the row's sole element. */
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = searchParams.get("caso") === casoParam;

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Respect modifier/middle clicks and right-click — let the browser open the
    // full page / new tab as usual.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const currentHasCaso = params.has("caso");
    params.set("caso", casoParam);
    params.delete("mascota");
    // A plain row click always opens on "Resumen" — strip any `panel=acciones`
    // left over from a previous ActuarButton selection (C6c workqueue
    // grammar), so this generic click never inherits that shortcut.
    params.delete("panel");
    selectCaso(`${pathname}?${params.toString()}`, currentHasCaso);
  }

  return (
    <a
      href={href}
      data-caso-row={casoParam}
      aria-current={selected ? "true" : undefined}
      onClick={handleClick}
      className={`block px-4 py-3 transition ${
        selected
          ? "border-l-2 border-l-ln-op-azul bg-ln-op-stripe"
          : "border-l-2 border-l-transparent hover:bg-ln-op-stripe"
      } ${className ?? ""}`}
    >
      {children}
    </a>
  );
}
