// Shared active-route matcher for citizen navigation surfaces.
// Extracted from AppCitizenMasthead so the masthead (top nav + drawer) and
// CitizenTabBar (mobile bottom tabs) highlight the same item for the same
// pathname — one matching rule, no drift between the two chromes.

import type { NavItem } from "@/components/layout/HeaderNav";

export function isNavItemActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  const prefixes = item.matchPrefixes ?? (item.matchPrefix ? [item.matchPrefix] : []);
  if (prefixes.length > 0) {
    return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  }
  return pathname === item.href;
}
