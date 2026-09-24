import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import type { LnPetStatus } from "./Chip";
import { LnStatusFlag } from "./StatusFlag";

/**
 * Libreta Nacional RegRow — pet registry row.
 *
 * Grid: 64px (photo) | 1fr (info) | auto (species+chevron)
 * - Circular photo with status dot
 * - Serif name + status flag + breed + next-event line
 * - Right: species label + chevron
 * - Left 3px border colored by status (lost/sick/pregnant)
 * - Hover: stripe background
 *
 * Used in: Inicio (64px), Mis Mascotas (72px variant)
 */

// ---------- Pet photo placeholder ----------------------------------------

export type LnPetPhotoProps = {
  src?: string;
  alt: string;
  status?: LnPetStatus;
  size?: number;
  radius?: "full" | "md";
  /**
   * Turns the EMPTY placeholder into a link that starts adding a photo.
   *
   * OPT-IN, and it has to be. This primitive renders on the public credential
   * and in read-only registry rows, where an "Agregar foto" affordance would be
   * offering an action the viewer cannot perform. The caller knows whether the
   * person looking owns this animal; the primitive does not, and must not guess.
   *
   * Ignored when `src` is present: replacing an existing photo is an edit, and
   * edits belong in the edit form where the old photo is visible next to the
   * new one. This is only the empty-state shortcut.
   *
   * Deliberately a HREF and not an upload handler — the href points at the
   * existing edit sheet (`?sheet=editar-mascota`), so the file input, its
   * validation, the server action and the storage write stay exactly where they
   * already are. A second upload path is a second thing to keep correct.
   */
  addPhotoHref?: string;
  /** Pet name for the link's accessible label. Required with `addPhotoHref`. */
  addPhotoLabel?: string;
};

/**
 * The word under the empty-avatar placeholder. Its own component because BOTH
 * branches below need it — the plain placeholder and the add-photo link — and
 * the 7px size is on the design-token ratchet's list, which counts occurrences.
 * A second copy of the class string is a second thing to migrate when that size
 * finally moves onto the named scale.
 */
function PlaceholderLabel() {
  return <span className="font-ln-mono text-[7px] uppercase tracking-[.04em]">foto</span>;
}

export function LnPetPhoto({
  src,
  alt,
  status,
  size = 56,
  radius = "full",
  addPhotoHref,
  addPhotoLabel,
}: LnPetPhotoProps) {
  const radiusClass = radius === "full" ? "rounded-full" : "rounded-[var(--radius-md)]";
  const offersAdd = !src && Boolean(addPhotoHref);
  return (
    <div
      className={[
        "relative grid flex-shrink-0 place-items-center overflow-hidden border border-[var(--color-ln-line-strong)]",
        radiusClass,
        // Diagonal placeholder pattern (matches handoff)
        "bg-[repeating-linear-gradient(135deg,var(--pattern-no-photo-a)_0_6px,var(--pattern-no-photo-b)_6px_12px)]",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
    >
      {src ? (
        <Image src={src} alt={alt} fill sizes={`${size}px`} className="object-cover" />
      ) : offersAdd ? (
        // The whole placeholder is the target, not a small icon inside it: at
        // 56px the ring IS the tap area, and anything smaller fails the 44px
        // minimum on a phone — which is the device this shortcut exists for.
        <Link
          href={addPhotoHref as string}
          aria-label={
            addPhotoLabel ? `Agregar foto de ${addPhotoLabel}` : "Agregar foto de la mascota"
          }
          className={`absolute inset-0 grid place-items-center gap-0.5 text-[var(--color-ln-mute)] transition-colors hover:bg-[var(--color-ln-stripe)] hover:text-[var(--color-ln-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ln-azul)] ${radiusClass}`}
        >
          <span aria-hidden="true" className="text-base leading-none">
            +
          </span>
          <PlaceholderLabel />
        </Link>
      ) : (
        <span className="text-[var(--color-ln-mute)]">
          <PlaceholderLabel />
        </span>
      )}

      {/* Status dot */}
      {status && (
        <span
          className={[
            "absolute bottom-[2px] right-[2px] h-[12px] w-[12px] rounded-full border-2 border-[var(--color-ln-card)]",
            status === "ok" && "bg-[var(--color-ln-ok)]",
            status === "registered" && "bg-[var(--color-ln-mute)]",
            status === "sick" && "rounded-[var(--radius-xs)] bg-[var(--color-ln-warn)]",
            status === "lost" && "rounded-[1px] bg-[var(--color-ln-err)]",
            status === "pregnant" && "bg-[var(--color-ln-rosa)]",
            status === "deceased" && "bg-[var(--color-ln-memorial-chip-text)]",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// ---------- RegRow --------------------------------------------------------

const leftBorderByStatus: Partial<Record<LnPetStatus, string>> = {
  lost: "before:bg-[var(--color-ln-err)]",
  sick: "before:bg-[var(--color-ln-warn)]",
  pregnant: "before:bg-[var(--color-ln-rosa)]",
};

export type LnRegRowProps = {
  photoSrc?: string;
  name: string;
  status?: LnPetStatus;
  /** The animal's sex — the status flag inflects on it ("PERDIDA", not "PERDIDO"). */
  sex?: string | null;
  breed?: string;
  nextLine?: ReactNode;
  species?: string;
  photoSize?: number;
  href?: string;
  onClick?: () => void;
  className?: string;
};

export function LnRegRow({
  photoSrc,
  name,
  status = "ok",
  sex,
  breed,
  nextLine,
  species,
  photoSize = 56,
  href,
  onClick,
  className = "",
}: LnRegRowProps) {
  const leftBorder = leftBorderByStatus[status] ?? "";

  const rowClasses = [
    "relative grid items-center gap-4 border-b border-[var(--color-ln-line-2)] px-[18px] py-[15px]",
    "text-inherit no-underline transition-colors hover:bg-[var(--color-ln-stripe)]",
    "last:border-b-0",
    // Left accent border via ::before
    "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
    leftBorder,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const gridStyle = { gridTemplateColumns: `${photoSize + 8}px 1fr auto` };

  const inner = (
    <>
      <LnPetPhoto src={photoSrc} alt={name} status={status} size={photoSize} />

      {/* Info column */}
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span className="font-ln-serif text-lg font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
            {name}
          </span>
          {status && <LnStatusFlag status={status} sex={sex} />}
        </div>
        {breed && <p className="mt-px text-md text-[var(--color-ln-mute)]">{breed}</p>}
        {nextLine && (
          <div className="mt-[7px] inline-flex items-center gap-[7px] text-sm text-[var(--color-ln-ink-2)]">
            {nextLine}
          </div>
        )}
      </div>

      {/* Right column */}
      <div className="flex items-center gap-1.5 font-ln-mono text-sm whitespace-nowrap text-[var(--color-ln-mute)]">
        {species && <span>{species}</span>}
        <span aria-hidden="true">›</span>
      </div>
    </>
  );

  if (href) {
    return (
      <a href={href} className={rowClasses} style={gridStyle}>
        {inner}
      </a>
    );
  }

  return (
    <div
      className={rowClasses}
      style={gridStyle}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {inner}
    </div>
  );
}

// ---------- Registry container -------------------------------------------

export function LnRegistry({
  children,
  className = "",
}: { children: ReactNode; className?: string }) {
  return (
    <div
      className={[
        "overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
