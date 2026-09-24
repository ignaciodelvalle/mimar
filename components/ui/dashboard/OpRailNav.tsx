"use client";

import type { NavItem } from "@/components/layout/HeaderNav";
import { pluralizeEs } from "@/lib/utils/format";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type NavSection = {
  label: string;
  items: NavItem[];
  /**
   * Collapsible group (org nav diet, 2026-07-24): rendered as a native
   * <details> COLLAPSED by default, so secondary destinations stay one tap
   * away without crowding the rail. Auto-opens when it contains the active
   * route so the current location is never hidden.
   */
  collapsible?: boolean;
};

type Props = {
  /** Flat list of nav items (single implicit section). */
  nav?: NavItem[];
  /** Multi-section nav — takes precedence over `nav`. */
  sections?: NavSection[];
  /** Visual variant: navy rail (gob/admin) or teal rail (org). */
  variant?: "gob" | "org";
};

function isActive(item: NavItem, pathname: string | null): boolean {
  // Deferred entries are never "active" — their #defer-… sentinel must never be
  // highlighted (D4). Guard before any path comparison.
  if (item.deferred) return false;
  if (!pathname) return false;
  if (item.matchPrefix) return pathname.startsWith(item.matchPrefix);
  return pathname === item.href;
}

/**
 * Bridges next/link's pending state up to NavLink. useLinkStatus() only
 * resolves when called from a component rendered INSIDE a <Link> (it reads a
 * context <Link> provides to its own children) — NavLink itself is the
 * PARENT that renders the Link, so it cannot call the hook directly. This
 * sensor renders nothing and just reports pending changes to its parent.
 */
function RailLinkPendingSignal({ onChange }: { onChange: (pending: boolean) => void }) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    onChange(pending);
  }, [pending, onChange]);
  return null;
}

