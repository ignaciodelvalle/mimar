// outbreak_investigation lifecycle (attachment spec §6 + §7.8).
//
// Tracks a cluster of reportable-disease signals (outbreak_signal events)
// in a jurisdiction. Subject is a location / jurisdiction scope, not a
// single pet.
//
// Opens: outbreak_signal (emitted by the symptom-disease matcher when a
//   threshold of co-located symptom_observed events trips a reportable
//   disease code — attachment spec §7.8). Auto-degrade: if an
//   outbreak_investigation is already open for the same (disease_code,
//   jurisdiction), the signal attaches instead of opening a new case.
// Terminal: no dedicated close event — closed manually by govt or admin
//   once the outbreak is resolved or dismissed (same pattern as
//   microchip_remediation). closed_reason discriminates the outcome.
// Escalated: open cases may be escalated when severity rises (e.g.
//   additional high-spec signals arrive while already open).
// No auto-close cron — outbreak investigations are legally sensitive;
//   they may run for weeks. ENO pipeline spec marks brote investigation
//   linkage as v2 out-of-scope; wiring the cron is deferred to that spec.
// Manual open: allowed — govt can open without a system-emitted
//   outbreak_signal (e.g. external lab report received out of band).
// No reopen — once resolved, a new signal opens a fresh investigation.
//
// Applicable laws: Ley 15.465/60 + Decreto 3640/64 (enfermedades de
// notificación obligatoria), Ley 5325/48 PBA (denuncia obligatoria <24hs).
// Entries in lib/case-normatives.ts.

import type { CaseLifecycle } from "./types";

export const outbreakInvestigationLifecycle: CaseLifecycle = {
  kind: "outbreak_investigation",
  statusValues: ["open", "escalated", "closed"],
  opensEvents: [
    {
      eventType: "outbreak_signal",
    },
  ],
  // NO terminal events, and `manualCloseAllowed` below is deliberately false —
  // but this kind IS closable, by a path that does not go through either of
  // those two flags, and the previous comment here was wrong to read them as
  // "no closing path at all today".
  //
  // The real close is `closeInvestigation`
  // (src/modules/surveillance/application/outbreak-investigation.ts), reached
  // from `closeInvestigationAction` and from two buttons in
  // app/gob/vigilancia/investigaciones/[caseCode]/InvestigationActions.tsx.
  // It is STRICTER than the generic case close #41 shipped, which is the whole
  // reason `manualCloseAllowed` stays false: the generic one takes a reason and
  // closes, while this one demands an `outcome` (resolved | dismissed), a reason
  // of at least ten characters, and — for `resolved` — a final epidemiological
  // report, then writes `case_closed` plus a distinct audit row per outcome in
  // one transaction, jurisdiction-scoped. Turning `manualCloseAllowed` on would
  // open a second, weaker door to the same act on a legally sensitive
  // expediente. Leave it off.
  //
  // What is genuinely absent is a close on the SIGNAL. `outbreak_signal` has no
  // open/closed notion and needs none to make a stock countable: the stock is
  // `outbreak_investigations_active` (KPI_CATALOG, basis "stock"), which counts
  // the cases a person opened and a person closed.
  terminalEvents: [],
  // No auto-close cron — outbreak investigations are legally sensitive and
  // may run for weeks (ENO pipeline spec marks brote cron as v2 out-of-scope).
  cronCloseRoute: null,
  cronCloseScheduleHours: 0,
  manualOpenAllowed: true,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  // Machine-readable, not a comment: `availableCaseActions` reads this so the
  // generic case detail sends the operator to the screen that closes it instead
  // of asking them to request a policy that is already written.
  dedicatedCloseProse:
    "lo cierra la autoridad sanitaria desde la pantalla de la investigación, eligiendo si se resolvió o se descarta, con un motivo y — cuando se resuelve — un informe epidemiológico final.",
  reopenAllowed: false,
};
