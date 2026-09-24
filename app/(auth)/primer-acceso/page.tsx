import type { Metadata } from "next";

import { FirstAccessStep } from "./FirstAccessStep";

// /primer-acceso — the first access of an institutional account (pilot T1-P3).
//
// The invite mail (or the link an admin copied by hand) lands HERE. GoTrue puts
// the session in the URL fragment, which never reaches the server, so this page
// cannot check the session the way /recuperar/actualizar does: the client step
// turns the fragment into a cookie session first, and the server action
// re-verifies everything before it writes (set-initial-password.ts).
//
// Every page-level guard sends a session that still owes its password back
// here (requireUserOrRedirect), so this page must never call one itself.
//
// force-dynamic for the same reason as /recuperar: the CSP nonce is minted per
// request, and a prerendered page would ship with its scripts refused.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Primer acceso",
  robots: { index: false, follow: false },
};

export default function PrimerAccesoPage() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      <div className="w-full max-w-sm space-y-8">
        <FirstAccessStep />
      </div>
    </main>
  );
}
