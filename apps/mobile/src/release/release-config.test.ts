// The release plumbing, held to the decisions that produced it.
//
// WHY THESE ARE TESTS AND NOT A PARAGRAPH IN A DOCUMENT
// ---------------------------------------------------------------------------
// `eas.json`, the `updates` block in `app.config.ts` and the three asset files
// are configuration nobody in this repo can execute. That was literally true
// when this file was written; on 2026-08-26 the first production build ran, and
// ERRORED after fifteen minutes on three separate configuration faults nothing
// here could see (docs/mobile/eas-build-profiles.md, "Two ways to break a
// fingerprint"). No update and no store upload has still ever read any of it.
// The next time these files are exercised for real, they will be exercised by a
// machine that produces an artifact for twelve testers or for Play — which is
// the worst possible place to discover that a value drifted.
//
// So each assertion below stands in for a consequence that has no other alarm:
//
//   · a projectId that disagrees with itself → an app that polls an update
//     server for a project that does not exist, silently, forever;
//   · `appVersionSource` flipped back to `local` → two builds sharing a
//     versionCode and one of them permanently unpublishable;
//   · a channel renamed → a preview hotfix reaching production installs, or
//     reaching nobody;
//   · an `.aab` in the `preview` profile → a file twelve testers cannot open;
//   · an alpha channel in the app icon → an App Store Connect rejection at the
//     end of the release, not the start of it.
//
// None of these is caught by tsc (JSON and hex strings are not types), by
// `expo config` (it proves the file LOADS, not that the values are right), or
// by Metro (it never opens eas.json). This file is the only thing that looks.
//
// TWO READING STRATEGIES, AND THE SPLIT IS DELIBERATE. `eas.json`, `app.json`
// and the three PNGs are read as BYTES FROM DISK, because bytes on disk are
// exactly what EAS and the stores consume — a test that imported them as
// modules could pass against a shape TypeScript invented. `app.config.ts` is
// the opposite case: it is a FUNCTION, its output is what Expo actually uses,
// and reading it as text would assert against source rather than against the
// config. So it is imported and called, with app.json's block as its input,
// which is also how `expo config` reaches it.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "@jest/globals";
import type { ConfigContext, ExpoConfig } from "expo/config";

import appConfigFactory from "../../app.config";

const MOBILE_ROOT = path.resolve(__dirname, "..", "..");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(MOBILE_ROOT, relative), "utf8"));
}

const easJson = readJson("eas.json") as {
  cli: { appVersionSource: string; version: string };
  build: Record<
    string,
    {
      channel?: string;
      distribution?: string;
      developmentClient?: boolean;
      autoIncrement?: boolean;
      android?: { buildType?: string };
      env?: Record<string, string>;
    }
  >;
};

const packageJson = readJson("package.json") as {
  scripts: Record<string, string | undefined>;
  dependencies: Record<string, string | undefined>;
  devDependencies?: Record<string, string | undefined>;
};

const appJson = readJson("app.json") as { expo: ExpoConfig };

/**
 * The config `expo` would resolve, produced by calling the real factory.
 *
 * Not the plugin-resolved config — `expo-router` and `expo-splash-screen` never
 * run here — which is fine, because everything asserted below is written by the
 * factory itself or restated from app.json.
 */
const resolved: ExpoConfig = appConfigFactory({
  projectRoot: MOBILE_ROOT,
  config: appJson.expo,
} as ConfigContext);

describe("EAS build profiles", () => {
  it("owns the version counter remotely", () => {
    // The whole argument is in docs/mobile/eas-build-profiles.md. The short
    // version: `local` puts a monotonic counter in a file, this repo runs
    // parallel writers in git worktrees, and two worktrees at the same base
    // commit hold the same number. Play burns a versionCode on first upload and
    // never gives it back.
    expect(easJson.cli.appVersionSource).toBe("remote");
  });

  it("declares the three profiles the release path needs", () => {
    expect(Object.keys(easJson.build).sort()).toEqual(["development", "preview", "production"]);
  });

  it.each(["development", "preview", "production"])(
    "names %s's channel after the profile itself",
    (profile) => {
      // docs/mobile/ota-policy.md's channel table assumes this 1:1 mapping, and
      // it is what keeps `eas update --channel preview` away from a production
      // install. A rename on one side and not the other is invisible until a
      // hotfix lands on the wrong fleet.
      expect(easJson.build[profile]?.channel).toBe(profile);
    },
  );

  it("gives the testers a file their phones can install", () => {
    // An .aab is a publishing container Google's servers split into per-device
    // APKs at download time. Handing one to a tester hands them a file their
    // phone cannot open — which is a failure discovered by twelve people at
    // once, not by CI.
    expect(easJson.build.development?.android?.buildType).toBe("apk");
    expect(easJson.build.preview?.android?.buildType).toBe("apk");
    expect(easJson.build.development?.distribution).toBe("internal");
    expect(easJson.build.preview?.distribution).toBe("internal");
  });

  it("ships Play the only format Play accepts", () => {
    expect(easJson.build.production?.android?.buildType).toBe("app-bundle");
    expect(easJson.build.production?.distribution).toBe("store");
    expect(easJson.build.production?.autoIncrement).toBe(true);
  });
});

