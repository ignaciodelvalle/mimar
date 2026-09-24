import type { ReactNode } from "react";

import { logoutAction } from "@/app/actions/auth";
import { LnButton } from "@/components/ui/Button";

// The chrome both /mfa screens share: a centred card with a title, a lead, the
// step itself, and a way out. The way out matters — a person stuck on this step
// (wrong account, phone at home) must be able to leave it without clearing
// cookies, and signing out is the only honest exit: every portal sends this
// session straight back here.
export function MfaShell({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <h1 className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]">
            {title}
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">{lead}</p>
        </div>
        {children}
        <form action={logoutAction} className="text-center">
          <LnButton type="submit" variant="ghost" size="sm">
            Cerrar sesión
          </LnButton>
        </form>
      </div>
    </main>
  );
}
