import Link from "next/link";

import type { PublicProfileCopy } from "./profile-copy";

// "Estás viendo el perfil público" banner (handoff P2-11 + D5).
//
// Surfaces only to admin/coordinator members of THIS org. Top-of-page
// strip with a quick link to /org/[orgToken] (the operational portal).
// Volunteers / fosters / non-members / anon never see it — visibility
// gating happens in the parent page.

interface Props {
  orgToken: string;
  /** Per org type — see ./profile-copy (a clinic is not "tu refugio"). */
  copy: PublicProfileCopy["adminBanner"];
}

export function AdminBanner({ orgToken, copy }: Props) {
  return (
    <div
      aria-label={copy.label}
      className="bg-[var(--color-ln-celeste-050)] border-b border-[var(--color-ln-celeste-100)] px-4 py-2 text-sm text-[var(--color-ln-ink)]"
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
        <span>{copy.text}</span>
        <Link
          href={`/org/${orgToken}`}
          className="font-medium text-[var(--color-ln-azul)] hover:underline shrink-0"
        >
          {copy.portalLink}
        </Link>
      </div>
    </div>
  );
}