describe("EAS build profile env", () => {
  // WHY THIS LIVES IN eas.json AND NOT ONLY IN config/api.ts's FALLBACKS.
  // Expo inlines EXPO_PUBLIC_* at bundle time, and an EAS build sets
  // process.env from the profile's `env` block before that inlining runs —
  // so a value missing or wrong here is baked into the binary permanently,
  // unlike a runtime misconfiguration a person can still correct.
  //
  // THE ANON KEY IS DELIBERATELY ABSENT FROM THIS FILE. config/api.ts reads
  // it as EXPO_PUBLIC_SUPABASE_ANON_KEY, but it is set as an EAS environment
  // variable (created 2026-08-27), not a value in this committed JSON — a
  // key belongs in EAS's own store, not in git history. The exact-key-set
  // assertion below is what would catch it landing here by accident.

  it.each(["development", "preview", "production"])(
    "names exactly the two vars config/api.ts reads, on %s",
    (profile) => {
      const env = easJson.build[profile]?.env ?? {};
      expect(Object.keys(env).sort()).toEqual([
        "EXPO_PUBLIC_API_BASE_URL",
        "EXPO_PUBLIC_SUPABASE_URL",
      ]);
    },
  );

  it("points production at a real domain, never staging's default or a preview host", () => {
    // The staging URL is config/api.ts's OWN fallback for a build with no env
    // at all — asserting production differs from it is what catches a
    // profile block copy-pasted from development/preview with the value
    // never swapped in.
    const productionApi = easJson.build.production?.env?.EXPO_PUBLIC_API_BASE_URL;
    expect(productionApi).not.toBe("https://dim-staging.vercel.app");
    expect(productionApi).not.toMatch(/\.vercel\.app$/);
  });

  it("pairs production's API origin with the ONE live Supabase project — the pilot's deliberate topology", () => {
    // DECIDED 2026-09-02, and it looks wrong on purpose, so it is pinned here
    // rather than left to be "fixed" by the next reader of eas.json.
    //
    // `production` points EXPO_PUBLIC_API_BASE_URL at www.mimar.com.ar while
    // EXPO_PUBLIC_SUPABASE_URL still names the Supabase project labelled
    // "DIM-staging" in the dashboard. That is not a copy-paste left over from
    // the preview profile: the pilot has exactly ONE live Supabase project, and
    // the web deployment serving www.mimar.com.ar uses that same project. A
    // store build pointed at a second, empty database would be the actual
    // defect — the phone would authenticate against a project holding none of
    // the pilot's pets. The project's NAME is a historical label, not a
    // statement about which environment it serves.
    //
    // JSON carries no comments, which is why the pairing is recorded here.
    //
    // Splitting the pilot onto a dedicated production Supabase project is a PO
    // decision, not a cleanup: it needs a data migration and a cutover, and it
    // must change eas.json and THIS TEST in the same commit. A change to one
    // without the other is the thing this assertion exists to stop.
    //
    // Hosts only — no key is named here, and the anon key is deliberately not
    // in this file at all (see the block comment above).
    const production = easJson.build.production?.env ?? {};
    expect(production.EXPO_PUBLIC_API_BASE_URL).toBe("https://www.mimar.com.ar");
    expect(production.EXPO_PUBLIC_SUPABASE_URL).toBe("https://agnwyifsdxxoznodutgq.supabase.co");
    // The same project answers development and preview. If these ever diverge
    // from production's, the single-live-database premise above is gone and the
    // comment is stale.
    expect(easJson.build.development?.env?.EXPO_PUBLIC_SUPABASE_URL).toBe(
      production.EXPO_PUBLIC_SUPABASE_URL,
    );
    expect(easJson.build.preview?.env?.EXPO_PUBLIC_SUPABASE_URL).toBe(
      production.EXPO_PUBLIC_SUPABASE_URL,
    );
  });

  it("carries only https:// URLs in every profile's env", () => {
    for (const profile of ["development", "preview", "production"]) {
      const env = easJson.build[profile]?.env ?? {};
      for (const value of Object.values(env)) {
        expect(value).toMatch(/^https:\/\//);
      }
    }
  });

  it("never names an env var that reads as a credential — those stay EAS environment variables, not committed JSON", () => {
    const forbidden = /key|secret|token|dsn/i;
    for (const profile of ["development", "preview", "production"]) {
      const env = easJson.build[profile]?.env ?? {};
      for (const name of Object.keys(env)) {
        expect(name).not.toMatch(forbidden);
      }
    }
  });
});

describe("development client", () => {
  it("is a real dependency and not just a flag on a script", () => {
    // `expo start --dev-client` was in package.json BEFORE expo-dev-client was
    // installed — a script that told the PO to scan a QR with an app nothing in
    // this repo could build. The two halves are asserted together because
    // either one alone is the aspirational state.
    expect(packageJson.dependencies["expo-dev-client"]).toBeDefined();
    expect(packageJson.scripts.start).toContain("--dev-client");
    expect(easJson.build.development?.developmentClient).toBe(true);
  });
});

describe("expo-updates", () => {
  it("points the update server at the same project the build belongs to", () => {
    // The project id is written twice in app.config.ts — once as
    // `extra.eas.projectId`, which is what `eas build` reads to identify the
    // project, and once inside `updates.url`, which is what the INSTALLED APP
    // polls. A copy-paste drift between them produces an app that checks a
    // project that does not exist and reports nothing: no crash, no log, no
    // hotfix, ever.
    const projectId = (resolved.extra as { eas?: { projectId?: string } } | undefined)?.eas
      ?.projectId;

    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it("fences native changes out of the air with the fingerprint policy", () => {
    // This is the one part of the hotfix-only policy that is a MECHANISM.
    // `fingerprint` hashes what determines the native runtime, so an update
    // carrying a native change is published under a runtime version no
    // installed build has and reaches zero devices. Flip this to `appVersion`
    // and reason 1 of docs/mobile/ota-policy.md silently stops being enforced —
    // the document stays true and the system stops implementing it.
    expect(resolved.runtimeVersion).toEqual({ policy: "fingerprint" });
  });

  it("never blocks a cold start on the update server", () => {
    // Anything above 0 taxes 100% of launches — including every launch on the
    // waiting-room 4G this app is used on — to make a rare hotfix arrive one
    // launch sooner.
    expect(resolved.updates?.fallbackToCacheTimeout).toBe(0);
    expect(resolved.updates?.enabled).toBe(true);
  });

  it("declares exactly four keys, and no channel among them", () => {
    // A channel pinned in the app config would apply to EVERY build and
    // collapse the separation eas.json's per-profile channels exist to create —
    // a preview hotfix would reach production installs.
    //
    // Asserted as an exact key set rather than as four absences: the failure
    // this guards against is a key ARRIVING (a well-meaning
    // `requestHeaders: { "expo-channel-name": … }`, a `codeSigningCertificate`
    // nobody generated), and a list of things that must not be there can only
    // ever catch the ones somebody thought of.
    expect(Object.keys(resolved.updates ?? {}).sort()).toEqual([
      "checkAutomatically",
      "enabled",
      "fallbackToCacheTimeout",
      "url",
    ]);
  });
});

/**
 * Minimal PNG header reader — 8-byte signature, then the IHDR chunk.
 *
 * Hand-rolled rather than pulled from a dependency because it is nine bytes at
 * fixed offsets and the alternative is adding an image library to a React
 * Native app's test-time graph to read them.
 *
 * Colour type lives at offset 25. Bit 2 (value 4) is the alpha bit: 6 is RGBA,
 * 4 is grey+alpha, 2 is RGB, 0 is grey, 3 is palette.
 */
function readPng(relative: string): { width: number; height: number; hasAlpha: boolean } {
  const bytes = readFileSync(path.join(MOBILE_ROOT, relative));
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${relative} is not a PNG (signature ${signature})`);
  }
  const colourType = bytes.readUInt8(25);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    hasAlpha: (colourType & 4) !== 0 || colourType === 3,
  };
}

/** PNG's Paeth predictor (filter type 4), verbatim from the spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * One filtered byte, reconstructed from its three neighbours.
 *
 * `a` is the byte one pixel to the left, `b` the one directly above, `c` the
 * one above-left — zero when off the edge of the image, per the spec.
 */
function unfilterByte(filter: number, value: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return value;
    case 1:
      return value + a;
    case 2:
      return value + b;
    case 3:
      return value + ((a + b) >> 1);
    case 4:
      return value + paeth(a, b, c);
    default:
      throw new Error(`unknown PNG filter type ${filter}`);
  }
}

/**
 * Walk the chunk list for the header and the concatenated pixel data.
 *
 * Refuses anything that is not what this repo's generator writes rather than
 * growing a decoder for cases no file here will ever be in: palettes, 16-bit
 * samples and Adam7 interlacing would each need their own reconstruction path,
 * and a wrong answer from a half-implemented one is worse than a throw.
 */
function readPngChunks(
  bytes: Buffer,
  label: string,
): { width: number; height: number; pixels: Buffer } {
  let cursor = 8; // past the signature
  let header: { width: number; height: number } | null = null;
  const pixelChunks: Buffer[] = [];

  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const kind = bytes.subarray(cursor + 4, cursor + 8).toString("ascii");
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);

    if (kind === "IHDR") {
      const bitDepth = data.readUInt8(8);
      const colourType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(
          `${label}: expected 8-bit non-interlaced RGBA, got bitDepth=${bitDepth} ` +
            `colourType=${colourType} interlace=${interlace}`,
        );
      }
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
    } else if (kind === "IDAT") {
      pixelChunks.push(Buffer.from(data));
    } else if (kind === "IEND") {
      break;
    }

    cursor += 12 + length; // length + type + data + crc
  }

  if (!header) throw new Error(`${label}: no IHDR chunk`);
  return { ...header, pixels: Buffer.concat(pixelChunks) };
}

/**
 * Inflate and un-filter into a flat RGBA buffer.
 *
 * Each scanline is prefixed with its filter type and predicted from the bytes
 * to its left, above, and above-left — so the reconstruction has to run in
 * order and read its own output as it goes.
 */
function decodeRgba(pixels: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const filtered = inflateSync(pixels);
  const raw = Buffer.alloc(height * stride);

  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[read] ?? 0;
    read += 1;
    const row = y * stride;
    const previous = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (raw[row + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (raw[previous + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (raw[previous + x - bpp] ?? 0) : 0;
      raw[row + x] = unfilterByte(filter, filtered[read + x] ?? 0, a, b, c) & 0xff;
    }
    read += stride;
  }
  return raw;
}

/**
 * The bounding box of everything actually PAINTED in an RGBA PNG.
 *
 * WHY THIS EXISTS RATHER THAN A CONSTANT
 * -------------------------------------------------------------------------
 * The two assertions it serves — "the adaptive foreground survives Android's
 * mask" and "the splash is a tight crop" — are about the ARTWORK, and the
 * artwork's extent is not the file's dimensions. The mark is a fingerprint oval
 * with transparent corners composited onto a larger transparent canvas, so the
 * canvas size says nothing about how much of it is ink. Asserting the number
 * the generator was told to use would be two constants agreeing with each other
 * while the picture drifted anywhere it liked.
 *
 * WHY IT IS HAND-ROLLED
 * -------------------------------------------------------------------------
 * `sharp` would answer this in one call and is already a dependency — of the
 * WEB app, at the repo root. Pulling a native image library into a React Native
 * package's test graph to read an alpha channel is a bad trade; the whole
 * decoder is fifty lines because the files it reads are 8-bit, non-interlaced
 * RGBA written by one known generator, and it refuses loudly on anything else
 * rather than guessing.
 */
function inkBounds(relative: string): {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Distance from the CANVAS centre to the farthest inked pixel, in pixels.
   *
   * The bounding box cannot answer the question Android actually asks. Every
   * OEM mask is a CLOSED CURVE — circle, squircle, teardrop — and the 66.6%
   * guarantee is a DIAMETER, so what has to fit is a radius. A box is a
   * conservative under-estimate of a radius on one hand (its corners may be
   * empty) and a dangerous over-estimate on the other (a box entirely inside
   * 0.666 in both dimensions still pokes out of the circle at its corners).
   *
   * Measured against the mark this file guarded until 2026-09-03: its ink box
   * was 588x427 of 1024, comfortably under 0.666 on both axes, with a box
   * half-diagonal of 363px — a diameter of 0.71 — so a BOX assertion of this
   * shape alone could pass a mark whose corners sit outside the circle. That
   * mark's own ink never did: its measured max radius was 299.5px, 0.2925 of
   * the canvas, inside both the 0.333 guarantee and the 0.3056 keyline below.
   * This is a forward guard against a square-cornered mark this file has
   * never shipped, not a defect the box assertion let through.
   */
  maxRadius: number;
} {
  const BPP = 4;
  const bytes = readFileSync(path.join(MOBILE_ROOT, relative));
  const { width, height, pixels } = readPngChunks(bytes, relative);
  const raw = decodeRgba(pixels, width, height, BPP);
  const stride = width * BPP;

  // The box AND the radius in ONE walk over the pixels. Threshold at 8/255
  // rather than 0 so the resampler's faintest anti-aliased fringe does not
  // count as ink and inflate every measurement.
  //
  // WRITTEN AS Math.min/Math.max RATHER THAN AS FIVE NESTED `if`s, which is not
  // a style preference: the `if` form scored 28 on biome's cognitive-complexity
  // rule (max 25) because every comparison sits two loops deep and each nested
  // branch is charged for its depth. The extremes are what this function is FOR,
  // so the fix is to say "extremes" instead of branching five times to compute
  // them. Same walk, same threshold, same numbers.
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const extremes = { left: width, right: -1, top: height, bottom: -1, maxRadiusSq: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((raw[y * stride + x * BPP + 3] ?? 0) <= 8) continue;
      extremes.left = Math.min(extremes.left, x);
      extremes.right = Math.max(extremes.right, x);
      extremes.top = Math.min(extremes.top, y);
      extremes.bottom = Math.max(extremes.bottom, y);
      extremes.maxRadiusSq = Math.max(extremes.maxRadiusSq, (x - cx) ** 2 + (y - cy) ** 2);
    }
  }

  if (extremes.right < 0) throw new Error(`${relative}: fully transparent — nothing is painted`);
  return {
    left: extremes.left,
    top: extremes.top,
    width: extremes.right - extremes.left + 1,
    height: extremes.bottom - extremes.top + 1,
    maxRadius: Math.sqrt(extremes.maxRadiusSq),
  };
}

/**
 * Walk the chunk list for an OPAQUE PNG — colour type 2 (RGB, no alpha).
 *
 * A near-duplicate of readPngChunks() above rather than a shared parameter,
 * on purpose: colour type is exactly the fact this repo's generator uses to
 * MEAN something. Colour type 6 (RGBA) is what adaptive-icon-foreground.png
 * and splash-icon.png carry, on purpose, because they composite onto
 * whatever sits behind them. Colour type 2 is Play's requirement for the
 * feature graphic — no alpha channel, full stop — satisfied by
 * build-mobile-app-icons.ts flattening the mark onto paper and calling
 * `removeAlpha()`. A reader that accepted either type without distinguishing
 * them would blur that requirement back into "a PNG, channel count not
 * asserted", which is the exact class of drift the rest of this file exists
 * to catch elsewhere (see "ships an app icon with NO alpha channel" above).
 */
function readPngChunksRgb(
  bytes: Buffer,
  label: string,
): { width: number; height: number; pixels: Buffer } {
  let cursor = 8; // past the signature
  let header: { width: number; height: number } | null = null;
  const pixelChunks: Buffer[] = [];

  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const kind = bytes.subarray(cursor + 4, cursor + 8).toString("ascii");
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);

    if (kind === "IHDR") {
      const bitDepth = data.readUInt8(8);
      const colourType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8 || colourType !== 2 || interlace !== 0) {
        throw new Error(
          `${label}: expected 8-bit non-interlaced RGB (no alpha), got bitDepth=${bitDepth} ` +
            `colourType=${colourType} interlace=${interlace}`,
        );
      }
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4) };
    } else if (kind === "IDAT") {
      pixelChunks.push(Buffer.from(data));
    } else if (kind === "IEND") {
      break;
    }

    cursor += 12 + length; // length + type + data + crc
  }

  if (!header) throw new Error(`${label}: no IHDR chunk`);
  return { ...header, pixels: Buffer.concat(pixelChunks) };
}

/**
 * The bounding box of everything actually INK-COLOURED in an opaque RGB PNG.
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM inkBounds() ABOVE, NOT A REUSE OF IT
 * -------------------------------------------------------------------------
 * inkBounds() finds ink by ALPHA — a pixel counts if it is not transparent.
 * That is the right test for the three RGBA outputs, whose canvas IS
 * transparent everywhere the mark is not. feature-graphic.png cannot be
 * measured that way: Play requires it opaque, so every pixel in the file —
 * paper and mark alike — carries alpha 255 by construction. Running
 * inkBounds()'s threshold over this file would call the ENTIRE 1024×500
 * canvas "ink" (or throw, since the file has no alpha channel to read at
 * all) — a vacuous pass wearing a different disguise than a 1×1 dot, and
 * exactly the trap a fence tuned for the square, transparent assets falls
 * into on the one landscape, opaque asset in the set.
 *
 * So presence is measured by COLOUR DISTANCE from the paper ground instead: a
 * pixel counts as ink if any channel differs from `#fbfaf5` by more than the
 * threshold. The mark is pure black ink on cream paper, so real ink sits far
 * past this threshold and only the resampler's anti-aliased fringe sits near
 * it.
 */
/** How far an RGB triple sits from the paper ground, in the worst single channel. */
function colourDistance(
  r: number,
  g: number,
  b: number,
  background: { r: number; g: number; b: number },
): number {
  return Math.max(
    Math.abs(r - background.r),
    Math.abs(g - background.g),
    Math.abs(b - background.b),
  );
}

function inkBoundsOpaque(
  relative: string,
  background: { r: number; g: number; b: number },
): { left: number; top: number; width: number; height: number } {
  const BPP = 3;
  const THRESHOLD = 24; // out of 255 — comfortably past anti-aliasing, far short of black-on-cream contrast.
  const bytes = readFileSync(path.join(MOBILE_ROOT, relative));
  const { width, height, pixels } = readPngChunksRgb(bytes, relative);
  const raw = decodeRgba(pixels, width, height, BPP);
  const stride = width * BPP;

  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * BPP;
      const isInk =
        colourDistance(raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0, background) > THRESHOLD;
      if (!isInk) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0) throw new Error(`${relative}: no pixel differs from the paper ground — no ink`);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

describe("app identity assets", () => {
  it("declares the icon app.json points at, at store size", () => {
    expect(appJson.expo.icon).toBe("./assets/icon.png");
    const icon = readPng("assets/icon.png");
    expect(icon).toMatchObject({ width: 1024, height: 1024 });
  });

  it("ships an app icon with NO alpha channel", () => {
    // App Store Connect rejects an icon that HAS an alpha channel. It does not
    // check whether every pixel in it happens to be opaque, which is exactly
    // what compositing the mark over a solid ground produces — so
    // scripts/build-mobile-app-icons.ts calls removeAlpha() and this asserts it
    // stayed called. The rejection would otherwise land at the end of a release.
    expect(readPng("assets/icon.png").hasAlpha).toBe(false);
  });

  it("keeps the INKED adaptive foreground inside Android's safe zone", () => {
    const adaptive = appJson.expo.android?.adaptiveIcon;
    expect(adaptive?.foregroundImage).toBe("./assets/adaptive-icon-foreground.png");
    // The background is a flat paper fill rather than a second PNG — see the
    // header of scripts/build-mobile-app-icons.ts.
    expect(adaptive?.backgroundColor).toBe("#fbfaf5");

    const layer = readPng("assets/adaptive-icon-foreground.png");
    expect(layer).toMatchObject({ width: 1024, height: 1024, hasAlpha: true });

    // THE ASSERTION IS ON THE PIXELS, not on a constant restated from the
    // generator. Only the centre 66.6% of an adaptive layer is guaranteed to
    // survive every OEM mask — circle, squircle, teardrop — and what has to fit
    // inside it is the INK, which is not the same as the canvas the generator
    // composited onto. Comparing 588/1024 here would have been two constants
    // agreeing with each other while the actual artwork drifted anywhere it
    // liked.
    const ink = inkBounds("assets/adaptive-icon-foreground.png");
    expect(ink.width / layer.width).toBeLessThan(0.666);
    expect(ink.height / layer.height).toBeLessThan(0.666);

    // AND THE RADIUS, which is the assertion the box could not make. Every OEM
    // mask is a closed curve and 66.6% is a DIAMETER, so the real constraint is
    // that no inked pixel sits farther than 0.333 x canvas from the centre. The
    // two box assertions above are necessary and NOT sufficient: a box under
    // 0.666 on both axes still pokes out of the circle at its own corners.
    //
    // THE BOX ALONE CANNOT PROVE THIS SAFE, though it never let a real defect
    // through: the mark this file guarded until 2026-09-03 had an ink box of
    // 588x427 — green on both lines above — with a half-diagonal of 363px, a
    // diameter of 0.71. A box that shape COULD wrap a mark whose corners sit
    // outside the circle. Measured with this file's own predicate, though,
    // that mark's ink never did — max radius 299.5px, 0.2925 of the canvas,
    // inside both circles below. This is a forward guard against a
    // square-cornered mark, not a defect it caught retroactively.
    //
    // TWO CIRCLES, AND THEY ARE NOT THE SAME PROMISE. 72dp of the 108dp layer
    // (radius 0.333) is what Android GUARANTEES survives every OEM mask; the
    // 66dp content keyline (radius 33/108 = 0.3056) is what Google RECOMMENDS
    // for content, and it is the tighter of the two. Both are asserted, because
    // a change that keeps the guarantee while crossing the recommendation is a
    // real regression that a single line cannot report.
    expect(ink.maxRadius / layer.width).toBeLessThan(0.333);
    expect(ink.maxRadius / layer.width).toBeLessThan(33 / 108);

    // WHAT BUYS THE MARGIN IS THE RATIO, NOT THE CHAMFER — an earlier version
    // of this comment credited the geometry and was wrong about which number
    // was doing the work. The chamfer sets the CONSTANT (a square's corner sits
    // at 1.414 x its half-width; cutting it at 45 degrees brings the plaque's
    // circumradius down to 0.5667 x its ink width) but the ratio sets the SCALE,
    // and the scale is where the air came from:
    //
    //   0.574 ink → circumradius 32.98dp of 108 → 0.86dp inside the 72dp mask,
    //                                             2.14dp OUTSIDE the 66dp keyline
    //   0.530 ink → circumradius 32.45dp of 108 → 3.55dp inside the mask,
    //                                             0.55dp inside the keyline
    //
    // Same chamfered mark in both rows. It passed by less than a dp, and it
    // failed the recommendation outright, until RATIO_MASKABLE moved.
    // Non-vacuity for the radius too — a centred dot satisfies the lines above.
    expect(ink.maxRadius / layer.width).toBeGreaterThan(0.25);

    // The non-vacuity floor. Without it, a 1×1 dot in the middle of a
    // transparent canvas — or a fully transparent file — satisfies every
    // assertion above and this test goes green on an invisible launcher icon.
    expect(ink.width / layer.width).toBeGreaterThan(0.4);

    // And it must be CENTRED, or "inside the safe zone" is being bought by
    // symmetry the mask does not provide. Both margins within a few pixels of
    // each other; 8 is generous for a rounding difference and far too tight for
    // a mark that slid.
    const leftMargin = ink.left;
    const rightMargin = layer.width - (ink.left + ink.width);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(8);
  });

  it("splashes with the same mark, not a second one", () => {
    const splash = readPng("assets/splash-icon.png");
    expect(splash.hasAlpha).toBe(true);

    // BIG ENOUGH FOR THE DENSEST SCREEN, which is a FLOOR and used to be a
    // ceiling. The old line was `expect(splash.width).toBeLessThan(610)` with a
    // comment about the source mark being 637x463 with 610x443 of ink — a
    // raster-era guard against UPSCALING a photographic scan. The source is a
    // vector now (public/logo-mimar-mark.svg, rasterised at density 1536 to a
    // 1921px master), so no output can be an upscale and there is nothing left
    // for a ceiling to protect.
    //
    // The live risk runs the other way. expo-splash-screen renders this file at
    // `imageWidth` DP; xxxhdpi — every recent flagship — is 4x, so anything
    // under imageWidth × 4 physical pixels is blown up by the OS on the first
    // screen of the app. The old 588px file was being upscaled 1.36x there and
    // the retired ceiling was the reason it could not grow.
    //
    // Read from app.json rather than restated, so changing imageWidth moves this
    // floor with it instead of silently invalidating it.
    const plugins = appJson.expo.plugins ?? [];
    const splashOptions = plugins.find(
      (entry): entry is [string, Record<string, unknown>] =>
        Array.isArray(entry) && entry[0] === "expo-splash-screen",
    )?.[1];
    const imageWidthDp = splashOptions?.imageWidth;
    expect(typeof imageWidthDp).toBe("number");
    expect(splash.width).toBeGreaterThanOrEqual((imageWidthDp as number) * 4);

    // AND A CEILING, which is what sent the mark back from 200dp to 176dp on
    // 2026-09-15. The PO reported the loading logo as "circular on its outer
    // edge, different from the app icon" — and it was the SAME file: since Expo
    // SDK 52 the Android splash goes through the Android 12 splash-screen API,
    // which draws the icon inside a CIRCULAR mask showing the inner two thirds
    // of a 288dp container, i.e. 192dp. An octagon whose corners fall outside
    // that circle loses them, and a chamfered plaque with its eight corners
    // shaved reads as a disc.
    //
    // The fix is this number and NOT padding in the PNG. Padding is what the
    // tight-crop assertion below forbids, for the reason it states: transparent
    // margin baked into the file shrinks the mark inside its own declared width
    // and forces a compensating number here anyway. So the mark stays flush to
    // the canvas and we render it smaller.
    //
    // 1.082 is geometry, not a guess: a regular octagon measured flat-to-flat at
    // W has circumradius W / (2·cos 22.5°) = 0.541W, so the circle that contains
    // it is 1.082W across. 176 × 1.082 = 190.4dp, inside 192 with room for the
    // resampler's soft edge; 200 needed 216 and was over by 24.
    //
    // HONEST ABOUT ITS PROVENANCE: 192 comes from Android's published splash
    // spec, not from a measurement on a device. It is a floor-and-ceiling pair
    // now, so if a real phone says otherwise the number moves HERE, with the
    // observation written next to it — not by quietly repadding the asset.
    const OCTAGON_CIRCUMSCRIBED_RATIO = 1.082;
    const ANDROID_12_MASKED_DIAMETER_DP = 192;
    expect((imageWidthDp as number) * OCTAGON_CIRCUMSCRIBED_RATIO).toBeLessThanOrEqual(
      ANDROID_12_MASKED_DIAMETER_DP,
    );

    // TIGHT CROP, asserted against the ink rather than declared. expo-splash-
    // screen renders this file at `imageWidth` dp, so transparent padding baked
    // into it would silently shrink the mark inside its own declared width and
    // force a compensating number in app.json. Allow a few pixels of slack for
    // the resampler's soft edge; anything more is padding.
    const ink = inkBounds("assets/splash-icon.png");
    expect(splash.width - ink.width).toBeLessThanOrEqual(4);

    // Same mark, same shape: whatever the splash was scaled to must still carry
    // the source's aspect ratio. This is what would catch a second,
    // differently-drawn mark dropped in under the same filename — the one
    // failure the dimension checks above cannot see.
    // 1:1, and the number is the MARK: the chamfered plaque adopted 2026-09-03
    // is square, where the scanned-fingerprint oval it replaced was 610x443
    // (1.377). Updated deliberately, tolerance UNCHANGED — a ratio assertion
    // loosened to survive a redesign stops being an assertion.
    expect(splash.width / splash.height).toBeCloseTo(1, 1);
  });

  it("ships a Google Play feature graphic at the exact size Play accepts", () => {
    // Play's Store Listing "Graphics" section rejects an upload that is not
    // EXACTLY 1024×500 — not "close", not "fits inside" — so this is checked
    // as equality, the same way the icon test above checks 1024×1024.
    const graphic = readPng("assets/feature-graphic.png");
    expect(graphic).toMatchObject({ width: 1024, height: 500 });

    // OPAQUE: Play's spec for this asset forbids an alpha channel outright,
    // the same rule App Store Connect enforces on icon.png above — but here
    // it is worth stating explicitly that it DIFFERS from this file's other
    // two generated assets. adaptive-icon-foreground.png and
    // splash-icon.png both keep alpha on purpose (they composite onto a
    // background layer or a config-declared colour); this one does not
    // because it is Play's requirement, not this app's usual posture, that
    // governs it.
    expect(graphic.hasAlpha).toBe(false);

    // THE LANDSCAPE TRAP: every non-vacuity and centring check above this
    // point was written for a SQUARE canvas, and reusing their numbers here
    // verbatim would pass on garbage. A `width === height` assertion would
    // fail on every correct file this test could ever see. A floor expressed
    // as "fraction of a square's area" (1024²) would be checking against the
    // wrong denominator — this canvas is 1024×500, half that area. And a
    // single left/right-only centring check would miss the mark sliding
    // vertically, which a square asset has no way to distinguish from
    // sliding horizontally. So every number below is re-derived for THIS
    // 1024×500 canvas rather than copied from the icon or splash checks.
    const ink = inkBoundsOpaque("assets/feature-graphic.png", { r: 0xfb, g: 0xfa, b: 0xf5 });

    // Non-vacuity, on the BINDING axis. build-mobile-app-icons.ts sizes this
    // mark by HEIGHT (500px is what runs out first on a 1024-wide canvas,
    // see the recipe's comment) — so the floor and ceiling that catch "mark
    // is a degenerate dot" or "mark fills the whole canvas" both have to be
    // read off height, not width. Measured on the file: ink height is 275 of
    // 500 (RATIO_FEATURE = 0.55). Floor well below that catches a
    // shrunk-to-nothing mark; ceiling well above it catches a mark stretched
    // edge to edge. Both survived the 0.768 → 0.55 move unchanged, which is
    // the point of setting them wide of the value rather than around it.
    const heightFraction = ink.height / graphic.height;
    expect(heightFraction).toBeGreaterThan(0.5);
    expect(heightFraction).toBeLessThan(0.95);

    // Non-vacuity again, but over AREA rather than a single axis — the check
    // a square asset's "fraction of edge length" reasoning cannot express,
    // because on a 1024×500 canvas the two axes disagree by more than 2×.
    // This is what catches a mark that is tall enough to pass the height
    // check above but a sliver wide (or vice versa) — a failure mode the
    // per-axis check alone is blind to.
    //
    // THE FLOOR MOVED, DELIBERATELY, AND HERE IS THE ARITHMETIC. It was 0.15
    // against a measured 0.288 (the old 384×384 ink of 1024×500). The mark is
    // now 275×275: 75625 / 512000 = 0.148, which is BELOW the old floor — so
    // leaving 0.15 in place would have failed on a correct file, and nudging it
    // to 0.147 "so it passes" would have turned a non-vacuity floor into a
    // restatement of the measurement. 0.10 is the deliberate replacement: a
    // third below the measured value, so no rounding can trip it, and tight
    // enough that a mark narrower than ~0.68 of its own height still fails.
    // The ceiling is untouched.
    const areaFraction = (ink.width * ink.height) / (graphic.width * graphic.height);
    expect(areaFraction).toBeGreaterThan(0.1);
    expect(areaFraction).toBeLessThan(0.9);

    // Centred on BOTH axes, independently — not just horizontally the way a
    // square asset's single check would read. On a landscape canvas, a mark
    // that is centred left-right but has drifted up or down is a real,
    // visible defect a symmetric-canvas check has no way to catch, because
    // on a square canvas "centred" only ever meant one thing.
    const leftMargin = ink.left;
    const rightMargin = graphic.width - (ink.left + ink.width);
    const topMargin = ink.top;
    const bottomMargin = graphic.height - (ink.top + ink.height);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(8);
    expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(8);

    // Same mark, same shape: catches a second, differently-drawn mark landing
    // under this filename, exactly as the splash check above does.
    // 1:1, same reason as the splash assertion above: the chamfered plaque is
    // square. Tolerance unchanged.
    expect(ink.width / ink.height).toBeCloseTo(1, 1);
  });
});

describe("Play Store feature graphic — the designed lockup", () => {
  // WHY A DIFFERENT INSTRUMENT FROM THE TEST ABOVE. inkBoundsOpaque() finds
  // "ink" as everything that differs from the PAPER ground — right for a lone
  // plaque on paper, wrong here: build-mobile-app-icons.ts's
  // buildFeatureGraphicLockup() composes a NAVY field carrying a rounded
  // paper tile AND two lines of set type, so "everything that is not paper"
  // is nearly the whole canvas. The right instrument for a lockup is coarse
  // and regional — does the LEFT THIRD read as the tile's blend, does the
  // RIGHT TWO-THIRDS read as navy — and every number below is a MEAN over a
  // region, never a single sampled pixel. A resampled point sample moves by a
  // channel or two between runs for the same reason
  // __tests__/pwa-icons.test.ts measures its mark's colour by MODE rather
  // than by centre pixel (see that file's `dominant` doc comment); a mean
  // over tens of thousands of pixels does not carry that instability.
  const RELATIVE = "assets/store/feature-graphic.png";

  // Restated from build-mobile-app-icons.ts's exported NAVY / PAPER, same
  // posture as every colour literal already in this file (see PAPER's own
  // doc comment there for why nothing is imported instead) — `{r,g,b}` only,
  // to match what readPngChunksRgb's decode produces.
  const NAVY_RGB = { r: 0x0a, g: 0x35, b: 0x56 };
  const PAPER_RGB = { r: 0xfb, g: 0xfa, b: 0xf5 };

  /** Mean R/G/B over a rectangular region of an OPAQUE RGB PNG. */
  function meanColourInRegion(
    relative: string,
    region: { left: number; top: number; width: number; height: number },
  ): { r: number; g: number; b: number } {
    const BPP = 3;
    const bytes = readFileSync(path.join(MOBILE_ROOT, relative));
    const { width, height, pixels } = readPngChunksRgb(bytes, relative);
    const raw = decodeRgba(pixels, width, height, BPP);
    const stride = width * BPP;
    const right = Math.min(region.left + region.width, width);
    const bottom = Math.min(region.top + region.height, height);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;
    for (let y = region.top; y < bottom; y++) {
      for (let x = region.left; x < right; x++) {
        const i = y * stride + x * BPP;
        sumR += raw[i] ?? 0;
        sumG += raw[i + 1] ?? 0;
        sumB += raw[i + 2] ?? 0;
        count += 1;
      }
    }
    if (count === 0) throw new Error(`${relative}: empty region`);
    return { r: sumR / count, g: sumG / count, b: sumB / count };
  }

  it("exists at exactly the size Play accepts, opaque", () => {
    const graphic = readPng(RELATIVE);
    expect(graphic).toMatchObject({ width: 1024, height: 500, hasAlpha: false });
  });

  it("reads as the paper tile's blend over its left third — not pure navy, not pure paper", () => {
    const mean = meanColourInRegion(RELATIVE, {
      left: 0,
      top: 0,
      width: Math.floor(1024 / 3),
      height: 500,
    });
    // MEASURED on the generated file: (82.7, 116.9, 142.5) — lifted well off
    // navy (10, 53, 86) by the tile, short of paper (251, 250, 245) because
    // roughly half this strip is still navy margin above, below and left of
    // the tile. Floor and ceiling are the navy/paper values ±20 on every
    // channel: wide enough to survive ordinary resampling drift, tight
    // enough that "tile missing" (reads as navy) or "tile fills the strip"
    // (reads as paper) both fail.
    for (const channel of ["r", "g", "b"] as const) {
      expect(mean[channel]).toBeGreaterThan(NAVY_RGB[channel] + 20);
      expect(mean[channel]).toBeLessThan(PAPER_RGB[channel] - 20);
    }
  });

  it("stays navy-dominant over its right two-thirds", () => {
    const left = Math.floor(1024 / 3);
    const mean = meanColourInRegion(RELATIVE, { left, top: 0, width: 1024 - left, height: 500 });
    // MEASURED: (30.5, 69.9, 100.0) — the wordmark's white/celeste ink and
    // the tile's own right edge are a small fraction of this region's area,
    // so the mean sits within ~21 of navy on every channel. 30 is the
    // ceiling: a lockup with the navy field gone (recoloured background, or
    // the tile/text somehow covering the region) blows through it, while
    // ordinary font-substitution differences across platforms do not.
    for (const channel of ["r", "g", "b"] as const) {
      expect(Math.abs(mean[channel] - NAVY_RGB[channel])).toBeLessThan(30);
    }
  });
});

describe("app identity assets — splash plugin wiring", () => {
  it("configures the splash plugin against the file it ships", () => {
    const plugins = appJson.expo.plugins ?? [];
    const splashPlugin = plugins.find(
      (entry): entry is [string, Record<string, unknown>] =>
        Array.isArray(entry) && entry[0] === "expo-splash-screen",
    );
    expect(splashPlugin).toBeDefined();
    expect(splashPlugin?.[1]).toMatchObject({
      image: "./assets/splash-icon.png",
      backgroundColor: "#fbfaf5",
    });
  });

  it("pins the interface style to light — the design system has no dark mode", () => {
    // scripts/build-mobile-app-icons.ts's "WHY THERE IS NO DARK SPLASH": automatic
    // invited a dark variant this light-only design system forbids (2026-09-03).
    expect(appJson.expo.userInterfaceStyle).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// .easignore — the archive EAS uploads
// ---------------------------------------------------------------------------

/**
 * The git repository root. `.easignore` is the one release file that does NOT
 * live in apps/mobile: EAS reads it only from the root of the git repository
 * ("`.easignore` can only be located in the root of your git repository"), and
 * a copy placed next to eas.json would be ignored in silence.
 */
const REPO_ROOT = path.resolve(MOBILE_ROOT, "..", "..");

/** Every rule in an ignore file: no blank lines, no comments, order preserved. */
function ignoreRules(file: string): string[] {
  return (
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      // Split on the newline only: the trim below removes any carriage return,
      // so this needs no regex and stays readable in a file full of them.
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
}

describe(".easignore", () => {
  // THE FAILURE THIS EXISTS TO CATCH IS NOT A BIG ARCHIVE. It is a leaked
  // secret. `.easignore` REPLACES `.gitignore` rather than extending it, so the
  // moment this file exists, every rule .gitignore carries stops applying to
  // the upload unless it is restated. `.env.local` holds the Supabase service
  // role key. Nothing else in this repo notices: the build succeeds, the app
  // works, and the key is sitting in a build server's archive.
  //
  // The gate has to be a comparison against .gitignore rather than a list of
  // "important" patterns, because the dangerous case is the pattern somebody
  // adds to .gitignore NEXT MONTH — a new credentials file, a new dump — with
  // no reason to think about a build config two directories away.

  it("restates every rule .gitignore carries", () => {
    const easRules = new Set(ignoreRules(".easignore"));
    const missing = ignoreRules(".gitignore").filter((rule) => !easRules.has(rule));
    expect(missing).toEqual([]);
  });

  it("keeps the secrets out even if the sync check above is ever relaxed", () => {
    // Named explicitly, so a future decision to loosen the mirror rule cannot
    // quietly take these with it. These are the four that carry credentials or
    // live session tokens.
    const rules = new Set(ignoreRules(".easignore"));
    expect(rules.has(".env*")).toBe(true);
    expect(rules.has(".env.local")).toBe(true);
    expect(rules.has("e2e/.auth/")).toBe(true);
    expect(rules.has("qa-sessions*.json")).toBe(true);
  });

  it("excludes the three tracked trees a native build never opens", () => {
    // docs/ is 84.4 MB of the 126.3 MB tracked tree on its own. Without these the
    // file would be pure overhead: same archive, one more thing to keep in
    // sync. Every reference to these paths from app, apps, components, lib,
    // src, db and packages was swept and is inside a comment.
    const rules = new Set(ignoreRules(".easignore"));
    expect(rules.has("docs/")).toBe(true);
    expect(rules.has("__tests__/")).toBe(true);
    expect(rules.has("e2e/")).toBe(true);
  });

  it("keeps a locally-run prebuild out of the archive", () => {
    // `.easignore` replaces every .gitignore for upload purposes, including
    // apps/mobile/.gitignore. Without these two the moment somebody debugs a
    // native build with `expo prebuild`, their generated android/ or ios/ tree
    // is uploaded and lands on top of the one EAS generates for itself.
    const rules = new Set(ignoreRules(".easignore"));
    expect(rules.has("apps/mobile/android/")).toBe(true);
    expect(rules.has("apps/mobile/ios/")).toBe(true);
  });

  it("keeps the workspace the mobile app actually depends on", () => {
    // packages/contract is `@dim/contract: workspace:*` in apps/mobile's
    // package.json. Excluding it (or the root manifests that make the workspace
    // resolvable) produces a build that fails during install, far from the file
    // that caused it.
    const rules = ignoreRules(".easignore");
    for (const kept of [
      "packages/",
      "packages/contract",
      "apps/",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]) {
      expect(rules).not.toContain(kept);
    }
  });
});

// ---------------------------------------------------------------------------
// The fingerprint's two known ways of not being reproducible
// ---------------------------------------------------------------------------

describe("runtime version reproducibility", () => {
  // WHAT THESE GUARD. `runtimeVersion: { policy: "fingerprint" }` is only worth
  // anything if the SAME tree hashes to the SAME value on the machine that runs
  // eas-cli and on the Linux worker that recomputes it. Build
  // 9900114a-c134-41cf-af38-6aaf789d2942 (2026-08-26) proved it did not, twice
  // over, and both causes are one line of configuration that a tidying pass
  // would happily delete because neither line explains itself where it sits.
  //
  // The failure mode if either regresses is not subtle and not local: every
  // build is refused with a runtime-version mismatch, fifteen minutes after it
  // starts, with a diff of several hundred paths to read.
  //
  // A third line joined them afterwards. It is not a third CAUSE — it is what
  // makes the cure for the first one binding rather than hopeful, by pinning
  // the pnpm that has to read it.

  it("pins pnpm's virtual store length so the hash does not depend on the OS", () => {
    // pnpm's default for this is `isWindows() ? 60 : 120`, and @expo/fingerprint
    // hashes the native dependency set BY PATH — through
    // node_modules/.pnpm/<truncated-dir>/… So an unpinned repo fingerprints
    // differently on the PO's Windows machine and on an EAS worker.
    //
    // Asserted as raw text rather than through a YAML parser: this package has
    // no YAML dependency, and adding one to a React Native test graph to read a
    // single integer is a worse trade than a regex. 60 rather than 120 on
    // purpose — see the comment above the line itself.
    const workspace = readFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toMatch(/^virtualStoreDirMaxLength: 60$/m);
  });

  it("pins the pnpm that reads that setting, so the pin cannot be ignored", () => {
    // The store-length pin above only reaches a machine whose pnpm is new
    // enough to read settings out of pnpm-workspace.yaml at all. Nothing used
    // to say which pnpm that is: the EAS worker ran whatever its image
    // shipped, and an older one would truncate at its own default and
    // reproduce the identical mismatch — the store-length pin sitting right
    // there, silently unread.
    //
    // `packageManager` closes it because pnpm ENFORCES the field itself.
    // pnpm 11.1.1 defaults `wantedPackageManager.onFail` to "download" and
    // then switches the CLI to the pinned version before doing any work, so
    // the pnpm that computes those paths is the same one everywhere.
    //
    // Asserted as a shape rather than as the literal string, so a deliberate
    // pnpm upgrade is one edit and not two — but the field's ABSENCE, which
    // is what a tidying pass would produce, fails here.
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { packageManager?: string };
    expect(rootPackageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("pins that version in exactly one place", () => {
    // THE FAILURE THIS EXISTS TO CATCH IS A GREEN-LOOKING SECOND PIN.
    // `pnpm/action-setup` compares its `version:` input to the package.json
    // field as RAW STRINGS and throws "Multiple versions of pnpm specified"
    // when they differ — so the perfectly reasonable-looking `version: 11`
    // that used to sit in all eleven of these steps does not merely go stale
    // next to `pnpm@11.1.1`, it fails every job in every workflow at the
    // setup step. Restoring it "for clarity" is a whole-CI outage.
    const workflowDir = path.join(REPO_ROOT, ".github", "workflows");
    const offenders: string[] = [];
    let stepsSeen = 0;

    for (const file of readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
      const lines = readFileSync(path.join(workflowDir, file), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]?.includes("pnpm/action-setup")) continue;
        stepsSeen += 1;
        // Walk the rest of this step — up to the next list item — looking for
        // an input that names a version.
        for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j] ?? ""); j++) {
          if (/^\s*version:/.test(lines[j] ?? "")) offenders.push(`${file}:${j + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);

    // The non-vacuity floor. A renamed action, a moved workflow directory or a
    // glob that stops matching would otherwise make this test pass by finding
    // nothing at all — which is the same green it shows when everything is
    // right.
    expect(stepsSeen).toBeGreaterThan(0);
  });

  it("ignores the generated native projects FROM apps/mobile, not from the root", () => {
    // @expo/fingerprint calls a project `generic` (and hashes the whole
    // prebuild output into the runtime version) when android/app/build.gradle
    // exists and is not ignored. On an EAS worker there is no git to ask, so it
    // falls back to a client that globs `**/.gitignore` FROM THE EXPO PROJECT
    // ROOT — which is this directory. A rule in the repo root's .gitignore is
    // invisible to it, which is why these two live here and why moving them
    // "somewhere tidier" reintroduces the failure.
    const rules = readFileSync(path.join(MOBILE_ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(rules).toContain("/android/");
    expect(rules).toContain("/ios/");
  });

  it("carries no key SDK 57 dropped from the config schema", () => {
    // `newArchEnabled` and `android.edgeToEdgeEnabled` were both in app.json and
    // both failed the build's own `expo config` schema check. Neither appears in
    // @expo/config-types@57.0.2, so removing them changed nothing except that
    // the build stopped failing: the New Architecture and edge-to-edge are
    // unconditional in SDK 57. `edgeToEdgeEnabled` does still have exactly one
    // reader — a deprecation warning, measured, not assumed; see
    // docs/mobile/eas-build-profiles.md.
    //
    // Asserted against the RAW app.json rather than the resolved config, because
    // that is the file the schema check reads and the place a copy-pasted
    // snippet from an SDK-53 tutorial would land.
    const raw = (readJson("app.json") as { expo: Record<string, unknown> }).expo;
    expect(raw.newArchEnabled).toBeUndefined();
    expect((raw.android as Record<string, unknown> | undefined)?.edgeToEdgeEnabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The third way a build dies: a config naming a package nobody declared
// ---------------------------------------------------------------------------

/**
 * Babel's own name standardisation, transcribed from
 * `@babel/core/lib/config/files/plugins.js` (7.29.7).
 *
 * It exists because the string in a preset list is not the package name. Babel
 * expands `expo` to `babel-preset-expo`, `@babel/typescript` to
 * `@babel/preset-typescript`, `@acme/thing` to `@acme/babel-preset-thing`, and
 * strips a `module:` prefix — so a fence that compared the raw strings to
 * package.json would report a miss for every shorthand and a pass for none of
 * the real ones. Copied rather than imported: `@babel/core` does not export it.
 */
const BABEL_NAME_RULES = {
  preset: {
    prefix: /^(?!@|module:|[^/]+\/|babel-preset-)/,
    org: /^(@babel\/)(?!preset-|[^/]+\/)/,
    otherOrg: /^(@(?!babel\/)[^/]+\/)(?![^/]*babel-preset(?:-|\/|$)|[^/]+\/)/,
  },
  plugin: {
    prefix: /^(?!@|module:|[^/]+\/|babel-plugin-)/,
    org: /^(@babel\/)(?!plugin-|[^/]+\/)/,
    otherOrg: /^(@(?!babel\/)[^/]+\/)(?![^/]*babel-plugin(?:-|\/|$)|[^/]+\/)/,
  },
} as const;

function standardizeBabelName(type: "preset" | "plugin", name: string): string {
  const rules = BABEL_NAME_RULES[type];
  return name
    .replace(rules.prefix, `babel-${type}-`)
    .replace(rules.org, `$1${type}-`)
    .replace(rules.otherOrg, `$1babel-${type}-`)
    .replace(/^(@(?!babel$)[^/]+)$/, `$1/babel-${type}`)
    .replace(/^module:/, "");
}

/** The npm package names a babel preset/plugin list resolves to. */
function babelPackageNames(type: "preset" | "plugin", entries: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    // An entry is either `"name"` or `["name", options]`; an inline function is
    // neither, and a relative or absolute path is a file in this repo, not a
    // package. All three are correctly nothing to declare.
    const raw = Array.isArray(entry) ? (entry as unknown[])[0] : entry;
    if (typeof raw !== "string") continue;
    if (raw.startsWith(".") || path.isAbsolute(raw)) continue;
    const standardized = standardizeBabelName(type, raw);
    const segments = standardized.split("/");
    const pkg = standardized.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
    if (pkg.length > 0) names.push(pkg);
  }
  return names;
}

describe("babel toolchain declarations", () => {
  it("declares every package babel.config.js names as a preset or plugin", () => {
    // WHAT THIS GUARDS, AND WHY EVERY LOCAL INSTRUMENT SAID GREEN WHILE IT WAS
    // BROKEN.
    //
    // Build e2a89561-910b-4ad7-97fa-ab0f2a481db8 (2026-08-26, production,
    // versionCode 3) cleared the two fingerprint causes the block above pins,
    // reached Gradle, and died in `:app:createBundleReleaseJsAndAssets`:
    //
    //     Failed to construct transformer:
    //     Error: Cannot find module 'babel-preset-expo'
    //
    // `babel.config.js` had named `babel-preset-expo` since this app was
    // created and NOTHING in the repo declared it — not this package.json, not
    // the root one. It resolved anyway on the PO's machine, and the mechanism
    // is the whole lesson: `pnpm -C apps/mobile export` runs through pnpm's
    // `node_modules/.bin/expo` shim, and that shim exports NODE_PATH pointing
    // at `node_modules/.pnpm/expo@<version>_<hash>/node_modules` — the
    // virtual-store directory holding expo's OWN dependencies, of which
    // `babel-preset-expo` is one. Node folds NODE_PATH into
    // `Module.globalPaths` and appends it to every bare lookup, so Babel found
    // a preset this app had no declared route to. EAS's Gradle task runs `node`
    // directly ("Process 'command 'node'' finished with non-zero exit value 1"),
    // no shim, no NODE_PATH, no preset.
    //
    // The generalisation, which is why this reads the names instead of
    // asserting the one: a config file may only name packages this package.json
    // declares. Anything else is a dependency that exists by accident of the
    // installer's layout, and the layout is not the same on the machine that
    // builds the release.
    //
    // The config is CALLED rather than pattern-matched, so the list is exactly
    // the one Babel receives.
    const factory = require("../../babel.config.js") as (api: unknown) => {
      presets?: readonly unknown[];
      plugins?: readonly unknown[];
    };
    const cache = Object.assign(() => undefined, {
      forever: () => undefined,
      never: () => undefined,
      using: () => undefined,
      invalidate: () => undefined,
    });
    const config = factory({
      cache,
      env: () => "test",
      caller: () => undefined,
      assertVersion: () => undefined,
      version: "7",
    });

    const named = [
      ...babelPackageNames("preset", config.presets ?? []),
      ...babelPackageNames("plugin", config.plugins ?? []),
    ];
    const declared = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);

    expect(named.filter((name) => !declared.has(name))).toEqual([]);

    // The non-vacuity floor, in the shape this file already uses for the
    // workflow sweep. A config that stopped exporting a factory, or one whose
    // presets moved behind a helper this cannot see, would otherwise pass by
    // finding nothing — the same green it shows when everything is declared.
    expect(named.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The SDK's own pin, against what the installer actually resolved
// ---------------------------------------------------------------------------

/**
 * `expo`'s `bundledNativeModules.json` — the SDK's declaration of which version
 * of each native module SDK 57 was built and tested against.
 *
 * It is not a document about this app: it is the table `expo install` writes
 * versions from and `expo-doctor` validates declared versions against. Read
 * through `require.resolve` rather than a relative path so it is always the
 * table belonging to the `expo` this app resolves.
 */
const BUNDLED_NATIVE_MODULES = JSON.parse(
  readFileSync(require.resolve("expo/bundledNativeModules.json", { paths: [MOBILE_ROOT] }), "utf8"),
) as Record<string, string>;

/**
 * Every `name@version` the lockfile RESOLVED, from its `packages:` section.
 *
 * The lockfile rather than `node_modules` on purpose: under pnpm a package
 * nothing declares is invisible from `apps/mobile` — which is exactly the class
 * of package this block exists to judge — while the lockfile lists every
 * resolution in the workspace whether or not anything can see it by name.
 */
function resolvedVersions(): Map<string, string[]> {
  const lock = readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  const found = new Map<string, string[]>();
  let inPackages = false;
  for (const raw of lock) {
    const line = raw.replace(/\r$/, "");
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    // `packages:` is followed by `snapshots:`; anything at column 0 ends it.
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const match = line.match(/^ {2}'?((?:@[^@']+\/)?[^@']+)@([^':]+)'?:$/);
    if (match === null) continue;
    const [, name, version] = match as unknown as [string, string, string];
    found.set(name, [...(found.get(name) ?? []), version]);
  }
  return found;
}

/**
 * `~`, `^` and exact — the only three shapes `bundledNativeModules.json` uses,
 * checked without a semver dependency because adding one to satisfy a test
 * would be this file's own lesson, inverted.
 *
 * AN UNRECOGNISED SHAPE THROWS rather than passing. A range form this cannot
 * read is a case nobody has judged, and a fence that silently skips what it does
 * not understand is the fence that reports green on the thing it was built for.
 */
function satisfiesPin(version: string, pin: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const m = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  // A prerelease or build-metadata resolution is never the pinned release.
  const got = parse(version);
  if (got === null) return false;

  const operator = pin.startsWith("~") || pin.startsWith("^") ? pin[0] : "";
  const want = parse(operator === "" ? pin : pin.slice(1));
  if (want === null) throw new Error(`Unreadable version pin: ${JSON.stringify(pin)}`);

  const atLeast =
    got[0] > want[0] ||
    (got[0] === want[0] && (got[1] > want[1] || (got[1] === want[1] && got[2] >= want[2])));
  if (!atLeast) return false;
  if (operator === "") return got[0] === want[0] && got[1] === want[1] && got[2] === want[2];
  if (operator === "~") return got[0] === want[0] && got[1] === want[1];
  // `^` on a 0.x pin is caret-on-zero: the minor is the breaking axis.
  return want[0] === 0 ? got[0] === 0 && got[1] === want[1] : got[0] === want[0];
}

/**
 * The two SDK-bundled names the WEB app owns, and why neither is a native
 * module drifting.
 *
 * They are exempt from the resolved-version rule and from nothing else — `react`
 * is asserted against this app's OWN declaration below, so the exemption cannot
 * hide a drift on the side that matters.
 */
const WEB_OWNED_BUNDLED_NAMES: Record<string, string> = {
  // Next.js resolves 19.2.6. apps/mobile declares the SDK's pin exactly, and the
  // Android build never sees the other copy.
  react: "the web app resolves its own React; this app declares the pin exactly",
  // expo-router's OPTIONAL web peer. Never autolinked, never compiled, never in
  // an .aab.
  "react-dom": "web-only peer of expo-router; not an autolinked native module",
};

/**
 * Measured 2026-08-27: 35 of the table's 123 names resolve into this workspace.
 * The floor sits far enough below that ordinary dependency churn cannot trip it
 * and far enough above zero that a broken lockfile parse cannot pass as a clean
 * tree — the same shape `__tests__/encoding-fitness.test.ts` uses.
 */
const MIN_BUNDLED_NAMES_CHECKED = 20;

describe("SDK-pinned native modules", () => {
  it("resolves every SDK-bundled native module at the version SDK 57 pins", () => {
    // WHAT THIS GUARDS, AND WHY IT IS THE ONLY LOCAL INSTRUMENT THAT COULD HAVE
    // SEEN IT.
    //
    // Build 9bdab7b8-b5e2-4aa5-8272-f8e990c0cce3 (2026-08-27, production,
    // versionCode 4) got past the fingerprint, past Metro, and died 9m32s into
    // real native compilation:
    //
    //     expo-modules-core/android/src/main/cpp/worklets/
    //       WorkletJSCallInvoker.cpp:27:21: error: no member named
    //       'executeSync' in 'worklets::WorkletRuntime'
    //
    // `expo-modules-core@57.0.14` calls `WorkletRuntime::executeSync`. That
    // method exists in `react-native-worklets@0.10.1` — the version this table
    // pins — and was renamed to `runSync` by 0.12. The tree had 0.12.1, because
    // NOTHING DECLARED `react-native-worklets` AT ALL: it arrived as an
    // auto-installed optional peer of `react-native-reanimated`, itself an
    // auto-installed optional peer of `expo-router`, and pnpm resolved each to
    // `latest` because no range in this repo narrowed it.
    //
    // THAT IS WHY THIS READS THE LOCKFILE AND NOT package.json. `expo install
    // --check` and `expo-doctor` both validate DECLARED versions against this
    // same table, so they reported "up to date" and 21/21 while three native
    // modules sat in the tree past the pin. A fence over declarations would have
    // agreed with them. The undeclared package is the whole failure mode.
    //
    // THE COMPILER ERROR ITSELF IS NOT OBSERVABLE HERE — there is no Android NDK
    // on the machines this suite runs on, and `expo export` only bundles
    // JavaScript. Its CAUSE is, entirely, from two JSON files.
    const inTree = resolvedVersions();
    const offenders: string[] = [];
    let checked = 0;

    for (const [name, pin] of Object.entries(BUNDLED_NATIVE_MODULES)) {
      const versions = inTree.get(name);
      if (versions === undefined) continue;
      checked += 1;
      if (name in WEB_OWNED_BUNDLED_NAMES) continue;
      for (const version of versions) {
        if (!satisfiesPin(version, pin)) {
          offenders.push(`${name}@${version} — SDK 57 pins ${pin}`);
        }
      }
    }

    // Each offender carries its own message — the name, what resolved, and what
    // the SDK pins — because jest's `expect` takes no second argument and a bare
    // `[]` mismatch would name the package without naming the rule it broke.
    expect(offenders.sort()).toEqual([]);

    // The non-vacuity floor. Without it a lockfile whose `packages:` section
    // stopped matching the pattern would report zero offenders over zero
    // packages, which is the same green as a clean tree.
    expect(checked).toBeGreaterThanOrEqual(MIN_BUNDLED_NAMES_CHECKED);
  });

  it("declares the exempt names at the pin, or does not declare them at all", () => {
    // The exemption above is scoped to the WEB's copies. This is what keeps it
    // from widening into "React is never checked": whatever `apps/mobile` itself
    // says about an exempt name still has to match SDK 57.
    const declared = {
      ...packageJson.dependencies,
      ...(packageJson.devDependencies ?? {}),
    };
    for (const name of Object.keys(WEB_OWNED_BUNDLED_NAMES)) {
      const range = declared[name];
      if (range === undefined) continue;
      expect(`${name}@${range}`).toBe(`${name}@${BUNDLED_NATIVE_MODULES[name]}`);
    }

    // Non-vacuity: an exemption list that drifted to names outside the table
    // would exempt nothing and assert nothing, silently.
    for (const name of Object.keys(WEB_OWNED_BUNDLED_NAMES)) {
      expect(Object.keys(BUNDLED_NATIVE_MODULES)).toContain(name);
    }
  });
});
