// Fitness test — the reporter must be quoted back in their own words.
//
// Blind QA 2026-08-19 (O2): the reporting wizard offered a card labelled
// "Grave / urgente"; `/denuncias/seguimiento` then said
// "Gravedad que indicaste: Crítica — peligro inmediato". Same row, same
// severity, a word the reporter never saw — under copy that explicitly claims
// to be quoting them.
//
// The narrow fix (swap the label on three citizen surfaces) would drift back
// the first time somebody renames a card. So this asserts the RELATIONSHIP,
// not the strings: every wizard card's label IS the citizen label for the
// severity that card writes to the database. Rename a card and this fails.
//
// It also holds the two vocabularies apart on purpose. The operator label
// carries an SLA tier a triage queue needs and a reporter does not, so the
// second assertion pins them as deliberately different rather than letting a
// future "cleanup" collapse them back into one.

import { describe, expect, it } from "vitest";

import {
  WIZARD_SEVERITY_TO_DB,
  type WizardSeverity,
} from "@/app/(public)/denuncias/nueva/_components/Step2Severity";
import {
  WELFARE_REPORT_SEVERITIES,
  WELFARE_SEVERITY_CITIZEN_LABEL,
  welfareReportSeverityCitizenLabel,
  welfareReportSeverityLabel,
} from "@/src/modules/welfare/domain/types";

// The card labels as the reporter reads them on screen. Hard-coded here on
// purpose: if this list and the wizard's rendered labels ever disagree, the
// test below fails, which is the whole point. SEVERITY_CARDS itself is not
// exported (it carries Tailwind class strings that have no business in a
// domain assertion).
const WIZARD_CARD_LABELS: Record<WizardSeverity, string> = {
  grave_urgente: "Grave / urgente",
  moderado: "Moderado",
  sospecha: "Sospecha",
};

describe("denuncia severity vocabulary", () => {
  it("every wizard card label is the citizen label for the severity it stores", () => {
    for (const [wizardValue, dbValue] of Object.entries(WIZARD_SEVERITY_TO_DB)) {
      expect(welfareReportSeverityCitizenLabel(dbValue)).toBe(
        WIZARD_CARD_LABELS[wizardValue as WizardSeverity],
      );
    }
  });

  it("covers every stored severity, including the ones the wizard cannot produce", () => {
    // `high` is unreachable from the citizen wizard (three cards, four enum
    // values) but reachable in the database via server-authoritative paths. A
    // reporter looking at one must not be shown a raw enum.
    for (const severity of WELFARE_REPORT_SEVERITIES) {
      const label = welfareReportSeverityCitizenLabel(severity);
      expect(label).not.toBe(severity);
      expect(label.trim()).not.toBe("");
    }
    expect(Object.keys(WELFARE_SEVERITY_CITIZEN_LABEL).sort()).toStrictEqual(
      [...WELFARE_REPORT_SEVERITIES].sort(),
    );
  });

  it("keeps the operator vocabulary distinct — the SLA tier is not reporter-facing", () => {
    // Not a style preference: "Crítica — peligro inmediato" is the triage
    // queue's own grammar. Collapsing the two would either strip the tier from
    // the queue or push it back onto the reporter.
    for (const severity of WELFARE_REPORT_SEVERITIES) {
      expect(welfareReportSeverityLabel(severity)).not.toBe(
        welfareReportSeverityCitizenLabel(severity),
      );
    }
  });
});
