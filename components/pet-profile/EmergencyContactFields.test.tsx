// Tests for <EmergencyContactFields> — pet-document-redesign ADR-13
// (Phase 5). Pattern: react-dom/server renderToStaticMarkup (repo
// convention — no jsdom); this component has no internal state (fully
// controlled), so static markup fully covers its render contract.
//
// wave-3 D1: field ids are now LnField's own generated ids (useId()), not
// the fixed "preferredVetName" etc. literals — assertions below check
// label text + input count instead of hardcoded ids (verified no external
// code referenced the old literal ids before this migration).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmergencyContactFields } from "./EmergencyContactFields";

const EMPTY_VALUES = {
  preferredVetName: "",
  preferredVetPhone: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
};

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("<EmergencyContactFields> — framed (default, EditProfileForm host)", () => {
  it("renders the fieldset/legend + all 4 labeled LnField inputs", () => {
    const html = renderToStaticMarkup(
      <EmergencyContactFields values={EMPTY_VALUES} onChange={() => {}} />,
    );
    expect(html).toContain("<fieldset");
    expect(html).toContain("Contactos para emergencias");
    expect(html).toContain("Veterinario/a de cabecera");
    expect(html).toContain("Teléfono del vet");
    expect(html).toContain("Contacto de emergencia");
    expect(html).toContain("Teléfono del contacto");
    // 4 LnField-wrapped inputs, each with a matching htmlFor/id pair.
    expect(countOccurrences(html, "<input")).toBe(4);
    expect(countOccurrences(html, "opcional")).toBe(4);
  });

  it("prefills every field from `values`", () => {
    const html = renderToStaticMarkup(
      <EmergencyContactFields
        values={{
          preferredVetName: "Dra. Pérez",
          preferredVetPhone: "+54 9 11 1111-1111",
          emergencyContactName: "Lucía F.",
          emergencyContactPhone: "+54 9 11 2222-2222",
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('value="Dra. Pérez"');
    expect(html).toContain('value="+54 9 11 1111-1111"');
    expect(html).toContain('value="Lucía F."');
    expect(html).toContain('value="+54 9 11 2222-2222"');
  });

  it("shows the AR-phone format warning for an unusual phone value", () => {
    const html = renderToStaticMarkup(
      <EmergencyContactFields
        values={{ ...EMPTY_VALUES, preferredVetPhone: "not-a-phone" }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Formato inusual para Argentina");
  });
});

describe("<EmergencyContactFields> — framed=false (EmergencyContactSheet host)", () => {
  it("renders the 4 inputs WITHOUT the fieldset/legend/intro copy", () => {
    const html = renderToStaticMarkup(
      <EmergencyContactFields values={EMPTY_VALUES} onChange={() => {}} framed={false} />,
    );
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain("Contactos para emergencias");
    expect(html).toContain("Veterinario/a de cabecera");
    expect(html).toContain("Teléfono del contacto");
    expect(countOccurrences(html, "<input")).toBe(4);
  });
});
