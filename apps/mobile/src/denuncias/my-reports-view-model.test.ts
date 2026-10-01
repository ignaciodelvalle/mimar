import { describe, expect, it } from "@jest/globals";

import { MY_WELFARE_REPORT_STATUSES_V1, type MyWelfareReportRowV1 } from "@dim/contract/api";

import {
  myReportFailureMessage,
  myReportsSummary,
  reportDateLabel,
  reportRowAccessibilityLabel,
  statusTone,
} from "./my-reports-view-model";

describe("myReportsSummary", () => {
  it("speaks the web's count line", () => {
    expect(myReportsSummary(0, false)).toBe("Sin denuncias enviadas.");
    expect(myReportsSummary(1, false)).toBe("1 denuncia enviada.");
    expect(myReportsSummary(3, false)).toBe("3 denuncias enviadas.");
  });

  it("does not state a total it has not seen", () => {
    expect(myReportsSummary(50, true)).toBe("50 denuncias enviadas (hay más).");
  });
});

describe("statusTone", () => {
  it("has a tone for every status the contract names", () => {
    for (const status of MY_WELFARE_REPORT_STATUSES_V1) {
      expect(["ok", "progress", "review", "muted"]).toContain(statusTone(status));
    }
    expect(statusTone("closed")).toBe("ok");
    expect(statusTone("in_progress")).toBe("progress");
    expect(statusTone("triaged")).toBe("review");
  });
});

describe("myReportFailureMessage", () => {
  it("gives not_found a sentence about a denuncia", () => {
    expect(
      myReportFailureMessage({ outcome: "api-error", code: "not_found", retryAfterSeconds: null }),
    ).toContain("No encontramos esta denuncia");
  });

  it("hands every other failure to the shared copy", () => {
    expect(
      myReportFailureMessage({ outcome: "api-error", code: "rate_limited", retryAfterSeconds: 30 }),
    ).toContain("30 segundos");
  });

  it("prints the support code of a reported failure (F-6)", () => {
    // MyReportDetailScreen renders this function's answer and nothing else, so
    // this is where the shared mapping's "Código" has to survive the override.
    expect(
      myReportFailureMessage({
        outcome: "malformed",
        detail: "bad json",
        correlationId: "abc12345",
      }),
    ).toBe("El servidor respondió algo que no pudimos leer. Volvé a intentar.\nCódigo: abc12345");
  });
});

describe("reportRowAccessibilityLabel", () => {
  it("reads kind, status, date, place and code, skipping what is absent", () => {
    const row: MyWelfareReportRowV1 = {
      referenceCode: "DEN-AAAA-0001",
      kindLabel: "Abandono",
      severityLabel: "Urgente",
      status: "open",
      statusLabel: "Abierta",
      excerpt: "x",
      filedAt: "2026-09-20T12:00:00.000Z",
      place: null,
    };
    expect(reportRowAccessibilityLabel(row)).toBe(
      `Abandono. Estado: Abierta. Enviada el ${reportDateLabel(row.filedAt)}. Código DEN-AAAA-0001`,
    );
  });

  it("says so when a date is malformed", () => {
    expect(reportDateLabel("nope")).toBe("fecha desconocida");
  });
});
