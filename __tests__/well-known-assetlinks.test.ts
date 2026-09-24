// `/.well-known/assetlinks.json` — the Android App Links association.
//
// Three answers this surface has to keep straight, and the whole point of the
// tests is that they are THREE and not two:
//
//   404 — no fingerprint configured. The state of the world today, and an
//         honest statement: this host claims no app.
//   500 — a fingerprint configured but unusable. A deployment bug, which must
//         not be filed under "absent": publishing a WRONG fingerprint is worse
//         than publishing none, because Android caches the failed verification
//         and the app's links stay unverified until it is reinstalled.
//   200 — the document, with the package name the APK is actually built with.
//
// The last one is the one nobody can eyeball later: the package name and the
// build's `android.package` are the same constant from `@dim/contract/links`,
// and one character of drift silently un-verifies every link in the product.

import { existsSync, readFileSync } from "node:fs";

import { ANDROID_PACKAGE_NAME } from "@dim/contract/links";
import { describe, expect, it } from "vitest";

import {
  HANDLE_ALL_URLS,
  MalformedFingerprintError,
  assetlinksDocument,
  parseFingerprints,
} from "@/lib/infra/assetlinks";

/** A syntactically real SHA-256 certificate fingerprint (32 hex bytes). */
const FP_A = [
  "14",
  "6D",
  "E9",
  "83",
  "C5",
  "73",
  "06",
  "50",
  "D8",
  "EE",
  "B9",
  "95",
  "2F",
  "34",
  "FC",
  "64",
  "16",
  "A0",
  "83",
  "42",
  "E6",
  "1D",
  "BE",
  "A8",
  "8A",
  "04",
  "96",
  "B2",
  "3F",
  "CF",
  "44",
  "E5",
].join(":");

const FP_B = FP_A.replace(/^14/, "AB");

describe("parseFingerprints", () => {
  it("treats an unset variable as no association", () => {
    expect(parseFingerprints(undefined)).toEqual([]);
  });

  // THE EMPTY-STRING TRAP this repo has already paid for once: a variable
  // declared in CI and never filled is not nullish, so `??` would have kept it.
  it("treats a declared-but-empty variable as no association, not as a value", () => {
    expect(parseFingerprints("")).toEqual([]);
    expect(parseFingerprints("   \n ")).toEqual([]);
  });

  it("accepts one fingerprint", () => {
    expect(parseFingerprints(FP_A)).toEqual([FP_A]);
  });

  it("upper-cases what keytool may have printed in lower case", () => {
    expect(parseFingerprints(FP_A.toLowerCase())).toEqual([FP_A]);
  });

  // A real Play setup has two: the app-signing certificate Google holds and the
  // upload certificate internal-testing builds are signed with.
  it("accepts several, comma- or whitespace-separated", () => {
    expect(parseFingerprints(`${FP_A},${FP_B}`)).toEqual([FP_A, FP_B]);
    expect(parseFingerprints(`${FP_A} ${FP_B}`)).toEqual([FP_A, FP_B]);
    expect(parseFingerprints(`${FP_A},\n  ${FP_B}\n`)).toEqual([FP_A, FP_B]);
  });

  it("collapses a value pasted into both slots", () => {
    expect(parseFingerprints(`${FP_A},${FP_A}`)).toEqual([FP_A]);
  });

  it.each([
    [
      "a SHA-1 fingerprint (20 bytes, which is what older docs show)",
      FP_A.split(":").slice(0, 20).join(":"),
    ],
    ["hex with no separators", FP_A.replaceAll(":", "")],
    ["a non-hex byte", FP_A.replace("14:", "ZZ:")],
    ["something with trailing junk", `${FP_A}:00`],
    ["a quoted value", `"${FP_A}"`],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseFingerprints(raw)).toThrow(MalformedFingerprintError);
  });
});

describe("assetlinksDocument", () => {
  it("returns null when nothing is configured — the caller's 404", () => {
    expect(assetlinksDocument(undefined)).toBeNull();
  });

  it("builds the statement Android's verifier looks for", () => {
    expect(assetlinksDocument(FP_A)).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [FP_A],
        },
      },
    ]);
  });

  it("names the relation by the constant, so a typo cannot ship", () => {
    expect(HANDLE_ALL_URLS).toBe("delegate_permission/common.handle_all_urls");
  });

  it("publishes every configured fingerprint in one statement", () => {
    const doc = assetlinksDocument(`${FP_A},${FP_B}`);
    expect(doc?.[0]?.target.sha256_cert_fingerprints).toEqual([FP_A, FP_B]);
  });

  it("propagates a malformed value instead of degrading to the absent case", () => {
    expect(() => assetlinksDocument("nope")).toThrow(MalformedFingerprintError);
  });
});

// ---------------------------------------------------------------------------
// The half no unit test can assert: that the two sides of the claim agree.
// ---------------------------------------------------------------------------
describe("the package name has exactly one home", () => {
  it("is not restated in apps/mobile/app.json", () => {
    // app.config.ts sets `android.package` from `@dim/contract/links`. If the
    // literal comes back into app.json, Expo's merge order decides which one
    // wins and the answer stops being obvious to a reader.
    const appJson = readFileSync("apps/mobile/app.json", "utf8");
    expect(appJson).not.toContain(ANDROID_PACKAGE_NAME);
  });

  it("is read from the contract by the Expo config", () => {
    const config = readFileSync("apps/mobile/app.config.ts", "utf8");
    expect(config).toContain("ANDROID_PACKAGE_NAME");
    expect(config).toContain("@dim/contract/links");
  });
});

describe("the route is where the App Router will find it", () => {
  const ROUTE = "app/.well-known/assetlinks.json/route.ts";

  it("exists at the well-known path", () => {
    expect(existsSync(ROUTE)).toBe(true);
  });

  // The dot directory is skipped by TypeScript's `include` expansion, measured.
  // Without the explicit entry this file is shipped and never typechecked.
  it("is inside the typecheck program", () => {
    const tsconfig = readFileSync("tsconfig.json", "utf8");
    expect(tsconfig).toContain("app/.well-known/**/*.ts");
  });

  // Same class: `biome check .` does not traverse into it either.
  it("is inside the Biome run", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toContain("app/.well-known");
    expect(pkg.scripts.format).toContain("app/.well-known");
  });
});
