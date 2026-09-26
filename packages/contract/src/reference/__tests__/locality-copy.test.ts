// The citizen-facing locality field says the same thing on web and app, and
// describes an alias pick the same way. The copy lives once, in
// ../locality-copy.ts; this file proves both pickers actually read it rather
// than carrying a literal of their own (the drift that let web say "Localidad
// o barrio" while the app said "Localidad").

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LOCALITY_FIELD_LABEL,
  LOCALITY_FIELD_PLACEHOLDER,
  describeChosenLocality,
  homeLocalityChipLabel,
  homeLocalityChipName,
  homeLocalityChipReason,
  localityOptionLabel,
} from "../locality-copy.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const LOMAS = {
  localityName: "Lomas de Zamora",
  provinceCode: "AR-B",
  provinceName: "Buenos Aires",
  departmentName: "Lomas de Zamora",
};

describe("locality copy", () => {
  it("names the field in the words a citizen uses", () => {
    expect(LOCALITY_FIELD_LABEL).toBe("Ciudad, pueblo o barrio");
    expect(LOCALITY_FIELD_PLACEHOLDER).toBe("Ej.: Banfield, Ramos Mejía, Villa María");
  });

  it("labels an alias row with the catalogue row it selects", () => {
    expect(localityOptionLabel({ ...LOMAS, aliasName: "Banfield" })).toBe(
      "Banfield (Lomas de Zamora)",
    );
    expect(localityOptionLabel(LOMAS)).toBe("Lomas de Zamora");
  });

  it.each([
    [{ ...LOMAS, aliasName: "Banfield" }, "Banfield · partido de Lomas de Zamora, Buenos Aires"],
    // The row IS its partido: naming the partido again says nothing.
    [LOMAS, "Lomas de Zamora · Buenos Aires"],
    [
      {
        localityName: "Villa María",
        provinceCode: "AR-X",
        provinceName: "Córdoba",
        departmentName: "General San Martín",
      },
      "Villa María · departamento General San Martín, Córdoba",
    ],
    [
      { localityName: "Palermo", provinceCode: "AR-C", provinceName: "CABA", departmentName: null },
      "Palermo · barrio de la Ciudad de Buenos Aires",
    ],
  ])("describes the chosen place %#", (row, expected) => {
    expect(describeChosenLocality(row)).toBe(expected);
  });
});

describe("home-locality suggestion chip", () => {
  it("says the action, then why, in words with no gender to guess", () => {
    expect(homeLocalityChipLabel(LOMAS)).toBe("Usar Lomas de Zamora");
    expect(homeLocalityChipReason("Pampa")).toBe("donde vive Pampa");
    expect(homeLocalityChipName(LOMAS, "Pampa")).toBe("Usar Lomas de Zamora, donde vive Pampa");
  });

  it("both surfaces build the chip from the shared copy", () => {
    for (const file of [
      "components/LocationFields.tsx",
      "apps/mobile/src/pets/LocalityPicker.tsx",
    ]) {
      expect(read(file)).toContain("homeLocalityChipName(");
    }
  });
});

describe("web and app pickers read the same copy", () => {
  const surfaces = {
    web: ["components/LocationFields.tsx", "components/LocalityPickerAcross.tsx"],
    app: ["apps/mobile/src/pets/LocalityPicker.tsx"],
  };

  it.each(Object.entries(surfaces))("%s names the field with LOCALITY_FIELD_LABEL", (_, files) => {
    const src = files.map(read).join("\n");
    expect(src).toMatch(/LOCALITY_FIELD_LABEL|LOCALITY_FIELD_PLACEHOLDER/);
    expect(src).toContain("localityOptionLabel(");
    // No literal INDEC term as the citizen field's label or placeholder.
    expect(src).not.toMatch(/label="Localidad"|l1Label = "Localidad"|"Localidad o barrio"/);
  });

  it("the app's field label is the shared constant", () => {
    expect(read("apps/mobile/src/pets/LocalityPicker.tsx")).toMatch(
      /label=\{LOCALITY_FIELD_LABEL\}/,
    );
  });

  it("the web's default field label is the shared constant", () => {
    expect(read("components/LocationFields.tsx")).toMatch(/l1Label = LOCALITY_FIELD_LABEL/);
  });
});