function NavLink({
  item,
  active,
  variant,
}: { item: NavItem; active: boolean; variant: "gob" | "org" }) {
  // RESILIENCE follow-up (2026-08-02, perf sweep P5): the rail opted OUT of
  // Next's automatic hover prefetch above (self-DoS fix — do not touch), so
  // clicking a cold link pays the full RSC fetch with zero warning. Firing an
  // EXPLICIT prefetch on hover/focus intent (not on mount, so the ~30-link
  // fan-out from the original bug never recurs) buys back most of that time
  // for the common "hover, then click" path, guarded to fire once per href so
  // repeated pointerenter events on the same link don't refire it.
  const router = useRouter();
  const prefetchedRef = useRef(false);
  const [pending, setPending] = useState(false);
  const prefetchOnIntent = () => {
    if (item.deferred || prefetchedRef.current) return;
    prefetchedRef.current = true;
    router.prefetch(item.href);
  };

  // Deferred (not-yet-built) destination: non-interactive, muted "Próximamente"
  // affordance — a <span> (no <Link>/<button>) so it cannot navigate and is out
  // of the tab order by default (no tabIndex). State announced via aria-disabled
  // + textual pill (not color alone — Ley 26.653). No badge on deferred (D2).
  if (item.deferred) {
    return (
      <span
        aria-disabled="true"
        className={[
          "flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-[9px] py-2",
          "text-md -ml-0.5 border-l-2 border-transparent",
          "text-ln-op-rail-mute cursor-not-allowed select-none",
        ].join(" ")}
      >
        <span className="flex-1 truncate">{item.label}</span>
        <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-[rgba(255,255,255,0.18)] px-1.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-ln-op-rail-mute">
          Próximamente
        </span>
      </span>
    );
  }

  const activeClasses =
    variant === "org"
      ? "border-l-2 border-[var(--color-ln-tl-accent)] bg-[rgba(255,255,255,0.12)] text-white font-semibold"
      : "border-l-2 border-white bg-[rgba(255,255,255,0.12)] text-white font-semibold";

  return (
    <Link
      href={item.href}
      // RESILIENCE (2026-07-10, PO instrumented-review finding #1): the operator
      // rail carries ~30 links to HEAVY SSR dashboards (10s+ render, some 503
      // under load). Next's default link prefetch fired an RSC request for EVERY
      // one on mount — ~248 requests on a single panorama load — and the backend
      // saturated ITSELF, amplifying the panorama's own ~25s. Opt out of
      // prefetch on the rail: navigation still works (fetched on click), the
      // self-DoS is gone.
      prefetch={false}
      aria-current={active ? "page" : undefined}
      // Pending affordance (useLinkStatus, Next 15.5): announces while ITS OWN
      // target route is loading — state-only, no keyframe/spinner animation
      // (deliberate: nothing here needs a reduced-motion escape hatch).
      // `undefined` (not `false`) when idle so the attribute is absent rather
      // than printing `aria-busy="false"`.
      //
      // The VISUAL half used to be `opacity-60`, and QA 2026-08-07 reported
      // seeing no pending state at all on a 30s-delayed navigation. The state
      // was firing; it just could not be read. Dimming an item on a dark navy
      // rail makes it RECEDE — the vocabulary of "disabled", not of "working" —
      // and 40% off an already-muted rail label is near-invisible. It now
      // ADVANCES instead: the same lift the active item uses, plus cursor-wait.
      // Same reason the deferred item above spells "Próximamente" instead of
      // just grey: on this rail, absence of contrast reads as absence of
      // meaning.
      aria-busy={pending || undefined}
      onPointerEnter={prefetchOnIntent}
      onFocus={prefetchOnIntent}
      // Guaranteed accessible name sourced from the nav-presets label (a11y
      // audit 2026-07): the name survives ANY visual treatment of the link
      // (icon-only compaction, CSS truncation) and folds the badge count into
      // prose instead of the bare "Cola 3" a screen reader would otherwise
      // announce. WCAG 2.5.3 label-in-name holds: the visible label is the
      // prefix of the accessible name. Guarded by OpRailNav.a11y.test.tsx.
      aria-label={
        item.badge != null && item.badge > 0
          ? `${item.label} — ${item.badge} ${pluralizeEs(item.badge, "pendiente")}`
          : item.label
      }
      className={[
        "flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-[9px] py-2",
        "text-md no-underline transition-colors",
        "-ml-0.5",
        active
          ? activeClasses
          : "border-l-2 border-transparent text-[var(--color-ln-op-rail-text)] hover:bg-[rgba(255,255,255,0.05)]",
        pending ? "cursor-wait bg-[rgba(255,255,255,0.12)] text-white" : "",
      ].join(" ")}
    >
      <RailLinkPendingSignal onChange={setPending} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className="font-ln-mono inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-[rgba(255,255,255,0.08)] px-1.5 py-0.5 text-xs font-bold leading-none text-white">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

export function OpRailNav({ nav, sections, variant = "gob" }: Props) {
  const pathname = usePathname();

  // Normalize into sections
  const resolved: NavSection[] = sections ?? (nav ? [{ label: "", items: nav }] : []);

  return (
    <nav
      className="op-scroll flex flex-1 flex-col gap-4 overflow-y-auto px-[9px] py-[13px]"
      aria-label="Navegación principal"
    >
      {resolved.map((section) => {
        const items = (
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item, pathname)}
                variant={variant}
              />
            ))}
          </div>
        );

        if (section.collapsible) {
          // Native <details>: no client state, keyboard/screen-reader
          // disclosure for free. Collapsed by default; forced open when the
          // active route lives inside so the current location never hides.
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
                  "text-[var(--color-ln-op-rail-mute)] hover:bg-[rgba(255,255,255,0.05)]",
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
              {items}
            </details>
          );
        }

        return (
          <div key={section.label} className="flex flex-col">
            {section.label && (
              <div className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-ln-op-rail-mute)]">
                {section.label}
              </div>
            )}
            {items}
          </div>
        );
      })}
    </nav>
  );
}
