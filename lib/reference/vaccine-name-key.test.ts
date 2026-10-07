// One key for a vaccine name, read by both faces of the pet document (surface
// audit 2026-10-07, item A). An owner typed "Antirrabica" without the accent:
// the credential front said "Vacuna antirrábica · Declarada" while the libreta
// back said "Antirrábica · Sin confirmar", "Hay 1 vacuna registrada fuera del
// catálogo", and — because one unresolved dose was on file — "3 Sin confirmar",
// counting Séxtuple and Quíntuple that were never applied.

import { foldForSearch } from "@dim/contract/reference";
import { describe, expect, it } from "vitest";

import { computeVaccinationSummary } from "@/lib/domain/libreta-health-status";
import { type ComplianceEvent, deriveComplianceState } from "@/lib/projections/pet-compliance";
import {
  RABIES_VACCINE_NAME,
  VACCINE_CATALOG,
  findVaccineByName,
  isRabiesVaccineName,
  vaccineNameKey,
} from "@/lib/reference/lookups";

const NOW = new Date("2026-10-07T15:00:00Z");
const OWNER = "user-owner";

function ownerDose(vaccineName: string): ComplianceEvent & { id: string } {
  return {
    id: `ev-${vaccineName}`,
    eventType: "vaccination_administered",
    occurredAt: "2026-09-01T15:00:00Z",
    payload: { vaccine_name: vaccineName },
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    recordedByUserId: OWNER,
  };
}

function front(vaccineName: string) {
  const state = deriveComplianceState({
    now: NOW,
    events: [ownerDose(vaccineName)],
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
    viewerUserId: OWNER,
  });
  const card = state.cards.find((c) => c.key === "rabies");
  if (!card) throw new Error("the rabies card is always present");
  return card;
}

function back(vaccineName: string) {
  return computeVaccinationSummary([ownerDose(vaccineName)], "dog", NOW);
}

function backStatus(vaccineName: string, catalogName: string) {
  return back(vaccineName).perVaccine.find((v) => v.vaccineName === catalogName)?.status;
}

describe("vaccineNameKey", () => {
  it("is foldForSearch plus trimmed edges and collapsed inner spaces", () => {
    for (const raw of ["Antirrábica", "  Séxtuple   (DHPPi-L) ", "TRIPLE  FELINA (FVRCP)"]) {
      expect(vaccineNameKey(raw)).toBe(foldForSearch(raw).replace(/\s+/g, " ").trim());
    }
    expect(vaccineNameKey("  ANTIRRÁBICA ")).toBe("antirrabica");
    expect(vaccineNameKey("Séxtuple   (DHPPi-L)")).toBe("sextuple (dhppi-l)");
  });

  it("folds a decomposed accent the same as a precomposed one", () => {
    expect(vaccineNameKey("Antirrábica")).toBe(vaccineNameKey("Antirrábica"));
  });
});

describe("findVaccineByName — the catalog resolution", () => {
  it.each([
    "Antirrábica",
    "Antirrabica",
    "antirrabica",
    "ANTIRRÁBICA",
    "AntiRRabica",
    "  antirrábica  ",
  ])("resolves %j to the rabies entry", (raw) => {
    expect(findVaccineByName(raw)?.name).toBe(RABIES_VACCINE_NAME);
  });

  it("resolves every catalog entry from its unaccented, upper-cased spelling", () => {
    for (const def of VACCINE_CATALOG) {
      const plain = def.name.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
      expect(findVaccineByName(plain)?.name).toBe(def.name);
    }
  });

  it("stays strict otherwise: no substring, no alias the catalog does not declare", () => {
    expect(findVaccineByName("Rabia")).toBeNull();
    expect(findVaccineByName("Vacuna antirrábica")).toBeNull();
    expect(findVaccineByName("Séxtuple")).toBeNull();
    expect(findVaccineByName("   ")).toBeNull();
  });
});

describe("isRabiesVaccineName — the front's predicate contains the back's", () => {
  it("is true for every name the libreta resolves to the rabies entry", () => {
    for (const raw of ["Antirrábica", "Antirrabica", "ANTIRRÁBICA", "Antirrábica"]) {
      expect(findVaccineByName(raw)?.name).toBe(RABIES_VACCINE_NAME);
      expect(isRabiesVaccineName(raw)).toBe(true);
    }
  });

  it("keeps the composite names the credential has always read as rabies", () => {
    expect(isRabiesVaccineName("DHPP + antirrábica")).toBe(true);
    expect(isRabiesVaccineName("DHPP + ANTIRRABICA")).toBe(true);
    expect(isRabiesVaccineName("Séxtuple (DHPPi-L)")).toBe(false);
  });
});

describe("front and back agree on the same asiento", () => {
  it.each([
    "Antirrábica",
    "Antirrabica",
    "antirrabica",
    "ANTIRRÁBICA",
    "AntiRRabica",
    " antirrábica ",
  ])("%j: the front reads a declared rabies dose and the back resolves it", (raw) => {
    expect(front(raw).state).toBe("Declarada");

    const summary = back(raw);
    expect(summary.otherCount).toBe(0);
    expect(backStatus(raw, RABIES_VACCINE_NAME)).toBe("active");
  });

  it("does not count never-given core vaccines as unconfirmed once the dose resolves (the '3 Sin confirmar')", () => {
    const summary = back("Antirrabica");
    expect(summary.unconfirmed).toBe(0);
    expect(summary.missing).toBe(2);
    expect(backStatus("Antirrabica", "Séxtuple (DHPPi-L)")).toBe("missing");
    expect(backStatus("Antirrabica", "Quíntuple (DHPPi)")).toBe("missing");
  });

  // ONE rabies rule on both faces (PO decision 2026-10-07): the front's verdict
  // "a rabies dose is on file" equals the back's "the rabies entry has a dose".
  it.each([
    ["Antirrábica", true],
    ["Antirrabica", true],
    ["ANTIRRABICA", true],
    ["Rabia", true],
    ["DHPP + antirrábica", true],
    ["Séxtuple (DHPPi-L)", false],
  ])("parity for %j: front and back both say rabies=%s", (raw, isRabies) => {
    const frontHasRabies = front(raw).state !== "Sin registro";
    const rabiesStatus = backStatus(raw, RABIES_VACCINE_NAME);
    const backHasRabies = rabiesStatus !== "missing" && rabiesStatus !== "unconfirmed";
    expect(frontHasRabies).toBe(isRabies);
    expect(backHasRabies).toBe(isRabies);
  });

  it("a combined entry counts for rabies only — its other components are not inferred", () => {
    const summary = back("DHPP + antirrábica");
    expect(backStatus("DHPP + antirrábica", RABIES_VACCINE_NAME)).toBe("active");
    expect(backStatus("DHPP + antirrábica", "Séxtuple (DHPPi-L)")).toBe("missing");
    expect(backStatus("DHPP + antirrábica", "Quíntuple (DHPPi)")).toBe("missing");
    expect(summary.otherCount).toBe(0);
  });

  it("dedupes off-catalog names by the same key", () => {
    const summary = computeVaccinationSummary(
      [ownerDose("Leptospira canina"), ownerDose("LEPTOSPIRA  canina ")],
      "dog",
      NOW,
    );
    expect(summary.otherCount).toBe(1);
  });
});
