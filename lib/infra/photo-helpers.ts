// Pure helpers for LnPhoto component — extracted for unit testing.

export type PhotoStatus = "ok" | "lost" | "found" | "deceased";
export type PhotoSize = "sm" | "md" | "lg" | "xl";

/**
 * Returns the Tailwind ring/border class for a given photo status.
 * Uses LN design-system tokens (ln-* vars).
 */
export function getStatusRingClass(status: PhotoStatus): string {
  switch (status) {
    case "ok":
      return "border border-[var(--color-ln-line-strong)]";
    case "lost":
      return "border-2 border-[var(--color-ln-seal)]";
    case "found":
      return "border-2 border-[var(--color-ln-ok)]";
    case "deceased":
      return "border-2 border-[var(--color-ln-mute)] grayscale";
  }
}

export interface StatusBadgeProps {
  label: string;
  tone: "danger" | "success" | "neutral";
}

/**
 * Returns badge label+tone for a given status, or null when no badge is needed.
 */
export function getStatusBadgeProps(status: PhotoStatus): StatusBadgeProps | null {
  switch (status) {
    case "ok":
      return null;
    case "lost":
      return { label: "perdida", tone: "danger" };
    case "found":
      return { label: "encontrada", tone: "success" };
    case "deceased":
      return { label: "en memoria", tone: "neutral" };
  }
}

/**
 * Returns the numeric pixel size for a given PhotoSize.
 */
export function getSizePx(size: PhotoSize): number {
  switch (size) {
    case "sm":
      return 40;
    case "md":
      return 56;
    case "lg":
      return 80;
    case "xl":
      return 120;
  }
}
