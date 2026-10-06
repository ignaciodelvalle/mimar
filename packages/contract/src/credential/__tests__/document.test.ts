import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OWNER_PET_DETAIL_PAYLOAD_VERSION } from "../../api/owner-pet-detail.ts";
import {
  PUBLIC_CREDENTIAL_PAYLOAD_VERSION,
  PUBLIC_CREDENTIAL_SITUATIONS,
} from "../../api/public-credential.ts";
import {
  CREDENTIAL_CHROME,
  CREDENTIAL_DOCUMENT_LAYOUT_VERSION,
  CREDENTIAL_DOCUMENT_ON_WIRE,
  CREDENTIAL_FIELD_LABEL,
  CREDENTIAL_SITUATION_KEYS,
  CREDENTIAL_VARIANT_FOR_SURFACE,
  LANDING_DEMO_SITUATION_KEYS,
  chromeForSurface,
  credentialFieldLabel,
  emptyCredentialDocumentSlots,
  fieldSlots,
  fieldsForSurface,
  hasCredentialPoint,
  layoutVersionSupported,
  mayAnnounceSituation,
  resolveCredentialRightCell,
} from "../document.ts";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "document.ts"),
  "utf8",
);

describe("credential document slots — not a wire payload", () => {
  it("stays off the /api/v1 envelope", () => {
    expect(CREDENTIAL_DOCUMENT_ON_WIRE).toBe(false);
    expect(PUBLIC_CREDENTIAL_PAYLOAD_VERSION).toBe(1);
    expect(OWNER_PET_DETAIL_PAYLOAD_VERSION).toBe(1);
    expect(CREDENTIAL_DOCUMENT_LAYOUT_VERSION).toBe(1);
  });

  it("refuses a layout version this JS never shipped", () => {
    expect(layoutVersionSupported(1)).toBe(true);
    expect(layoutVersionSupported(2)).toBe(false);
    expect(layoutVersionSupported(0)).toBe(false);
  });

  it("does not import a native module (OTA must stay JS-only)", () => {
    expect(SOURCE).not.toMatch(/react-native|reanimated|expo-/);
  });
});

describe("surface → variant (carnet stays the landing hook)", () => {
  it("locks landing to carnet, public to the sheet, owner to libreta", () => {
    expect(CREDENTIAL_VARIANT_FOR_SURFACE).toEqual({
      landing: "carnet",
      public: "publicSheet",
      owner: "libreta",
    });
  });

  it("keeps the landing chrome a carnet, not the libreta band", () => {
    const landing = chromeForSurface("landing");
    expect(landing.subtitleFront).toBe("Credencial digital");
    expect(landing.showSituationChip).toBe(false);
    expect(CREDENTIAL_CHROME.libreta.title).toBe("Libreta Sanitaria");
    expect(chromeForSurface("public").subtitleFront).toBe("Credencial pública");
    expect(chromeForSurface("public").subtitleBack).toBe("Libreta sanitaria");
  });
});

describe("field catalogues — the same model feeds landing and /p/", () => {
  it("landing prints Raza then Microchip, never Sexo or Edad", () => {
    expect(fieldsForSurface("landing").map(credentialFieldLabel)).toEqual(["Raza", "Microchip"]);
    expect(fieldsForSurface("landing")).not.toContain("registryStatus");
  });

  // What /p/ actually draws under the identity heading since the three-level
  // card (2026-10): the page fills exactly this catalogue, so a field added
  // here widens the public page and must be a deliberate privacy decision.
  it("public prints Antirrábica, Microchip, Color in page order — nothing more", () => {
    expect(fieldsForSurface("public").map(credentialFieldLabel)).toEqual([
      "Antirrábica",
      "Microchip",
      "Color",
    ]);
    for (const retired of [
      "registryStatus",
      "vaccinationRecords",
      "tattooPresence",
      "libretaCode",
    ]) {
      expect(fieldsForSurface("public")).not.toContain(retired);
    }
  });

  it("owner has no identity-grid fields (compliance is a different panel)", () => {
    expect(fieldsForSurface("owner")).toEqual([]);
  });

  it("every catalogue id has a label", () => {
    for (const id of fieldsForSurface("public")) {
      expect(CREDENTIAL_FIELD_LABEL[id].length).toBeGreaterThan(0);
    }
  });
});

