// Unit test for the hand-rolled-op-control ratchet's counter.
//
// The counter has to survive real JSX, not just the tidy single-line form: a
// className carrying `>` inside an expression, a multi-line attribute list, and
// the checkbox/radio exemption (those wear OpCheckbox's chrome, not the field
// box, and would otherwise make the baseline unreachable).

import { describe, expect, it } from "vitest";

import { countRawOpControls } from "./check-op-controls.mjs";

describe("countRawOpControls", () => {
  it("counts a hand-rolled control", () => {
    expect(
      countRawOpControls(
        '<input className="w-full border border-ln-op-line bg-ln-op-card px-3 py-2" />',
      ),
    ).toBe(1);
  });

  it("counts select and textarea too", () => {
    const src = `
      <select className="border-ln-op-line bg-ln-op-card"><option/></select>
      <textarea className="border-ln-op-line bg-ln-op-card" />
    `;
    expect(countRawOpControls(src)).toBe(2);
  });

  it("ignores controls that do not wear the op chrome", () => {
    expect(countRawOpControls('<input className="border border-ln-line" />')).toBe(0);
    expect(countRawOpControls("<input />")).toBe(0);
  });

  it("ignores the primitives' own rendering (OpInput is not <input)", () => {
    expect(countRawOpControls('<OpInput className="border-ln-op-line" />')).toBe(0);
  });

  it("exempts checkbox and radio — OpCheckbox owns that chrome", () => {
    const src = `
      <input type="checkbox" className="rounded border-ln-op-line accent-ln-op-azul" />
      <input type="radio" className="border-ln-op-line" />
    `;
    expect(countRawOpControls(src)).toBe(0);
  });

  it("does not end the tag on a > inside an expression attribute", () => {
    const src = [
      "<input",
      "  onChange={(e) => setValue(e.target.value)}",
      '  className="border-ln-op-line bg-ln-op-card"',
      "/>",
    ].join("\n");
    expect(countRawOpControls(src)).toBe(1);
  });

  it("counts each control separately in a multi-control file", () => {
    const src = `
      <input className="border-ln-op-line" />
      <div className="border-ln-op-line" />
      <textarea className="border-ln-op-line" />
    `;
    expect(countRawOpControls(src)).toBe(2);
  });
});
