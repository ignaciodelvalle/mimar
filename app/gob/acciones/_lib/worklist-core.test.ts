// worklist-core.test — the /gob/acciones composition contract (G5).
//
// What this pins: the worklist is ranked by DEADLINE ACROSS DOMAINS — an
// overdue rabies observation outranks a fresher denuncia, which outranks an
// on-time caso — never grouped per domain and never ranked by count (the
// pre-existing-bandeja behavior this screen exists to replace). Also pins
// each domain's dueAt rule and its honest resolution affordance.

import { describe, expect, it } from "vitest";

import { WELFARE_SLA_DAYS } from "@/app/gob/maltrato/_lib/welfare-sla";
import { CASE_SLA_WARNING_DAYS } from "@/src/modules/cases/domain/case-sla";

import {
  type CaseWorklistRow,
  type ObservationWorklistRow,
  type WelfareWorklistRow,
  buildWorklist,
  mapCaseRows,
  mapObservationRows,
  mapWelfareRows,
} from "./worklist-core";

const NOW = new Date("2026-08-02T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function obsRow(over: Partial<ObservationWorklistRow> = {}): ObservationWorklistRow {
  return {
    petId: "pet-1",
    petPublicToken: "DIM-TEST-0001",
    petName: "Pampa",
    species: "dog",
    province: "Buenos Aires",
    locality: "La Plata",
    dueAt: daysFromNow(2),
    ...over,
  };
}

function welfareRow(over: Partial<WelfareWorklistRow> = {}): WelfareWorklistRow {
  return {
    id: "wr-1",
    referenceCode: "DEN-AAAA-0001",
    kind: "physical_abuse",
    severity: "medium",
    createdAt: daysFromNow(-1),
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
    assignedToUserId: null,
    ...over,
  };
}

function caseRow(over: Partial<CaseWorklistRow> = {}): CaseWorklistRow {
  return {
    id: "case-1",
    publicCode: "CAS-0001-0001",
    caseKind: "bite_incident",
    primaryPetName: "Firulais",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    openedAt: daysFromNow(-1),
    ...over,
  };
}

describe("mapObservationRows — deadline supplied by the caller (resolveObservationDeadline)", () => {
  it("normalizes the supplied dueAt and links out to the professional-closure flow", () => {
    const [item] = mapObservationRows([obsRow({ dueAt: daysFromNow(-4) })], NOW);
    expect(item.domain).toBe("observacion");
    expect(item.due.state).toBe("overdue");
    expect(item.due.overdueDays).toBe(4);
    expect(item.code).toBe("DIM-TEST-0001");
    expect(item.action).toEqual({
      type: "link",
      href: "/gob/observaciones/DIM-TEST-0001",
      label: "Cerrar",
    });
  });

  it("an observation with no started event (dueAt null) stays visible as 'Sin plazo', never fabricated", () => {
    const [item] = mapObservationRows([obsRow({ dueAt: null })], NOW);
    expect(item.due.dueAt).toBeNull();
    expect(item.due.state).toBe("onTime");
  });
});

describe("mapWelfareRows — dueAt = createdAt + the severity's OWN SLA tier", () => {
  it.each(Object.entries(WELFARE_SLA_DAYS))(
    "severity %s expires exactly tier days after filing",
    (severity, tierDays) => {
      const createdAt = daysFromNow(-tierDays - 2); // 2 days past its tier
      const [item] = mapWelfareRows(
        [welfareRow({ severity: severity as WelfareWorklistRow["severity"], createdAt })],
        NOW,
      );
      expect(item.due.dueAt?.getTime()).toBe(createdAt.getTime() + tierDays * DAY_MS);
      expect(item.due.state).toBe("overdue");
      // THE TIER-VS-COUNT GUARD: the overdue count is days past the
      // deadline (2), NEVER the tier number itself.
      expect(item.due.overdueDays).toBe(2);
    },
  );

  it("an unassigned denuncia offers the inline Tomar (the one true inline domain)", () => {
    const [item] = mapWelfareRows([welfareRow({ assignedToUserId: null })], NOW);
    expect(item.action).toEqual({
      type: "welfare",
      reportId: "wr-1",
      unassigned: true,
      href: "/gob/maltrato/DEN-AAAA-0001",
    });
  });

  it("an assigned denuncia keeps the Resolver link but drops the Tomar affordance", () => {
    const [item] = mapWelfareRows([welfareRow({ assignedToUserId: "user-9" })], NOW);
    expect(item.action).toMatchObject({ type: "welfare", unassigned: false });
  });
});

