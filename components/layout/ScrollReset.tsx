"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Resets shell scroll containers to the top on route change.
 *
 * Next.js resets WINDOW scroll on <Link> navigation, but the AppShell
 * variants scroll inner overflow-auto containers, which nothing resets —
 * pages opened mid-scroll after navigating from a long page (QA
 * 2026-07-03). Keyed on pathname only: query/hash-only changes (sheet
 * mounters `?sheet=`, face flips `?tab=`) must NOT scroll the page.
 */
export function ScrollReset() {
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intentional trigger — the effect resets scroll on every route change without reading its value (same idiom as WizardShell).
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-reset]")) {
      el.scrollTop = 0;
    }
  }, [pathname]);

  return null;
}
