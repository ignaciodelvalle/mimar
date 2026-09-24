import { describe, expect, it } from "vitest";

import {
  ProvinceBoostParseError,
  boostedProvinceCount,
  parseProvinceBoost,
} from "./pano-province-boost";

const KNOWN = ["Buenos Aires", "CABA", "Santa Fe", "Córdoba"] as const;

describe("parseProvinceBoost", () => {
  it("returns an empty map for undefined, empty, or whitespace-only input", () => {
    expect(parseProvinceBoost(undefined, KNOWN).size).toBe(0);
    expect(parseProvinceBoost("", KNOWN).size).toBe(0);
    expect(parseProvinceBoost("   ", KNOWN).size).toBe(0);
  });

  it("parses a single entry", () => {
    const boosts = parseProvinceBoost("Buenos Aires:3", KNOWN);
    expect(boosts.size).toBe(1);
    expect(boosts.get("Buenos Aires")).toBe(3);
  });

  it("parses multiple entries with surrounding whitespace and decimal multipliers", () => {
    const boosts = parseProvinceBoost(" Buenos Aires:3 , Santa Fe : 1.5 ", KNOWN);
    expect(boosts.get("Buenos Aires")).toBe(3);
    expect(boosts.get("Santa Fe")).toBe(1.5);
    expect(boosts.size).toBe(2);
  });

  it("tolerates trailing commas", () => {
    const boosts = parseProvinceBoost("CABA:2,", KNOWN);
    expect(boosts.size).toBe(1);
    expect(boosts.get("CABA")).toBe(2);
  });

  it("fails fast on an unknown province, naming the offender", () => {
    expect(() => parseProvinceBoost("Buenos Aire:3", KNOWN)).toThrowError(ProvinceBoostParseError);
    expect(() => parseProvinceBoost("Buenos Aire:3", KNOWN)).toThrowError(/Buenos Aire/);
  });

  it("rejects entries without a colon", () => {
    expect(() => parseProvinceBoost("Buenos Aires", KNOWN)).toThrowError(ProvinceBoostParseError);
  });

  it("rejects non-numeric, empty, zero, and negative multipliers", () => {
    expect(() => parseProvinceBoost("CABA:tres", KNOWN)).toThrowError(ProvinceBoostParseError);
    expect(() => parseProvinceBoost("CABA:", KNOWN)).toThrowError(ProvinceBoostParseError);
    expect(() => parseProvinceBoost("CABA:0", KNOWN)).toThrowError(ProvinceBoostParseError);
    expect(() => parseProvinceBoost("CABA:-2", KNOWN)).toThrowError(ProvinceBoostParseError);
    expect(() => parseProvinceBoost("CABA:Infinity", KNOWN)).toThrowError(ProvinceBoostParseError);
  });

  it("rejects a province listed twice", () => {
    expect(() => parseProvinceBoost("CABA:2,CABA:3", KNOWN)).toThrowError(/more than once/);
  });
});

describe("boostedProvinceCount", () => {
  const boosts = parseProvinceBoost("Buenos Aires:3,Santa Fe:1.5", KNOWN);

  it("multiplies only the listed provinces", () => {
    expect(boostedProvinceCount(100, "Buenos Aires", boosts)).toBe(300);
    expect(boostedProvinceCount(100, "Santa Fe", boosts)).toBe(150);
    expect(boostedProvinceCount(100, "CABA", boosts)).toBe(100);
  });

  it("rounds and never drops below 1", () => {
    expect(boostedProvinceCount(3, "Santa Fe", boosts)).toBe(5); // 4.5 → round → 5 (banker-free Math.round)
    expect(boostedProvinceCount(1, "Santa Fe", parseProvinceBoost("Santa Fe:0.1", KNOWN))).toBe(1);
  });
});
