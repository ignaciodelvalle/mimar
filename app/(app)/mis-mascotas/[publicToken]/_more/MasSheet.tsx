"use client";

// MasSheet — "⋯ Más" sheet (design ADR-7). Groups everything that used to be
// standalone Resumen sections or a full PetActionsMenu list into one sheet:
// Editar datos y ficha · Transferir · Buscar hogar · Perro de asistencia ·
// Confirmar devolución (conditional) · Contactos. (Ficha merged into Editar
// and travel-docs removed — flow audit 2026-07-03; see MasSheet.helpers.ts.)

import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";
import Link from "next/link";
import { type MasSheetInput, deriveMasSheetItems } from "./MasSheet.helpers";

// Items whose href is a `?sheet=` shorthand target the SAME route (this
// page) — those open via SheetTriggerLink (History API, no router hot
// path). Every other item navigates to a genuinely different route (a full
// page) and stays a plain <Link> — see lib/ui/sheet-nav.ts.
function isSameRouteSheetHref(href: string): boolean {
  return href.includes("?sheet=");
}

export function MasSheet(props: MasSheetInput) {
  const items = deriveMasSheetItems(props);

  if (items.length === 0) {
    return <p className="text-sm text-[var(--color-ln-mute)]">No hay más acciones disponibles.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) =>
        item.disabled ? (
          <li key={item.id}>
            <div
              aria-disabled="true"
              className="flex min-h-11 w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3 text-sm font-medium text-[var(--color-ln-mute)] opacity-60"
            >
              {item.label}
              {item.badge && (
                <span className="shrink-0 font-ln-mono text-xs uppercase tracking-[.04em]">
                  {item.badge}
                </span>
              )}
            </div>
          </li>
        ) : (
          <li key={item.id}>
            {isSameRouteSheetHref(item.href) ? (
              <SheetTriggerLink
                href={item.href}
                className="flex min-h-11 w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3 text-sm font-medium text-[var(--color-ln-ink-2)] no-underline transition-colors hover:bg-[var(--color-ln-stripe)]"
              >
                {item.label}
                <span aria-hidden className="shrink-0 text-xs opacity-60">
                  →
                </span>
              </SheetTriggerLink>
            ) : (
              <Link
                href={item.href}
                className="flex min-h-11 w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3 text-sm font-medium text-[var(--color-ln-ink-2)] no-underline transition-colors hover:bg-[var(--color-ln-stripe)]"
              >
                {item.label}
                <span aria-hidden className="shrink-0 text-xs opacity-60">
                  →
                </span>
              </Link>
            )}
          </li>
        ),
      )}
    </ul>
  );
}
