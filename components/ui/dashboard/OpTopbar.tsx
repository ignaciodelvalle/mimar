import type { NavItem } from "@/components/layout/HeaderNav";
import type { ReactNode } from "react";
import type { CrumbItem } from "./OpCrumbs";
import { OpCrumbs } from "./OpCrumbs";
import { OpMobileDrawer } from "./OpMobileDrawer";
import type { NavSection } from "./OpRailNav";
import { OpScopeChip } from "./OpScopeChip";

type Props = {
  /** Breadcrumb trail. */
  crumbs?: CrumbItem[];
  /**
   * Optional override slot for breadcrumbs. When provided, renders instead
   * of the default <OpCrumbs> built from `crumbs`. Supports client components
   * (e.g. OrgBreadcrumbs which uses usePathname).
   */
  customCrumbs?: ReactNode;
  /** Scope chip config. */
  scope?: {
    code: string;
    label?: string;
    variant?: "default" | "superadmin" | "org";
  };
  /** Right-side actions slot. */
  actions?: ReactNode;
  /** Flat nav for the mobile drawer. */
  mobileNav?: NavItem[];
  /** Multi-section nav for the mobile drawer (takes precedence). */
  mobileSections?: NavSection[];
  /** Visual variant — forwarded to the mobile drawer. */
  variant?: "gob" | "org";
  /** Brand subtitle — forwarded to the mobile drawer. */
  brandSubtitle?: string;
};

/**
 * White sticky topbar for the Operador tier.
 *
 * Server component — OpMobileDrawer is the client island inside it.
 * Does NOT carry md:ml-60 offset — OpShell controls layout via flex.
 */
export function OpTopbar({
  crumbs,
  customCrumbs,
  scope,
  actions,
  mobileNav,
  mobileSections,
  variant = "gob",
  brandSubtitle,
}: Props) {
  return (
    <header className="sticky top-0 z-[var(--z-header)] flex flex-shrink-0 items-center gap-3 border-b border-ln-op-line bg-ln-op-card px-6 py-[11px]">
      {/* Mobile hamburger — client island */}
      {(mobileNav || mobileSections) && (
        <OpMobileDrawer
          nav={mobileNav}
          sections={mobileSections}
          variant={variant}
          brandSubtitle={brandSubtitle}
        />
      )}

      {/* Left: breadcrumbs — customCrumbs takes precedence over static crumbs */}
      {customCrumbs ? customCrumbs : crumbs && crumbs.length > 0 && <OpCrumbs items={crumbs} />}

      {/* Scope chip */}
      {scope && <OpScopeChip code={scope.code} label={scope.label} variant={scope.variant} />}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: actions */}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
