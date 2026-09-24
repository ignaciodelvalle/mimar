"use client";

// Tag rows with a SINGLE open revoke panel at a time. Each RevokeTagDialog
// used to own its open state, so several rows' panels could pile up open
// simultaneously (Cowork QA v3, B3). The list owns one activeSerial instead —
// the same "one mode for everyone" pattern OrgMascotasBulkList uses.

import Link from "next/link";
import { useState } from "react";

import { LnBadge } from "@/components/ui/Badge";

import { RevokeTagDialog } from "./RevokeTagDialog";

const STATUS_LABELS: Record<string, string> = {
  unactivated: "Sin activar",
  active: "Activa",
  revoked: "Dada de baja",
};

export type TagListItem = {
  id: string;
  serial: string;
  status: string;
  petName: string | null;
  petToken: string | null;
};

export function TagList({ tags }: { tags: TagListItem[] }) {
  const [activeSerial, setActiveSerial] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
      {tags.map((tag) => (
        <div
          key={tag.id}
          className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-[var(--space-sheet)] py-3.5 last:border-b-0"
        >
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-md font-medium leading-tight text-[var(--color-ln-ink)]">
              <span className="font-ln-mono">{tag.serial}</span>
              <LnBadge
                variant={
                  tag.status === "active"
                    ? "success"
                    : tag.status === "revoked"
                      ? "neutral"
                      : "info"
                }
              >
                {STATUS_LABELS[tag.status] ?? tag.status}
              </LnBadge>
            </p>
            <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
              {tag.status === "active" && tag.petName && tag.petToken ? (
                <>
                  Vinculada a{" "}
                  <Link
                    href={`/mis-mascotas/${tag.petToken}`}
                    className="text-[var(--color-ln-azul)]"
                  >
                    {tag.petName}
                  </Link>
                </>
              ) : tag.status === "revoked" ? (
                <>Dada de baja{tag.petName ? ` — era de ${tag.petName}` : ""}</>
              ) : (
                "Sin activar"
              )}
            </p>
          </div>
          {tag.status === "active" && (
            <RevokeTagDialog
              serial={tag.serial}
              open={activeSerial === tag.serial}
              onOpenChange={(open) => setActiveSerial(open ? tag.serial : null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
