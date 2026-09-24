"use client";

// SheetTriggerLink — opens a `?sheet=` on the pet profile via the History
// API instead of a Link/router.push soft navigation (router-hot-path fix,
// see lib/ui/sheet-nav.ts for the full rationale).
//
// Renders a real <Link href> (via next/link) so right-click "copy link",
// middle-click, and ctrl/cmd/shift-click "open in new tab" keep working
// exactly like a normal anchor — only a plain left click is intercepted to
// open the sheet instantly via pushSheetUrl, with no router involved.
//
// `href` MUST target the SAME route as the page this renders on (only the
// `sheet=` search param differs) — this is only for opening SheetMounter's
// own sheets. A cross-route link (a different page entirely) should stay a
// plain <Link>.

import Link from "next/link";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

import { pushSheetUrl } from "@/lib/ui/sheet-nav";

type Props = {
  href: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">;

function isPlainLeftClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function SheetTriggerLink({ href, children, ...rest }: Props) {
  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented) return;
    if (!isPlainLeftClick(e)) return; // let the browser handle new-tab/copy-link etc.
    e.preventDefault();
    pushSheetUrl(href);
  }

  return (
    <Link href={href} prefetch={false} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
