// ActionLinkCard — discoverable action link card for owner surfaces.
//
// Used on /mis-mascotas to surface actions behind non-obvious routes.
// Renders as a full-bleed Link card with an optional badge count.
// When hideWhenZero is true and badge is 0 or null, renders nothing.

import { Icon, type IconName } from "@/components/Icon";
import Link from "next/link";

export type ActionLinkCardProps = {
  href: string;
  /** icono-arg icon name */
  icon: IconName;
  title: string;
  description: string;
  /** If provided, shows a count badge on the card */
  badge?: number | null;
  /** When true, the card renders nothing when badge is 0 or null */
  hideWhenZero?: boolean;
};

export function ActionLinkCard({
  href,
  icon,
  title,
  description,
  badge,
  hideWhenZero = false,
}: ActionLinkCardProps) {
  if (hideWhenZero && (badge === 0 || badge == null)) {
    return null;
  }

  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-lg border border-ln-line p-4 hover:bg-ln-stripe transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <Icon name={icon} size="1.25rem" className="text-ln-mute shrink-0" decorative />
        {badge != null && badge > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-ln-warn text-white text-xs font-semibold px-1.5">
            {badge}
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-ln-ink">{title}</p>
      <p className="text-xs text-ln-mute">{description}</p>
    </Link>
  );
}
