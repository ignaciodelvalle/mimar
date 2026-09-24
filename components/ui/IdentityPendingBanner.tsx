// IdentityPendingBanner — the way BACK into an abandoned signup.
//
// WHY (staging finding, 2026-08-01)
// ---------------------------------
// Signup step 2 (real name) lived entirely in React state on /signup. A page
// guard was racing it and pushing brand new accounts straight to /mis-mascotas,
// and even without that race, closing the tab left the account on the trigger's
// provisional email-derived display_name FOREVER — nothing existed to bring the
// user back. A UI step with no server-side reinforcement and no return path is
// a suggestion, not a requirement.
//
// This is the return path. `pending` is computed on the SERVER on every request
// (isIdentityPending, from the profile row), so it survives closed tabs, new
// devices and new sessions, and it clears itself the instant the real name is
// saved.
//
// Deliberately NOT dismissible — no close button, no "seen" flag, no state.
// Same reasoning as DemoModeBanner: this system is an identity registry, and a
// titular with no real name is a record that does not do its job. What it is
// NOT is a wall: the app stays fully usable, because someone who came to load
// their pet should be able to load their pet. The banner explains what is
// missing and why, and is one click from fixing it.

import Link from "next/link";

interface IdentityPendingBannerProps {
  /**
   * Server-computed. Pass isIdentityPending({ displayName, email }) — do not
   * re-derive the rule here.
   */
  pending: boolean;
  /** Where to send the user back after they save their name. */
  returnTo: string;
}

export function IdentityPendingBanner({ pending, returnTo }: IdentityPendingBannerProps) {
  if (!pending) return null;

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-2 text-center text-sm text-ln-op-ink-2">
      <span>
        Falta tu nombre. Por ahora figurás con la primera parte de tu correo, y eso es lo que ve
        quien mira la credencial de tu mascota.
      </span>
      <Link
        href={`/registro?returnTo=${encodeURIComponent(returnTo)}`}
        className="font-semibold underline underline-offset-2"
      >
        Completar mi perfil
      </Link>
    </div>
  );
}
