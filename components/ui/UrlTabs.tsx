"use client";

import { useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, createContext, useContext, useRef } from "react";

import { Icon, type IconName } from "@/components/Icon";
import { serverNavCommit } from "@/lib/ui/filter-commit";
import { pluralizeEs } from "@/lib/utils/format";

/**
 * Libreta Nacional URL-driven Tabs (with content panels).
 *
 * The LN-idiom counterpart of the old poncho Tabs: same API, same behavior
 * (active tab persists in a searchParam, panels mount via UrlTabsContent),
 * restyled to LN tokens. For a simple controlled tab bar with no URL/panels,
 * use LnTabs from ./Tabs instead.
 *
 * - Active tab is read from `searchParams[paramKey]`; falls back to `defaultValue`.
 * - Switching tabs navigates via a full document navigation, preserving the
 *   other searchParams (see design note below).
 * - `UrlTabsContent` reads the active tab from context; hidden when inactive.
 *
 * Accessibility: role="tablist"/"tab"/"tabpanel", aria-selected, aria-controls.
 *
 * Design note (router-drop defect, same cure as components/gob/JurisdictionSwitcher.tsx):
 * Next 15.5.18's App Router can silently drop a client transition's own fetch in
 * production — the RSC request resolves 200 but the URL and UI never update.
 * The consumer pages (app/gob/maltrato, app/gob/perdidas) server-render the tab
 * content from this searchParam on every request, so a `router.replace`
 * transition is exposed to the drop. A full document navigation
 * (`window.location.assign`) is the one mechanism proven immune — the
 * browser's native GET cannot be silently dropped, and it always re-runs the
 * server component with the new searchParams.
 */

const TabsContext = createContext<string>("");

export type UrlTabItem = {
  value: string;
  label: string;
  icon?: IconName;
  /** Optional count badge. Rendered in seal (red) tone when > 0. */
  badge?: number;
  /**
   * Badge semantics. "urgent" (default) reads the count as a red seal alert
   * ("N urgentes") — the queue/case idiom the gob pages use. "neutral" reads it
   * as a plain filter count, tinted to the active/inactive tab state — the inbox
   * idiom (e.g. /notificaciones category counts, where every tab has items).
   */
  badgeTone?: "urgent" | "neutral";
};

export type UrlTabsProps = {
  paramKey: string;
  defaultValue: string;
  tabs: UrlTabItem[];
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  /**
   * Extra param keys to drop (in addition to setting `paramKey`) when the
   * active tab changes — mirrors OpFilterBar's `resetParamsOnChange`. Use
   * this when a tab switch invalidates state from the OTHER tabs (e.g. a
   * pagination cursor, or a deep-link selection param that only makes sense
   * under one tab) — see app/gob/denuncias/page.tsx's `etapa` tabs, which
   * drop the moderación/triage queues' own cursor + inspector params on
   * switch. Omit to preserve every other param (existing behavior).
   */
  resetParamsOnChange?: readonly string[];
};

export type UrlTabsContentProps = {
  value: string;
  children: ReactNode;
};

