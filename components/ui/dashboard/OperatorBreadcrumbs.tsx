"use client";

// Dynamic breadcrumb for the gob and admin portal topbars.
// Reads the current pathname via usePathname and delegates label derivation
// to the pure deriveOperatorCrumbs function (lib/operator-breadcrumbs.ts),
// which is separately unit-testable.

import { usePathname } from "next/navigation";

import { type OperatorPortal, deriveOperatorCrumbs } from "@/lib/ui/operator-breadcrumbs";
import { OpCrumbs } from "./OpCrumbs";

type Props = {
  portal: OperatorPortal;
};

export function OperatorBreadcrumbs({ portal }: Props) {
  const pathname = usePathname();
  const crumbs = deriveOperatorCrumbs(pathname, portal);
  return <OpCrumbs items={crumbs} />;
}
