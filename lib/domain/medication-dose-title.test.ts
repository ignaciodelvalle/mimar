import { describe, expect, it } from "vitest";
import {
  drugNameFromDoseReminderTitle,
  medicationDoseReminderTitle,
} from "./medication-dose-title";

describe("medication dose reminder titles — written and read in one place", () => {
  it("round-trips the drug's name through the stored title", () => {
    const title = medicationDoseReminderTitle("Antiparasitario de amplio espectro");
    expect(title).toBe("Antiparasitario de amplio espectro – Dosis");
    expect(drugNameFromDoseReminderTitle(title)).toBe("Antiparasitario de amplio espectro");
  });

  it("reads the hyphen and em-dash variants a hand-typed title may carry", () => {
    expect(drugNameFromDoseReminderTitle("Amoxicilina - Dosis")).toBe("Amoxicilina");
    expect(drugNameFromDoseReminderTitle("Amoxicilina — Dosis")).toBe("Amoxicilina");
  });

  it("leaves a title without the suffix as it is", () => {
    expect(drugNameFromDoseReminderTitle("  Meloxicam  ")).toBe("Meloxicam");
    // "Dosis" inside the drug's own name is not the suffix.
    expect(drugNameFromDoseReminderTitle("Dosis única de Bravecto")).toBe(
      "Dosis única de Bravecto",
    );
  });

  it("never reduces a title to nothing", () => {
    expect(drugNameFromDoseReminderTitle("– Dosis")).toBe("– Dosis");
  });
});
