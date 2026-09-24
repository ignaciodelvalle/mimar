// lib/authority.ts
//
// Seam for future integrations with Argentine authority systems.
//
// THE SEAM (G7, 2026-08-02): every function here returns an honest
// AuthoritySignalResult instead of pretending (or silently skipping) an
// external dispatch. `delivered` is false until a real receiving endpoint
// exists; `v1_noop: true` is the replay marker future automation queries to
// find obligations that still need transmission. When the SNVS 2.0 API
// lands, ONLY the internals of these functions change: replace the
// pending-transmission audit record with the real call and return
// { delivered: true } — no caller changes.
//
// signalAuthorityReport — records a reportable-disease death obligation
// (SENASA RENSE / SNVS / provincial equivalent). Today: durable
// pending-transmission audit_log record + honest marker result. The
// append-only event spine already carries the fact (`death_recorded` with
// `is_reportable: true`); the audit record adds the auditable "this needs
// external transmission" state the future API completes.
//
// signalWelfareReport — dispatches an animal-welfare denuncia to the real
// authority channel (Ley Nacional 14.346 denuncia pipeline, brigada ambiental,
// fiscalía especializada, NGO partner triage queue, or wherever the integration
// target is decided). Today a no-op; its callers already persist their own
// audit trail (src/modules/welfare/application/*).

/**
 * Identifier of the future external target system. SNVS 2.0 is the decided
 * integration path (API, not a generated document) — the value is stored in
 * pending-transmission audit payloads so replay tooling can route them.
 */
export const AUTHORITY_TARGET_SNVS = "snvs_v2";

/**
 * Honest result of an authority-signal attempt (v1_noop precedent,
 * outbreak-investigation slice). `delivered` stays false until a real
 * receiving endpoint exists; `v1_noop: true` marks the row for replay.
 */
export type AuthoritySignalResult = {
  /** True when the notification was delivered to an external system. */
  delivered: boolean;
  /**
   * Present when no integration is wired. Lets future audits identify
   * obligations that need replay once the integration target is confirmed.
   */
  v1_noop?: true;
  /** Target system identifier (SNVS 2.0 API). */
  target?: string;
  /**
   * True when the pending-transmission obligation was durably recorded in
   * audit_log. False means even the durable record failed (logged, never
   * thrown — a reporting seam must not break the death-record cascade).
   */
  auditRecorded?: boolean;
};

export type AuthorityReportInput = {
  eventId: string;
  petId: string;
  diseaseCode: string;
  confirmedByLab: boolean;
  occurredAt: Date;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /**
   * Actor for the pending-transmission audit row — the user whose event
   * triggered the obligation (death_recorded.recordedByUserId). Nullable:
   * audit_log.actor_user_id is a SET NULL FK (migration 0080).
   */
  reportedByUserId?: string | null;
};

/**
 * Records a reportable-disease obligation as a durable pending-transmission
 * state the future SNVS 2.0 API can complete.
 *
 * NOT a silent no-op anymore (G7): writes an `eno_notification_emitted`
 * audit_log row with `v1_noop: true` + `pending_transmission: true` — the
 * same replay-marker convention lib/infra/outbox-drainer.ts uses for
 * endpoint-less outbox rows, so ONE audit query finds every undelivered
 * authority notification regardless of which writer produced it.
 *
 * Does NOT invent an external call and never throws: the caller runs post-tx
 * after an already-committed death record.
 */
export async function signalAuthorityReport(
  input: AuthorityReportInput,
): Promise<AuthoritySignalResult> {
  try {
    // Dynamic import keeps this module import-light for unit tests and
    // matches the post-tx pattern of its caller (death-record-use-case).
    const { auditLog, db } = await import("@/db");
    await db.insert(auditLog).values({
      actorUserId: input.reportedByUserId ?? null,
      action: "eno_notification_emitted",
      payload: {
        kind: "authority_report",
        source_event_id: input.eventId,
        pet_id: input.petId,
        disease_code: input.diseaseCode,
        confirmed_by_lab: input.confirmedByLab,
        occurred_at: input.occurredAt.toISOString(),
        jurisdiction_province: input.jurisdictionProvince,
        jurisdiction_locality: input.jurisdictionLocality,
        target: AUTHORITY_TARGET_SNVS,
        would_send: true,
        v1_noop: true,
        pending_transmission: true,
        note: "authority_report.would_send — SNVS 2.0 receiving API not yet available",
      },
    });
    return {
      delivered: false,
      v1_noop: true,
      target: AUTHORITY_TARGET_SNVS,
      auditRecorded: true,
    };
  } catch (err) {
    console.error("[authority] pending-transmission audit record failed:", err);
    return {
      delivered: false,
      v1_noop: true,
      target: AUTHORITY_TARGET_SNVS,
      auditRecorded: false,
    };
  }
}

export type WelfareReportSignalInput = {
  reportId: string;
  kind: string;
  severity: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  hasContact: boolean;
};

export async function signalWelfareReport(_input: WelfareReportSignalInput): Promise<void> {
  // TODO(authority-integration): dispatch the welfare report to the real
  // animal-welfare authority channel (Ley Nacional 14.346 denuncia pipeline,
  // brigada ambiental, fiscalía especializada, NGO partner triage queue,
  // or wherever the integration target is decided). Today: no-op. Its callers
  // (welfare application use-cases) already write their own audit_log rows,
  // so unlike signalAuthorityReport there is no silent-obligation gap here.
  return;
}

// ---------------------------------------------------------------------------
// Outbreak investigation — ENO external notification (SNVS/SENASA/zoonosis)
// ---------------------------------------------------------------------------
//
// Legal obligation: Ley 15.465/60 + Decreto 3640/64 (enfermedades de
// notificación obligatoria). The durable record lives in the CALLER's audit
// rows (outbreak-investigation.ts writes `v1_noop: true` inside its tx); this
// function only reports the honest transmission state. The marker lets future
// dashboards identify undelivered notifications and replay them once the
// SNVS 2.0 API is available.

export type OutbreakInvestigationNotifyInput = {
  casePublicCode: string;
  caseId: string;
  diseaseCode: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedByUserId: string;
};

export type OutbreakInvestigationNotifyResult = AuthoritySignalResult;

export async function notifyOutbreakInvestigationOpened(
  _input: OutbreakInvestigationNotifyInput,
): Promise<OutbreakInvestigationNotifyResult> {
  // v1: no external call. Wire the SNVS 2.0 endpoint here when available.
  // The caller persists v1_noop in its own audit rows inside the tx; `target`
  // documents the decided integration path so the seam is unambiguous.
  return { delivered: false, v1_noop: true, target: AUTHORITY_TARGET_SNVS };
}