export function UrlTabs({
  paramKey,
  defaultValue,
  tabs,
  children,
  className = "",
  "aria-label": ariaLabel,
  resetParamsOnChange = [],
}: UrlTabsProps) {
  const searchParams = useSearchParams();
  // Fall back to `defaultValue` for a param that is ABSENT *or* unrecognized
  // (bug fix, gob-perdidas-tab-partition 2026-07-23): consumer pages sanitize
  // an invalid searchParam server-side (e.g. /gob/denuncias's `parseEtapa`,
  // /gob/perdidas's `parseStatusFilter` both fall back to their own default
  // for a garbage value) and render ONLY that resolved tab's content. Before
  // this fix, a raw unrecognized param (e.g. `?etapa=not-a-real-stage`) made
  // THIS activeTab equal that garbage string, which matches none of `tabs` —
  // every tabpanel's `isActive` (UrlTabsContent) came back false, so the one
  // panel the server actually rendered content into (keyed by the SANITIZED
  // value) was wrongly hidden/emptied even though its content was correct.
  const rawParam = searchParams.get(paramKey);
  const activeTab =
    rawParam !== null && tabs.some((t) => t.value === rawParam) ? rawParam : defaultValue;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleTabClick(value: string) {
    serverNavCommit(searchParams.toString())({ [paramKey]: value }, resetParamsOnChange);
  }

  // APG Tabs keyboard pattern (automatic activation): Arrow Left/Right move
  // between tabs (wrapping), Home/End jump to the first/last tab, and the
  // moved-to tab activates immediately — same navigation `handleTabClick`
  // already performs on click. Roving tabindex (below) keeps Tab/Shift+Tab
  // landing on the single active tab instead of stepping through every tab.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = tabs.findIndex((tab) => tab.value === activeTab);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
    handleTabClick(tabs[nextIndex].value);
  }

  return (
    <TabsContext.Provider value={activeTab}>
      <div className={className}>
        <div
          role="tablist"
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          className="flex border-b border-[var(--color-ln-line)]"
        >
          {tabs.map((tab, index) => {
            const isActive = tab.value === activeTab;
            return (
              <button
                key={tab.value}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`tabpanel-${tab.value}`}
                id={`tab-${tab.value}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => handleTabClick(tab.value)}
                className={[
                  "inline-flex items-center gap-[7px] min-h-11 px-[18px] text-md font-semibold",
                  "transition-colors border-b-2 -mb-px",
                  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
                  isActive
                    ? "border-b-[var(--color-ln-azul)] text-[var(--color-ln-azul)]"
                    : "border-b-transparent text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink-2)]",
                ].join(" ")}
              >
                {tab.icon && <Icon name={tab.icon} size="1em" decorative />}
                {tab.label}
                {tab.badge !== undefined &&
                  (tab.badgeTone === "neutral" ? (
                    <span
                      className={[
                        "ml-1 rounded-full px-1.5 py-px font-ln-mono text-xs leading-none",
                        isActive
                          ? "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]"
                          : "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
                      ].join(" ")}
                    >
                      {tab.badge}
                    </span>
                  ) : (
                    <span
                      className={[
                        "ml-1 rounded-full px-1.5 py-px font-ln-mono text-xs leading-none",
                        tab.badge > 0
                          ? "bg-[var(--color-ln-seal)] text-white"
                          : "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
                      ].join(" ")}
                      aria-label={`${tab.badge} ${pluralizeEs(tab.badge, "urgente")}`}
                    >
                      {tab.badge}
                    </span>
                  ))}
              </button>
            );
          })}
        </div>

        <div>{children}</div>
      </div>
    </TabsContext.Provider>
  );
}

export function UrlTabsContent({ value, children }: UrlTabsContentProps) {
  const activeTab = useContext(TabsContext);
  const isActive = value === activeTab;

  // Only mount the ACTIVE panel's children (bug fix, gob-perdidas-tab-partition
  // 2026-07-23): every UrlTabs switch is a full document navigation (see the
  // router-drop design note above), so an inactive panel's markup can NEVER
  // become visible through client interaction — there is no SPA transition to
  // pre-render for. Consumer pages (perdidas, maltrato, denuncias, moderación,
  // …) build each tab's OpCard from a SINGLE query scoped to the CURRENTLY
  // active tab/status, then `.map()` that same result across every tab value
  // just to vary the heading text. Rendering all of them (even `hidden`) put
  // the active tab's rows in the DOM three extra times, each mislabeled under
  // the OTHER tabs' headings (e.g. /gob/perdidas?status=lost put the 8 lost
  // pets inside the hidden "Mascotas recuperadas" AND "Mascotas fallecidas"
  // panels too) — invisible to a sighted human, but readable by any DOM-level
  // inspection (a11y tooling, `element.textContent`, an automated crawler),
  // which is exactly how the gov-ux adversarial review's browse-only pass
  // reported "the same 8 pets under perdidas AND recuperadas AND fallecidas".
  // The tabpanel `div` itself stays for every tab (keeps `aria-controls`
  // resolvable and the roving-tabindex/APG structure intact) — only its
  // content is now gated on being the active panel.
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={!isActive}
    >
      {isActive ? children : null}
    </div>
  );
}
