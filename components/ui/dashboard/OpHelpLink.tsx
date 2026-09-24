import { Icon } from "@/components/Icon";
import { OPERATOR_HELP_EMAIL, operatorHelpHref } from "@/lib/ui/contact";

/**
 * "¿Necesitás ayuda?" — the operator shells' way to reach a person (pilot
 * T1-P5). Mounted in the desktop rail (OpRail) and the mobile drawer
 * (OpMobileDrawer), so every /gob, /org and /admin screen carries it.
 *
 * A plain `mailto:` on purpose: the channel is a mailbox a person reads
 * (lib/ui/contact.ts), and the address is printed under the label so an
 * operator whose machine has no mail client can still copy it. Server-safe —
 * no state, no hooks.
 */
export function OpHelpLink() {
  return (
    <a
      href={operatorHelpHref()}
      className="flex min-h-11 items-center gap-2.5 px-3 py-2 text-ln-op-rail-text no-underline hover:text-white"
    >
      <Icon name="help-circle" size="sm" decorative />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold">¿Necesitás ayuda?</span>
        <span className="truncate text-xs text-ln-op-rail-mute">{OPERATOR_HELP_EMAIL}</span>
      </span>
    </a>
  );
}
