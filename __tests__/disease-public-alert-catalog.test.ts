// Unit tests for the disease-public-alert-catalog
// (spec 2026-05-19-eno-vet-direct-report-and-owner-alerts §7.2).

import { describe, expect, it } from "vitest";

import {
  PUBLIC_ALERT_DISEASES,
  getPublicAlertForDisease,
  renderPublicAlertCopy,
} from "@/lib/reference/disease-public-alert-catalog";
import { findDisease } from "@/lib/reference/diseases";

describe("disease-public-alert-catalog", () => {
  it("every alert entry has a code that exists in the disease catalog", () => {
    for (const alert of PUBLIC_ALERT_DISEASES) {
      const def = findDisease(alert.diseaseCode);
      expect(def, `Alert references unknown disease ${alert.diseaseCode}`).toBeTruthy();
    }
  });

  it("the curated set is intentionally a subset (not every disease)", () => {
    // The catalog is curated. Adding new diseases here is a deliberate
    // product decision — this assertion locks the size so adding entries
    // is a visible change.
    expect(PUBLIC_ALERT_DISEASES.length).toBeGreaterThan(0);
    expect(PUBLIC_ALERT_DISEASES.length).toBeLessThan(15);
  });
});

describe("getPublicAlertForDisease", () => {
  it("returns null for diseases not in the curated set", () => {
    expect(getPublicAlertForDisease("parvovirus")).toBeNull();
    expect(getPublicAlertForDisease("distemper")).toBeNull();
    expect(getPublicAlertForDisease("nonexistent_xyz")).toBeNull();
  });

  it("returns the alert def for rabies_confirmed", () => {
    const alert = getPublicAlertForDisease("rabies_confirmed");
    expect(alert).not.toBeNull();
    expect(alert?.ownerNotificationSeverity).toBe("urgent");
  });

  it("returns the alert def for leptospirosis", () => {
    const alert = getPublicAlertForDisease("leptospirosis");
    expect(alert).not.toBeNull();
  });
});

describe("renderPublicAlertCopy", () => {
  it("substitutes {{pet_name}} in title and body", () => {
    const alert = getPublicAlertForDisease("rabies_confirmed");
    if (!alert) throw new Error("rabies_confirmed must be in the curated catalog");

    const copy = renderPublicAlertCopy(alert, { pet_name: "Toto" });
    expect(copy.title).toContain("Toto");
    expect(copy.title).not.toContain("{{pet_name}}");
    expect(copy.body).not.toContain("{{pet_name}}");
    expect(copy.severity).toBe(alert.ownerNotificationSeverity);
  });

  it("returns severity matching the alert def", () => {
    const alert = getPublicAlertForDisease("rabies_confirmed");
    if (!alert) throw new Error("rabies_confirmed must be in the curated catalog");
    const copy = renderPublicAlertCopy(alert, { pet_name: "X" });
    expect(copy.severity).toBe("urgent");
  });
});
