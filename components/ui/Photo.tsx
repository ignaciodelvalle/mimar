import { getSizePx, getStatusBadgeProps, getStatusRingClass } from "@/lib/infra/photo-helpers";
import type { PhotoSize, PhotoStatus } from "@/lib/infra/photo-helpers";
import Image from "next/image";

export type { PhotoSize, PhotoStatus };

/**
 * LnPhoto — pet photo with status-driven visual treatment (LN design system).
 *
 * Status variants:
 *  - ok       → neutral border (ln-line-strong)
 *  - lost     → seal/red ring + "perdida" pill
 *  - found    → ok/green ring + "encontrada" pill
 *  - deceased → grayscale + muted ring + "en memoria" pill
 *
 * When `src` is omitted, renders the first 2 chars of `alt` as initials.
 *
 * Accessibility:
 *  - `alt` is always required — use the pet's name or a descriptive label.
 *  - Status pill text is visible for all users; not hidden behind aria attributes.
 */

export type LnPhotoProps = {
  status: PhotoStatus;
  size?: PhotoSize;
  src?: string;
  alt: string;
  className?: string;
};

const toneBadgeClasses: Record<"danger" | "success" | "neutral", string> = {
  danger:
    "bg-[color-mix(in_srgb,var(--color-ln-seal)_10%,transparent)] text-[var(--color-ln-seal)]",
  success: "bg-[color-mix(in_srgb,var(--color-ln-ok)_10%,transparent)] text-[var(--color-ln-ok)]",
  neutral: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]",
};

export function LnPhoto({ status, size = "md", src, alt, className = "" }: LnPhotoProps) {
  const px = getSizePx(size);
  const ringClass = getStatusRingClass(status);
  const badge = getStatusBadgeProps(status);
  const initials = alt.slice(0, 2).toUpperCase();

  return (
    <div className={`relative inline-block ${className}`.trim()}>
      {/* Photo or initials placeholder */}
      <div
        className={`rounded-full overflow-hidden flex items-center justify-center bg-[var(--color-ln-stripe)] ${ringClass}`}
        style={{ width: px, height: px }}
        aria-hidden={src ? "true" : undefined}
      >
        {src ? (
          <Image
            src={src}
            alt={alt}
            width={px}
            height={px}
            className="w-full h-full object-cover"
          />
        ) : (
          <span
            className="font-semibold text-[var(--color-ln-ink-2)] select-none"
            style={{ fontSize: px * 0.3 }}
            aria-label={alt}
          >
            {initials}
          </span>
        )}
      </div>

      {/* Status pill — bottom-right */}
      {badge && (
        <span
          className={`
            absolute bottom-0 right-0 translate-x-1/4 translate-y-1/4
            inline-flex items-center rounded-full px-1.5 py-px
            text-xs font-semibold leading-none whitespace-nowrap
            ${toneBadgeClasses[badge.tone]}
          `}
        >
          {badge.label}
        </span>
      )}
    </div>
  );
}
