// The one element every live row of the owner's action panel opens through.
//
// Three ways to open, chosen by the destination and never by the caller:
//   · a `?sheet=` on this page goes through SheetTriggerLink — the History API,
//     not the router (lib/ui/sheet-nav.ts says why the router must not sit on
//     the sheets' hot path);
//   · a page of its own is a plain <Link>;
//   · a block already on this page (the lost case) is a fragment link.

import Link from "next/link";
import type { ReactNode } from "react";

import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

import type { WebPetActionLink } from "./pet-action-web";

type Props = {
  link: WebPetActionLink;
  className: string;
  /** The id of the element holding the row's hint, for a screen reader. */
  describedBy: string;
  children: ReactNode;
};

export function PetActionLink({ link, className, describedBy, children }: Props) {
  if (link.kind === "sheet") {
    return (
      <SheetTriggerLink href={link.href} className={className} aria-describedby={describedBy}>
        {children}
      </SheetTriggerLink>
    );
  }
  if (link.kind === "anchor") {
    return (
      <a href={link.href} className={className} aria-describedby={describedBy}>
        {children}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className} aria-describedby={describedBy}>
      {children}
    </Link>
  );
}

/** The id of a row's hint element. One panel per page, one row per action id. */
export function petActionHintId(id: string): string {
  return `pet-action-${id}-hint`;
}
