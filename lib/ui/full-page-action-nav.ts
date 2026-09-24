// full-page-action-nav — post-mutation full document navigation for
// full-page CRUD forms (as opposed to lib/ui/sheet-nav.ts's same-route
// shallow closes for the pet profile's quick-capture sheets).
//
// WHY: Next.js 15.5.x's App Router has a known production-mode defect
// where a Server Action's own redirect() response resolves correctly
// (the RSC fetch completes with an `x-action-redirect` header and the
// mutation commits — confirmed directly against `audit_log` timestamps)
// but the client router's own transition machinery silently drops it: no
// history.pushState, no re-render, no error surfaced to the user. First
// found on the pet profile's sheets (engram #621/#622); reproduced 3/3 on
// every /gob/reglas CRUD submit — create, edit, delete (verify-report
// #650 WARNING-1). Live instrumentation (Playwright, production build)
// confirmed the mechanism precisely: the action's fetch DOES resolve
// (303 with `x-action-redirect: <target>;push`), but no
// history.pushState/replaceState ever fires afterward and the URL never
// changes — the router-level transition itself never commits, not a
// fetch-level failure.
//
// FIX: server actions (app/actions/business-rules.ts) no longer call
// redirect() on success — they return a plain BusinessRuleFormState with
// `redirectTo` set. The calling form does a full document navigation via
// window.location.assign() instead of relying on the framework's own
// post-action transition. Same reasoning as sheet-nav.ts's
// closeSheetNavWithFullReload: a full document navigation is the one
// mechanism proven immune to the router-drop defect (router.refresh()
// rides the SAME transition machinery and is NOT a safe substitute).
export function navigateAfterActionSuccess(targetUrl: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(targetUrl);
}
