// Simplified phone frame for the landing story devices. Decorative chrome
// only (island + home indicator); the handoff's full iOS frame is prototype
// tooling and is not ported. Content is responsive — no transform scaling.

import type { ReactNode } from "react";

export function PhoneFrame({
  children,
  tall = false,
  lost = false,
}: {
  children: ReactNode;
  tall?: boolean;
  /** Lost-credential screen: warm red paper background. */
  lost?: boolean;
}) {
  const screenClass = ["lp-scr", tall && "lp-scr--tall", lost && "lp-scr--lost"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="lp-phone" aria-hidden="true">
      <span className="lp-phone-island" />
      <div className={screenClass}>{children}</div>
      <span className="lp-phone-home" />
    </div>
  );
}