describe("situation filter — public never tints medical/household state", () => {
  it("public-safe keys match the wire subset", () => {
    expect([...PUBLIC_CREDENTIAL_SITUATIONS]).toEqual([
      "perdida",
      "custodia-oficial",
      "observacion-antirrabica",
      "fallecida",
    ]);
  });

  it("blocks treatment, pregnancy, adoption and transit on /p/", () => {
    expect(mayAnnounceSituation("public", "en-tratamiento")).toBe(false);
    expect(mayAnnounceSituation("public", "prenada")).toBe(false);
    expect(mayAnnounceSituation("public", "en-adopcion")).toBe(false);
    expect(mayAnnounceSituation("public", "en-transito")).toBe(false);
    expect(mayAnnounceSituation("public", "al-dia")).toBe(false);
    expect(mayAnnounceSituation("public", "perdida")).toBe(true);
    expect(mayAnnounceSituation("public", "custodia-oficial")).toBe(true);
  });

  it("lets the landing demo play the owner cycle, including treatment", () => {
    expect([...LANDING_DEMO_SITUATION_KEYS]).toEqual([
      "al-dia",
      "perdida",
      "observacion-antirrabica",
      "en-tratamiento",
    ]);
    expect(mayAnnounceSituation("landing", "en-tratamiento")).toBe(true);
    expect(mayAnnounceSituation("landing", "prenada")).toBe(false);
    expect(mayAnnounceSituation("owner", "prenada")).toBe(true);
    expect(mayAnnounceSituation("owner", "en-adopcion")).toBe(true);
  });

  it("every public-safe key is a product situation", () => {
    for (const key of PUBLIC_CREDENTIAL_SITUATIONS) {
      expect(CREDENTIAL_SITUATION_KEYS).toContain(key);
    }
  });
});

const POINT = { lat: -34.6037, lng: -58.3816 };

describe("hasCredentialPoint — the one finite check", () => {
  it("accepts finite numbers and numeric-column strings", () => {
    expect(hasCredentialPoint(POINT)).toBe(true);
    expect(hasCredentialPoint({ lat: "-34.6037", lng: "-58.3816" })).toBe(true);
    expect(hasCredentialPoint({ lat: 0, lng: 0 })).toBe(true);
  });

  it("refuses a missing, blank or non-finite coordinate", () => {
    expect(hasCredentialPoint(null)).toBe(false);
    expect(hasCredentialPoint(undefined)).toBe(false);
    expect(hasCredentialPoint({ lat: -34.6, lng: null })).toBe(false);
    expect(hasCredentialPoint({ lat: undefined, lng: -58.4 })).toBe(false);
    // Number("") is 0: a blank column must not become the equator.
    expect(hasCredentialPoint({ lat: "", lng: "" })).toBe(false);
    expect(hasCredentialPoint({ lat: "  ", lng: "-58.4" })).toBe(false);
    expect(hasCredentialPoint({ lat: Number.NaN, lng: -58.4 })).toBe(false);
    expect(hasCredentialPoint({ lat: -34.6, lng: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasCredentialPoint({ lat: "abc", lng: "-58.4" })).toBe(false);
  });
});

describe("right-hand cell — one rule", () => {
  it("is the QR unless the pet is deceased or lost with a disclosed point", () => {
    expect(
      resolveCredentialRightCell({
        status: "active",
        discloseLastLocation: false,
        lastLocation: null,
      }),
    ).toBe("qr");
    expect(
      resolveCredentialRightCell({
        status: "active",
        discloseLastLocation: true,
        lastLocation: POINT,
      }),
    ).toBe("qr");
    expect(
      resolveCredentialRightCell({
        status: "lost",
        discloseLastLocation: false,
        lastLocation: POINT,
      }),
    ).toBe("qr");
    expect(
      resolveCredentialRightCell({
        status: "lost",
        discloseLastLocation: true,
        lastLocation: null,
      }),
    ).toBe("qr");
  });

  it("a disclosed lost pet with a broken point stays on the QR", () => {
    expect(
      resolveCredentialRightCell({
        status: "lost",
        discloseLastLocation: true,
        lastLocation: { lat: "", lng: "" },
      }),
    ).toBe("qr");
    expect(
      resolveCredentialRightCell({
        status: "lost",
        discloseLastLocation: true,
        lastLocation: { lat: -34.6, lng: Number.NaN },
      }),
    ).toBe("qr");
  });

  it("pings only when lost, disclosed, and a coordinate exists", () => {
    expect(
      resolveCredentialRightCell({
        status: "lost",
        discloseLastLocation: true,
        lastLocation: POINT,
      }),
    ).toBe("ping");
  });

  it("drops the cell when the pet is deceased, even if a point was disclosed", () => {
    expect(
      resolveCredentialRightCell({
        status: "deceased",
        discloseLastLocation: true,
        lastLocation: POINT,
      }),
    ).toBe("none");
  });
});

describe("fieldSlots", () => {
  it("fills the surface catalogue and blanks missing values", () => {
    expect(fieldSlots("landing", { breed: "Caniche" })).toEqual([
      { id: "breed", label: "Raza", value: "Caniche" },
      { id: "microchipPresence", label: "Microchip", value: "" },
    ]);
  });
});

describe("empty slots", () => {
  it("stamps layout v1 and the surface's variant", () => {
    const slots = emptyCredentialDocumentSlots("landing");
    expect(slots.layoutVersion).toBe(1);
    expect(slots.variant).toBe("carnet");
    expect(slots.mrz).toBeNull();
    expect(slots.back).toEqual({ rows: [] });
  });

  it("gives the public sheet no back face", () => {
    expect(emptyCredentialDocumentSlots("public").back).toBeNull();
  });
});