describe("mapCaseRows — dueAt = openedAt + CASE_SLA_WARNING_DAYS, link-out only", () => {
  it("computes the case deadline from the shared CaseQueue constant", () => {
    const openedAt = daysFromNow(-(CASE_SLA_WARNING_DAYS + 5));
    const [item] = mapCaseRows([caseRow({ openedAt })], NOW);
    expect(item.due.dueAt?.getTime()).toBe(openedAt.getTime() + CASE_SLA_WARNING_DAYS * DAY_MS);
    expect(item.due.state).toBe("overdue");
    expect(item.due.overdueDays).toBe(5);
  });

  it("never invents a row mutation — the action is an honest 'Ver' link to the case", () => {
    const [item] = mapCaseRows([caseRow()], NOW);
    expect(item.action).toEqual({ type: "link", href: "/gob/casos/CAS-0001-0001", label: "Ver" });
  });
});

describe("buildWorklist — ONE flat list ranked by deadline across domains", () => {
  it("interleaves domains strictly by urgency: overdue first (most overdue leading), then due-soon, then on-time", () => {
    const observaciones = mapObservationRows(
      [
        obsRow({ petId: "p-ontime", dueAt: daysFromNow(8) }),
        obsRow({ petId: "p-overdue", dueAt: daysFromNow(-6) }),
      ],
      NOW,
    );
    const denuncias = mapWelfareRows(
      [
        // medium (7d tier) filed 9 days ago → overdue 2 days.
        welfareRow({ id: "w-overdue", createdAt: daysFromNow(-9) }),
        // medium filed 5 days ago → due in 2 days (dueSoon).
        welfareRow({ id: "w-soon", referenceCode: "DEN-AAAA-0002", createdAt: daysFromNow(-5) }),
      ],
      NOW,
    );
    const casos = mapCaseRows(
      [
        // opened 14+10 days ago → overdue 10 days (the MOST overdue row).
        caseRow({ id: "c-most-overdue", openedAt: daysFromNow(-(CASE_SLA_WARNING_DAYS + 10)) }),
        // opened 2 days ago → on-time (due in 12 days).
        caseRow({ id: "c-ontime", publicCode: "CAS-0001-0002", openedAt: daysFromNow(-2) }),
      ],
      NOW,
    );

    const { items, totalCount } = buildWorklist([observaciones, denuncias, casos]);
    expect(totalCount).toBe(6);
    expect(items.map((i) => i.key)).toEqual([
      "caso:c-most-overdue", // overdue 10d
      "obs:p-overdue", // overdue 6d
      "den:w-overdue", // overdue 2d
      "den:w-soon", // vence en 2d
      "obs:p-ontime", // vence en 8d
      "caso:c-ontime", // vence en 12d
    ]);
  });

  it("rows without a deadline sink to the very end, after every dated row", () => {
    const { items } = buildWorklist([
      mapObservationRows([obsRow({ petId: "p-null", dueAt: null })], NOW),
      mapCaseRows([caseRow({ id: "c-ontime", openedAt: NOW })], NOW),
    ]);
    expect(items.map((i) => i.key)).toEqual(["caso:c-ontime", "obs:p-null"]);
  });

  it("caps the rendered list but reports the true fetched total", () => {
    const many = mapCaseRows(
      Array.from({ length: 7 }, (_, i) =>
        caseRow({ id: `c-${i}`, publicCode: `CAS-0001-000${i}`, openedAt: daysFromNow(-i) }),
      ),
      NOW,
    );
    const { items, totalCount } = buildWorklist([many], 5);
    expect(items).toHaveLength(5);
    expect(totalCount).toBe(7);
    // The cap drops the LEAST urgent tail — the freshest cases, never the oldest.
    expect(items[0].key).toBe("caso:c-6");
  });
});
