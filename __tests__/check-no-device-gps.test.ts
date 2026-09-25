// Unit test for scripts/check-no-device-gps.ts — the W8 (PO, 2026-09-24)
// "no device location anywhere, web or app" fence.
//
// Two halves. PLANTED SAMPLES prove each rule fires on the spelling it exists
// for (and stays quiet on the look-alikes it must spare) — a fence whose regex
// silently stopped matching would otherwise pass forever. The REAL SCAN runs
// against the repo tree with a non-vacuity floor, because the other way a
// fence goes blind is a glob that finds nothing.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MANIFEST_RULE,
  MIN_MOBILE_FILES,
  MIN_WEB_FILES,
  MOBILE_RULES,
  WEB_RULES,
  checkPermissionsPolicy,
  findMobileOffenses,
  findNativeLocationDependencies,
  findWebOffenses,
  scanSource,
} from "@/scripts/check-no-device-gps";

function rulesHit(src: string, rules = WEB_RULES): string[] {
  return scanSource("sample.tsx", src, rules).map((o) => o.rule);
}

describe("check-no-device-gps — planted samples fire", () => {
  it.each([
    ["dot access", "navigator.geolocation.getCurrentPosition(ok)", "navigator.geolocation"],
    ["optional chaining", "if (navigator?.geolocation) start();", "navigator.geolocation"],
    ["bracket access", 'const g = navigator["geolocation"];', "navigator.geolocation"],
    ["optional bracket", "const g = navigator?.['geolocation'];", "navigator.geolocation"],
    ["spaced dot", "navigator . geolocation", "navigator.geolocation"],
    ["destructured method", "const { getCurrentPosition } = geo;", "geolocation-api-method"],
    ["watch method", "geo.watchPosition(cb)", "geolocation-api-method"],
    ["method by string", 'geo["getCurrentPosition"](cb)', "geolocation-api-method"],
    [
      "maplibre control",
      "map.addControl(new maplibregl.GeolocateControl({}))",
      "maplibre-geolocate-control",
    ],
    [
      "permission query",
      'navigator.permissions.query({ name: "geolocation" })',
      "geolocation-permission-query",
    ],
    ["button copy", "<button>Usar mi ubicación</button>", "use-my-location-copy"],
    ["copy without accent", '"usar mi ubicacion actual"', "use-my-location-copy"],
    ["share copy", "'Compartir mi ubicación'", "use-my-location-copy"],
    ["current location copy", "`Tu ubicación actual`", "use-my-location-copy"],
  ])("%s", (_label, src, rule) => {
    expect(rulesHit(src)).toContain(rule);
  });

  it.each([
    ["import", 'import * as Location from "expo-location";'],
    ["require", "const L = require('expo-location');"],
    ["dynamic import", 'await import("expo-location")'],
    ["community module", 'import Geo from "@react-native-community/geolocation";'],
    ["service module", 'import Geo from "react-native-geolocation-service";'],
  ])("mobile module specifier: %s", (_label, src) => {
    expect(rulesHit(src, MOBILE_RULES)).toContain("native-location-module");
  });

  it("mobile also bans the polyfilled web API", () => {
    expect(rulesHit("navigator.geolocation.watchPosition(cb)", MOBILE_RULES)).toContain(
      "navigator.geolocation",
    );
  });

  it.each([
    ['"android": { "permissions": ["ACCESS_FINE_LOCATION"] }'],
    ['"ACCESS_COARSE_LOCATION"'],
    ['"NSLocationWhenInUseUsageDescription": "x"'],
  ])("manifest permission: %s", (src) => {
    expect(rulesHit(src, [MANIFEST_RULE])).toContain("os-location-permission");
  });

  it("flags a native location dependency in package.json", () => {
    const pkg = JSON.stringify({ dependencies: { "expo-location": "~18.0.0", react: "19" } });
    expect(findNativeLocationDependencies(pkg).map((o) => o.snippet)).toEqual(["expo-location"]);
  });

  it("requires Permissions-Policy to deny geolocation", () => {
    expect(
      checkPermissionsPolicy('{ key: "Permissions-Policy", value: "geolocation=(self)" }'),
    ).toHaveLength(1);
    expect(
      checkPermissionsPolicy('{ key: "Permissions-Policy", value: "camera=(self)" }'),
    ).toHaveLength(1);
    expect(
      checkPermissionsPolicy(
        '{ key: "Permissions-Policy", value: "camera=(self), geolocation=()" }',
      ),
    ).toEqual([]);
  });
});

describe("check-no-device-gps — planted look-alikes stay quiet", () => {
  it("ignores comments naming the banned API", () => {
    const src = [
      "// never navigator.geolocation.getCurrentPosition here",
      "/* no GeolocateControl, no watchPosition, no 'Usar mi ubicación' */",
      "const x = 1;",
    ].join("\n");
    expect(rulesHit(src)).toEqual([]);
  });

  it("spares the MapLibre locale keys and the legacy enum value", () => {
    const src = [
      '"GeolocateControl.FindMyLocation": "Encontrar mi ubicación",',
      'location_source: z.enum(["gps", "pin_manual", "geocodificada"]),',
      "const lastKnownLocation = null;",
    ].join("\n");
    expect(rulesHit(src)).toEqual([]);
  });

  it("reports the line of the offense in the original file", () => {
    const src = "// header\n\nconst ok = 1;\nnavigator.geolocation;\n";
    expect(scanSource("f.ts", src, WEB_RULES)[0]?.line).toBe(4);
  });
});

describe("check-no-device-gps — real tree", () => {
  it("scans a healthy-sized web corpus and finds nothing", () => {
    const { scanned, offenses } = findWebOffenses();
    expect(scanned).toBeGreaterThanOrEqual(MIN_WEB_FILES);
    expect(offenses.map((o) => `${o.file}:${o.line} [${o.rule}] ${o.snippet}`)).toEqual([]);
  });

  it("scans a healthy-sized mobile corpus and finds nothing", () => {
    const { scanned, offenses } = findMobileOffenses();
    expect(scanned).toBeGreaterThanOrEqual(MIN_MOBILE_FILES);
    expect(offenses.map((o) => `${o.file}:${o.line} [${o.rule}] ${o.snippet}`)).toEqual([]);
  });

  it("next.config.ts denies geolocation via Permissions-Policy", () => {
    expect(checkPermissionsPolicy(readFileSync("next.config.ts", "utf8"))).toEqual([]);
  });
});
