// The org portal's denial screen — "you are here, and you may not do this".
//
// WHY IT IS A COMPONENT (native QA batch 2, C3)
// ---------------------------------------------------------------------------
// Two pages of the same portal answered the same refusal in two different
// languages. `/org/{token}/checkins` rendered an honest "Sin acceso" panel with
// the reason and a way back to the panel; `/org/{token}/agenda` called
// `notFound()`, so a member whose membership simply lacks `appointment.manage`
// was shown "No encontramos esta página" — a sentence that is not true, about a
// page that exists, to a person who is standing inside the organization that
// owns it. A tester reading it looks for a broken link; the real answer is one
// message to an administrator.
//
// The two screens were the same markup written twice, so "make them agree" and
// "make them one component" are the same edit. Six pages under app/org still
// inline this panel; they are left alone here on purpose — this change is a
// refusal-copy fix, not a portal-wide refactor — and this component is where
// they go when somebody does take that pass.
//
// WHAT IT IS NOT: an authorization decision. The caller decides whether access
// is denied and supplies the reason; this file only says it out loud. Nothing
// here reads a capability, a membership or a session.
//
// A 404 IS STILL RIGHT SOMEWHERE ELSE. Hiding EXISTENCE is a real requirement
// when the token itself is the secret (an org somebody is not a member of at
// all — `requireOrgAccessByToken` already answers that one, before this panel is
// ever reached). This screen is for the caller who is provably inside the org
// and provably short one capability: to them, existence is not a secret and
// pretending otherwise only costs them the fix.

import Link from "next/link";

export type OpAccessDeniedProps = {
  /**
   * es-AR copy for WHY, ready to render. Comes from the authorization layer
   * (`requireCapability` returns exactly this string) so the words a refusal
   * uses stay in one place instead of being re-invented per screen.
   */
  reason: string;
  /** The organization's public token — the "volver al panel" destination. */
  orgToken: string;
};

export function OpAccessDenied({ reason, orgToken }: OpAccessDeniedProps) {
  return (
    <div className="max-w-2xl space-y-4 py-8">
      <h1 className="text-title font-semibold text-ln-op-ink">Sin acceso</h1>
      <p className="text-md text-ln-op-mute">{reason}</p>
      <Link
        href={`/org/${orgToken}`}
        className="text-md text-ln-op-azul hover:underline no-underline"
      >
        ← Volver al panel
      </Link>
    </div>
  );
}
