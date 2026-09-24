"use client";

// 2026-09-04: brand mark now matches AppShellDrawer's paper-tile recipe (no
// more typographic text monogram), plus that day's close-button, overscroll,
// and min-w-0 accessibility fixes.

import { Icon } from "@/components/Icon";
import type { NavItem } from "@/components/layout/HeaderNav";
import { BRANDING } from "@/lib/ui/branding";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { OpHelpLink } from "./OpHelpLink";
import type { NavSection } from "./OpRailNav";

type Props = {
  /** Flat nav list. */
  nav?: NavItem[];
  /** Multi-section nav. Takes precedence over `nav`. */
  sections?: NavSection[];
  /** Visual variant. */
  variant?: "gob" | "org";
  /** Brand subtitle. */
  brandSubtitle?: string;
};

function isActive(item: NavItem, pathname: string | null): boolean {
  // Deferred entries are never "active" — their #defer-… sentinel must never be
  // highlighted (D4). Mirrors OpRailNav.
  if (item.deferred) return false;
  if (!pathname) return false;
  if (item.matchPrefix) return pathname.startsWith(item.matchPrefix);
  return pathname === item.href;
}

export function OpMobileDrawer({
  nav,
  sections,
  variant = "gob",
  brandSubtitle = "Operador",
}: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close on navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setOpen is React-stable
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const railBg = variant === "org" ? "bg-[var(--color-ln-tl-rail)]" : "bg-ln-op-navy";

  // Normalize sections
  const resolved: NavSection[] = sections ?? (nav ? [{ label: "", items: nav }] : []);

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="left">
      <Drawer.Trigger asChild>
        <button
          type="button"
          aria-label="Abrir menú"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-ln-op-line text-ln-op-ink hover:border-ln-op-line-2 md:hidden"
        >
          <Icon name="menu" size="md" decorative />
        </button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
        <Drawer.Content
          className={[
            "fixed bottom-0 left-0 top-0 z-50 flex w-[224px] flex-col shadow-xl outline-none md:hidden",
            railBg,
            "text-ln-op-rail-text",
          ].join(" ")}
        >
          {/* Radix's DialogPrimitive.Content (vaul's Drawer.Content wraps it)
              requires a DialogTitle descendant — vaul's Drawer.Title IS that
              Title — or it dev-warns "DialogContent requires a DialogTitle"
              even though the brand header below already shows "miMAR" as
              real text. Visually hidden for that reason; no id/aria override
              here (mirrors components/ui/VaulSheet.tsx) because Radix
              auto-wires aria-labelledby to its own generated titleId and only
              resolves it when Drawer.Title renders undisturbed — an explicit
              aria-label on Content does not satisfy the same dev check. */}
          <Drawer.Title className="sr-only">Menú principal</Drawer.Title>
          {/* Brand header */}
          <div className="flex items-center gap-2.5 border-b border-[rgba(255,255,255,0.10)] px-4 py-4 pb-[13px]">
            <div className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] bg-[var(--color-ln-paper)]">
              <img src="/logo-mimar-mark.svg" alt="" width={25} height={25} />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-ln-serif text-base font-semibold text-white">
                {BRANDING.appName}
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-ln-op-rail-mute">
                {brandSubtitle}
              </span>
            </div>
            <Drawer.Close asChild>
              <button
                type="button"
                aria-label="Cerrar menú"
                className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ln-op-rail-mute hover:bg-[rgba(255,255,255,0.08)]"
              >
                <Icon name="close" size="sm" decorative />
              </button>
            </Drawer.Close>
          </div>

          {/* Nav sections */}
          <nav
            aria-label="Navegación principal"
            className="op-scroll flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-[9px] py-[13px]"
          >
            {resolved.map((section) => {
              const sectionItems = (
                <div className="flex flex-col gap-0.5">
                  {section.items.map((item) => {
                    // Deferred destination: non-interactive muted "Próximamente"
                    // affordance — the drawer mirrors the rail EXACTLY (same markup,
                    // same tokens, D3). A <span> (no <Link>), aria-disabled, out of
                    // the tab order, no badge.
                    if (item.deferred) {
                      return (
                        <span
                          key={item.href}
                          aria-disabled="true"
                          className={[
                            "flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-[9px] py-2",
                            "text-md -ml-0.5 border-l-2 border-transparent",
                            "text-ln-op-rail-mute cursor-not-allowed select-none",
                          ].join(" ")}
                        >
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-[rgba(255,255,255,0.18)] px-1.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-ln-op-rail-mute">
                            Próximamente
                          </span>
                        </span>
                      );
                    }

                    const active = isActive(item, pathname);
                    const activeClasses =
                      variant === "org"
                        ? "border-l-2 border-[var(--color-ln-tl-accent)] bg-[rgba(255,255,255,0.12)] text-white font-semibold"
                        : "border-l-2 border-white bg-[rgba(255,255,255,0.12)] text-white font-semibold";

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        // RESILIENCE (2026-07-10, PO finding #1): mirror the rail
                        // — no RSC prefetch of the heavy operator dashboards, so
                        // the drawer never joins the self-saturation storm.
                        prefetch={false}
                        aria-current={active ? "page" : undefined}
                        className={[
                          "flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-[9px] py-2",
                          "text-md no-underline transition-colors -ml-0.5",
                          active
                            ? activeClasses
                            : "border-l-2 border-transparent text-ln-op-rail-text hover:bg-[rgba(255,255,255,0.05)]",
                        ].join(" ")}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.badge != null && item.badge > 0 && (
                          <span className="font-ln-mono inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-[rgba(255,255,255,0.08)] px-1.5 py-0.5 text-xs font-bold leading-none text-white">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              );

              if (section.collapsible) {
                // Mirror OpRailNav EXACTLY (D3): native <details>, collapsed by
                // default, forced open when it holds the active route.
                const containsActive = section.items.some((item) => isActive(item, pathname));
                return (
                  <details
                    key={section.label}
                    className="op-disclosure group"
                    open={containsActive || undefined}
                  >
                    <summary
                      className={[
                        "flex min-h-11 cursor-pointer select-none list-none items-center justify-between",
                        "rounded-[var(--radius-sm)] px-2 py-2 text-xs font-semibold uppercase tracking-[0.18em]",
                        "text-ln-op-rail-mute hover:bg-[rgba(255,255,255,0.05)]",
                        "[&::-webkit-details-marker]:hidden",
                      ].join(" ")}
                    >
                      {section.label}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 12 12"
                        className="h-3 w-3 transition-transform group-open:rotate-180"
                      >
                        <path
                          d="M2.5 4.25 6 7.75l3.5-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </summary>
                    {sectionItems}
                  </details>
                );
              }

              return (
                <div key={section.label} className="flex flex-col">
                  {section.label && (
                    <div className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-ln-op-rail-mute">
                      {section.label}
                    </div>
                  )}
                  {sectionItems}
                </div>
              );
            })}
          </nav>
          {/* Same channel as the desktop rail (pilot T1-P5). */}
          <OpHelpLink />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
