// Where the person WAS when it broke (OBS-5).
//
// A crash report from this app arrives with a stack and nothing else: which
// screen, opened from where, after which other screen, is the context that
// makes a stack readable — and it is exactly the context a tester cannot
// reconstruct an hour later. Sentry's own React Navigation instrumentation
// would do this, but it is bound to `tracesSampleRate`, which this app pins at
// 0 deliberately (`sentry.ts`); breadcrumbs cost nothing and are attached to
// the crash rather than sampled independently of it.
//
// THE HOOK TAKES THE PATHNAME AND DOES NOT READ IT. `usePathname()` lives in
// expo-router, and `app/_layout.tsx` — the only place with a router to read it
// from — is outside jest's `roots` (CANON-431). Passing the value in is what
// puts the effect, the dependency and the stripping under test.

import { useEffect } from "react";

import { addNavigationBreadcrumb } from "./report";

/** One breadcrumb per screen change. Ids are stripped — see `telemetryPath`. */
export function useNavigationBreadcrumb(pathname: string): void {
  useEffect(() => {
    addNavigationBreadcrumb(pathname);
  }, [pathname]);
}
