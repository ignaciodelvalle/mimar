// D-7 / D-10 (Lote D) — the org landing's "Pendientes" rows, under deadline.
//
// The regression D-7 exists for, stated once: a pending decomiso handoff past
// its 7-day legal window (Ley 14.346) must read DANGER. Before the fix the tone
// came from the queue KEY alone, so that row painted the same calm "open" as a
// routine custody handshake proposed this morning — on the landing of the org
// that owes the answer, while the escalation cron was already paging the
// authority about that exact case.

import { describe, expect, it } from "vitest";

import { DECOMISO_HANDOFF_STALE_DAYS } from "@/src/modules/cases/domain/case-sla";

import { pendingQueueTone, queueSignalNote } from "./queue-signal-display";

const overdue = { oldestAgeDays: 20, hasOverdue: true };
const inTime = { oldestAgeDays: 2, hasOverdue: false };

describe("pendingQueueTone — a blown legal deadline outranks the queue's key", () => {
  it("THE D-7 CASE: a pending decomiso handoff past its 7-day deadline reads danger", () => {
    expect(pendingQueueTone("pendingTransfers", 1, overdue)).toBe("danger");
  });

  it("the same queue with nothing overdue keeps the ordinary work tone", () => {
    expect(pendingQueueTone("pendingTransfers", 1, inTime)).toBe("open");
    // No signal at all (the aging query failed, or the queue carries none) must
    // not be read as "overdue" — absence of evidence is not evidence.
    expect(pendingQueueTone("pendingTransfers", 1)).toBe("open");
  });

  it("an empty queue is calm even if a stale signal somehow arrives", () => {
    expect(pendingQueueTone("pendingTransfers", 0, overdue)).toBe("neutral");
  });

  it("the pre-existing danger keys are unchanged (no regression on welfare / check-ins)", () => {
    expect(pendingQueueTone("derivedWelfare", 3)).toBe("danger");
    expect(pendingQueueTone("overdueCheckins", 1)).toBe("danger");
    expect(pendingQueueTone("openCases", 5)).toBe("open");
    expect(pendingQueueTone("rabiesObservations", 2)).toBe("open");
  });

  it("an overdue signal can escalate ANY queue, not only the ones keyed danger", () => {
    expect(pendingQueueTone("activeAdoptions", 4, overdue)).toBe("danger");
  });
});

describe("queueSignalNote — the row's muted explanation", () => {
  it("names the law and the window when a deadline is blown, then the age", () => {
    expect(queueSignalNote(overdue)).toBe(
      `Fuera del plazo legal de ${DECOMISO_HANDOFF_STALE_DAYS} días (Ley 14.346) · la más antigua: 20 días`,
    );
  });

  it("THE D-10 CASE: a queue in time still says how long its oldest row waited", () => {
    expect(queueSignalNote({ oldestAgeDays: 35, hasOverdue: false })).toBe(
      "La más antigua: 35 días",
    );
  });

  it("says nothing when there is no signal, and nothing when the queue is empty", () => {
    expect(queueSignalNote(undefined)).toBeNull();
    expect(queueSignalNote({ oldestAgeDays: null, hasOverdue: false })).toBeNull();
  });

  it("still names the breach when the age is unknown — the law does not depend on it", () => {
    expect(queueSignalNote({ oldestAgeDays: null, hasOverdue: true })).toBe(
      `Fuera del plazo legal de ${DECOMISO_HANDOFF_STALE_DAYS} días (Ley 14.346)`,
    );
  });

  it("never invents an overdue COUNT — the signal knows THAT, not how many", () => {
    expect(queueSignalNote(overdue)).not.toMatch(/\d+ vencidas?/);
  });
});
