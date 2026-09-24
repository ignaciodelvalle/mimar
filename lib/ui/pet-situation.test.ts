import { describe, expect, it } from "vitest";

import {
  LIST_STATUS_SITUATION_ICON,
  PET_SITUATIONS,
  derivePetSituation,
} from "@/lib/ui/pet-situation";

describe("derivePetSituation", () => {
  it("defaults to al-dia (the only isDefault situation) when nothing is happening", () => {
    const sit = derivePetSituation({ status: "active" });
    expect(sit.key).toBe("al-dia");
    expect(sit.isDefault).toBe(true);
    expect(sit.tone).toBe("ok");
  });

  it("maps each real state onto its situation", () => {
    expect(derivePetSituation({ status: "deceased" }).key).toBe("fallecida");
    expect(derivePetSituation({ status: "lost" }).key).toBe("perdida");
    expect(
      derivePetSituation({ status: "active", rabiesObservationStatus: "in_progress" }).key,
    ).toBe("observacion-antirrabica");
    expect(derivePetSituation({ status: "active", inTreatment: true }).key).toBe("en-tratamiento");
    expect(derivePetSituation({ status: "active", pregnancyStatus: "in_progress" }).key).toBe(
      "prenada",
    );
    expect(derivePetSituation({ status: "active", inAdoption: true }).key).toBe("en-adopcion");
    expect(derivePetSituation({ status: "active", inTransit: true }).key).toBe("en-transito");
  });

  // 2026-08-17: an observation whose window elapsed with no professional
  // closure resolved NOTHING, so the credential must not fall back to "al día".
  it("keeps the observación skin when the window expired without a closure", () => {
    expect(
      derivePetSituation({
        status: "active",
        rabiesObservationStatus: "window_expired_unclosed",
      }).key,
    ).toBe("observacion-antirrabica");
  });

  it("drops the observación skin only once a professional actually closed it", () => {
    expect(
      derivePetSituation({ status: "active", rabiesObservationStatus: "completed_negative" })
        .isDefault,
    ).toBe(true);
  });

  it("formalizes custodia-oficial: warn-family tone, shield icon, es-AR label", () => {
    const sit = derivePetSituation({ status: "active", underOfficialCustody: true });
    expect(sit.key).toBe("custodia-oficial");
    expect(sit.label).toBe("Bajo custodia oficial");
    // PO direction: reuse the warn/amber family — no new tone token.
    expect(sit.tone).toBe("tratamiento");
    expect(sit.icon).toBe("shield");
    expect(sit.isDefault).toBe(false);
  });

  it("ranks custodia-oficial below perdida and above observación", () => {
    // Lost + custody → the more urgent PERDIDA wins the single skin (R1.3).
    expect(derivePetSituation({ status: "lost", underOfficialCustody: true }).key).toBe("perdida");
    // Custody outranks the medical-surveillance states.
    expect(
      derivePetSituation({
        status: "active",
        underOfficialCustody: true,
        rabiesObservationStatus: "in_progress",
        inTreatment: true,
      }).key,
    ).toBe("custodia-oficial");
    // Deceased is terminal — outranks custody too.
    expect(derivePetSituation({ status: "deceased", underOfficialCustody: true }).key).toBe(
      "fallecida",
    );
  });

  it("applies precedence: deceased > lost > observación > tratamiento > preñada", () => {
    // Terminal wins over everything.
    expect(
      derivePetSituation({
        status: "deceased",
        pregnancyStatus: "in_progress",
        rabiesObservationStatus: "in_progress",
      }).key,
    ).toBe("fallecida");
    // Lost + pregnant → the more urgent PERDIDA carries the single skin.
    expect(derivePetSituation({ status: "lost", pregnancyStatus: "in_progress" }).key).toBe(
      "perdida",
    );
    // Observation outranks treatment + pregnancy.
    expect(
      derivePetSituation({
        status: "active",
        rabiesObservationStatus: "in_progress",
        inTreatment: true,
        pregnancyStatus: "in_progress",
      }).key,
    ).toBe("observacion-antirrabica");
  });

  it("gives every situation a tone, a non-empty label, and an icon (never color alone)", () => {
    for (const sit of Object.values(PET_SITUATIONS)) {
      expect(sit.label.length).toBeGreaterThan(0);
      expect(sit.icon.length).toBeGreaterThan(0);
      expect(sit.tone.length).toBeGreaterThan(0);
    }
  });

  it("pairs the list flag with the SAME icon as the credential situation", () => {
    // The list-status bridge reuses the canonical situation icons so a lost pet
    // reads the same siren on its row and on its credential.
    expect(LIST_STATUS_SITUATION_ICON.lost).toBe(PET_SITUATIONS.perdida.icon);
    expect(LIST_STATUS_SITUATION_ICON.sick).toBe(PET_SITUATIONS["en-tratamiento"].icon);
    expect(LIST_STATUS_SITUATION_ICON.pregnant).toBe(PET_SITUATIONS.prenada.icon);
    expect(LIST_STATUS_SITUATION_ICON.ok).toBe(PET_SITUATIONS["al-dia"].icon);
    // `registered` is the passive base — intentionally no situation icon.
    expect(LIST_STATUS_SITUATION_ICON.registered).toBeUndefined();
  });
});
