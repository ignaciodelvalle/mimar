// The PPP reminder cites only the law of the pet's own jurisdiction (surface
// audit 2026-10-07, item B): it used to cite "Ley CABA 4078 / Ley Provincial
// 14.107" to every owner in the country.

import { describe, expect, it } from "vitest";

import { pppRegistrationNotice } from "./ppp-notice";

const notice = (province: string | null, autoMarked = false) =>
  pppRegistrationNotice({ petName: "Rocco", breed: "Rottweiler", province, autoMarked });

const ALL_LAWS = /4078|14\.107|9685/g;
const lawsIn = (text: string) => text.match(ALL_LAWS) ?? [];

describe("pppRegistrationNotice", () => {
  it.each([
    ["CABA", "4078"],
    ["AR-C", "4078"],
    ["Ciudad Autónoma de Buenos Aires", "4078"],
    ["Buenos Aires", "14.107"],
    ["AR-B", "14.107"],
    ["Córdoba", "9685"],
    ["AR-X", "9685"],
  ])("%s cites only its own law (%s)", (province, law) => {
    const { title, body } = notice(province);
    expect(lawsIn(`${title} ${body}`)).toEqual([law]);
    expect(body).toContain("Rottweiler");
  });

  it.each([["Mendoza"], ["AR-M"], [null], [""], ["Narnia"]])(
    "%j gets the neutral copy with no citation",
    (province) => {
      const { title, body } = notice(province);
      expect(lawsIn(`${title} ${body}`)).toEqual([]);
      expect(body.toLowerCase()).not.toContain("ley");
      expect(body).toContain("Consultá en tu municipio");
    },
  );

  it("does not send a CABA owner to a provincial registry", () => {
    const { title, body } = notice("CABA");
    expect(`${title} ${body}`).not.toMatch(/provincial/i);
  });

  it("does not claim a registry the Córdoba law does not create", () => {
    expect(notice("Córdoba").body).not.toMatch(/registro|inscrib/i);
  });

  it("says the official mark was set automatically only at registration, in Spanish", () => {
    expect(notice("CABA", true).body).toContain("marca oficial");
    expect(notice("CABA", false).body).not.toContain("marca oficial");
    for (const province of ["CABA", "Buenos Aires", "Córdoba", "Mendoza"]) {
      const { title, body } = notice(province, true);
      expect(`${title} ${body}`).not.toMatch(/\bflag\b/i);
    }
  });

  it("falls back to 'su raza' when the breed is unknown", () => {
    const { body } = pppRegistrationNotice({
      petName: "Rocco",
      breed: null,
      province: "CABA",
      autoMarked: false,
    });
    expect(body).toContain("por su raza");
  });
});
