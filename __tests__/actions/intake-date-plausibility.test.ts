// Future-date guard on org intake (PO decision 2026-07-16 — same family as
// P4 item 1). parseIntakeForm runs BEFORE any DB or auth work, so both cases
// below return from createIntake without touching the local stack:
//   - tomorrow (AR) → rejected with the shared plausibility copy.
//   - today (AR) + an INVALID chip → the chip-format error, which proves the
//     date guard ACCEPTED the same-day value and control flow moved past it
//     (chip validation runs after the parse step).
// No mocks needed — nothing DB-reaching executes on these paths.

import { describe, expect, it } from "vitest";

import { todayIsoInAr } from "@/lib/utils/format";
import { createIntake } from "@/src/modules/pets/application/intake/create-intake";

const TODAY_AR = todayIsoInAr();
const TOMORROW_AR = (() => {
  const d = new Date(`${TODAY_AR}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

const USER = { id: "00000000-0000-0000-0000-000000000001" };
const ORG = {
  id: "00000000-0000-0000-0000-000000000002",
  displayName: "Refugio Test",
  verified: true,
};

function intakeFormData(overrides?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("name", "Sin nombre");
  fd.set("species", "dog");
  fd.set("intakeReason", "rescue");
  for (const [k, v] of Object.entries(overrides ?? {})) fd.set(k, v);
  return fd;
}

describe("createIntake — occurredAt plausibility (PO 2026-07-16)", () => {
  it("rejects tomorrow's AR date with the shared copy", async () => {
    const result = await createIntake(
      "test-org-token",
      USER,
      ORG,
      intakeFormData({ occurredAt: TOMORROW_AR }),
    );
    expect(result.error).toBe("La fecha no puede ser futura.");
  });

  it("accepts today's AR date (control flow reaches the later chip validation)", async () => {
    const result = await createIntake(
      "test-org-token",
      USER,
      ORG,
      intakeFormData({ occurredAt: TODAY_AR, microchipId: "not-a-chip" }),
    );
    expect(result.error).toBe("INVALID_MICROCHIP_FORMAT");
  });
});
