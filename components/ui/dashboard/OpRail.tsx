import type { NavItem } from "@/components/layout/HeaderNav";
import { BRANDING } from "@/lib/ui/branding";
import { OpHelpLink } from "./OpHelpLink";
import { type NavSection, OpRailNav } from "./OpRailNav";

type Props = {
  /** Flat nav list (single-section, backward-compatible). */
  nav?: NavItem[];
  /** Multi-section nav — takes precedence over `nav`. */
  sections?: NavSection[];
  /** Visual variant. */
  variant?: "gob" | "org";
  /** Brand wordmark subtitle (e.g. "Gobierno" | "Plataforma"). */
  brandSubtitle?: string;
  /** Authenticated user info for the footer strip. */
  user?: { name: string; role?: string; initials?: string };
};

/** Returns up to 2 uppercase initials from a display name. */
function toInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Fixed 224px navy (or teal) rail for the Operador tier.
 *
 * Server component — active-state logic lives in the OpRailNav client island.
 */
export function OpRail({
  nav,
  sections,
  variant = "gob",
  brandSubtitle = "Operador",
  user,
}: Props) {
  const railBg = variant === "org" ? "bg-[var(--color-ln-tl-rail)]" : "bg-ln-op-navy";
  const initials = user?.initials ?? (user?.name ? toInitials(user.name) : "");

  return (
    <aside
      className={[
        "hidden md:flex md:w-[224px] md:flex-shrink-0 md:flex-col",
        railBg,
        "border-r border-[rgba(255,255,255,0.10)]",
        "text-ln-op-rail-text",
      ].join(" ")}
      aria-label="Barra de navegación"
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-[rgba(255,255,255,0.10)] px-4 py-4 pb-[13px]">
        {/* Same mark, same paper-tile recipe as the citizen masthead
            (components/layout/AppCitizenMasthead.tsx) — was a typographic
            `m·` monogram; alt="" because the wordmark + subtitle beside it
            already carry the brand name. */}
        <div className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] bg-[var(--color-ln-paper)]">
          <img src="/logo-mimar-mark.svg" alt="" width={25} height={25} />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-ln-serif text-base font-semibold tracking-[-0.005em] text-white">
            {BRANDING.appName}
          </span>
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-ln-op-rail-mute">
            {brandSubtitle}
          </span>
        </div>
      </div>

      {/* Nav */}
      <OpRailNav nav={nav} sections={sections} variant={variant} />

      {/* A person to write to, on every operator screen (pilot T1-P5). */}
      <OpHelpLink />

      {/* Footer user strip */}
      {user && (
        <div className="flex items-center gap-2.5 border-t border-[rgba(255,255,255,0.10)] px-[13px] py-[11px]">
          <div className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#3a6cb3] to-[#6a4c93] text-sm font-bold text-white">
            {initials || "?"}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-white">{user.name}</span>
            {user.role && (
              <span className="font-ln-mono text-xs text-ln-op-rail-mute">{user.role}</span>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
