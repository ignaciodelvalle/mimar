// The org bite wizard's submission — what the server action receives.
//
// localidades-por-id A2 (R5 of the localities audit). `LocalityPickerAcross`
// resolves the INDEC id of the row the operator tapped, and the wizard dropped
// it: its `onSelect` kept province and name, and its hand-built FormData never
// carried `localityNameIndecId`. So an operator who picked Villa María
// (Córdoba, 14042170) out of a list that also shows Villa María (Buenos Aires)
// handed the server a NAME, and a homonym inside one province (Mechita,
// Alberti/Bragado) could not be told apart at all.

import { describe, expect, it } from "vitest";

import { type OrgBiteFields, buildOrgBiteFormData } from "./org-bite-form-data";

const BASE: OrgBiteFields = {
  clientIdempotencyKey: "key-1",
  petPublicToken: " DIM-TEST-0001 ",
  occurredAt: "2026-09-01",
  locationDescription: "",
  provinceCode: "",
  provinceName: "",
  localityName: "",
  localityIndecId: "",
  victimKind: "human",
  victimContactName: "",
  victimContactPhone: "",
  victimAgeEstimate: "",
  severity: "minor",
  injuriesSummary: "",
  vetInvolved: false,
  context: "",
  confirmObservation: true,
  point: null,
  locationSource: null,
};

describe("buildOrgBiteFormData", () => {
  it("carries the INDEC id of the row the operator picked, with its pair", () => {
    const fd = buildOrgBiteFormData({
      ...BASE,
      provinceCode: "AR-X",
      provinceName: "Córdoba",
      localityName: "Villa María",
      localityIndecId: "14042170",
    });
    expect(fd.get("provinceCode")).toBe("AR-X");
    expect(fd.get("localityName")).toBe("Villa María");
    expect(fd.get("localityNameIndecId")).toBe("14042170");
  });

  it("sends no place fields at all when nothing was picked", () => {
    const fd = buildOrgBiteFormData(BASE);
    expect(fd.has("provinceCode")).toBe(false);
    expect(fd.has("localityName")).toBe(false);
    expect(fd.has("localityNameIndecId")).toBe(false);
  });

  it("keeps the rest of the submission as it was", () => {
    const fd = buildOrgBiteFormData({
      ...BASE,
      point: { lat: -32.41, lng: -63.24 },
      locationSource: "pin_manual",
      vetInvolved: true,
    });
    expect(fd.get("petPublicToken")).toBe("DIM-TEST-0001");
    expect(fd.get("clientIdempotencyKey")).toBe("key-1");
    expect(fd.get("locationLat")).toBe("-32.41");
    expect(fd.get("locationLng")).toBe("-63.24");
    expect(fd.get("locationSource")).toBe("pin_manual");
    expect(fd.get("vetInvolved")).toBe("on");
    expect(fd.get("confirmObservation")).toBe("on");
    expect(fd.get("noRedirect")).toBe("1");
  });
});
