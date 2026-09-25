// No-device-GPS fence — W8 (PO, 2026-09-24): "sin guardar GPS (ubicación
// real) en ningún lugar por ahora, todo se carga así, así no tenemos que
// reportar eso, ni preocuparnos por alguien compartiendo la dirección de su
// casa sin quererlo."
//
// Every place in the product is entered BY HAND — address search + a
// draggable map pin (components/LocationFields.tsx, components/LocationPicker.tsx)
// — never read from the device. The credential-scan log keeps only the coarse
// IP-derived area computed server-side (lib/infra/scan-geo.ts), which is not
// device location.
//
// THE SUBJECT, NOT ITS SPELLINGS. The banned thing is "asking the device where
// it is", so the fence bans every door to it rather than one spelling:
//   web    — navigator.geolocation (dot, optional chaining, bracket access),
//            the Geolocation API methods (getCurrentPosition / watchPosition,
//            as an identifier anywhere — a destructured or aliased method is
//            still the method), MapLibre's GeolocateControl (it calls the API
//            internally), a Permissions API query for "geolocation", and the
//            "Usar mi ubicación" / "ubicación actual" controls that offer it.
//   mobile — the native location modules (expo-location and the community
//            geolocation packages) as any module specifier, the same web API
//            (React Native polyfills navigator.geolocation), the dependency in
//            apps/mobile/package.json, and OS location permissions in the
//            app manifest.
//   policy — next.config.ts must send `Permissions-Policy: geolocation=()`,
//            so the BROWSER refuses the API on every page even if code slipped
//            past this scan (a third-party script, say).
//
// Comments are stripped first (scripts/lib/strip-comments.mjs): several files
// carry an explanatory comment naming these identifiers to say they are NOT
// used any more, and a raw scan would punish that documentation. String
// literals are KEPT, so bracket access and copy are still seen. Test files
// are not scanned: an assertion that the copy is ABSENT has to name it.
//
// `lib/events/event-schemas.ts` keeps `location_source: z.enum(["gps", …])`
// and the `scan_coords` field on purpose — events recorded before W8 carry
// them and must keep validating (append-only history). This fence bans the
// CAPTURE mechanism, not the legacy value.
//
// Run: pnpm lint:no-device-gps. Exits 0 clean; 1 listing each offending site.

import { existsSync, globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

export type Offense = { file: string; line: number; rule: string; snippet: string };
export type Rule = { id: string; pattern: RegExp };

const QUOTE = "[\"'`]";

/** Rules applied to comment-stripped web source. */
export const WEB_RULES: Rule[] = [
  {
    id: "navigator.geolocation",
    pattern: new RegExp(
      `\\bnavigator\\s*(?:\\?\\.|\\.)\\s*geolocation\\b|\\bnavigator\\s*(?:\\?\\.)?\\s*\\[\\s*${QUOTE}geolocation${QUOTE}\\s*\\]`,
      "g",
    ),
  },
  { id: "geolocation-api-method", pattern: /\b(?:getCurrentPosition|watchPosition)\b/g },
  // `(?!\.)` spares the MapLibre locale KEYS ("GeolocateControl.FindMyLocation"
  // in lib/ui/maplibre-locale.ts) — a translation for a control nothing mounts.
  { id: "maplibre-geolocate-control", pattern: /\bGeolocateControl\b(?!\.)/g },
  {
    id: "geolocation-permission-query",
    pattern: new RegExp(`\\bname\\s*:\\s*${QUOTE}geolocation${QUOTE}`, "g"),
  },
  {
    id: "use-my-location-copy",
    pattern: /usar\s+mi\s+ubicaci[oó]n|compartir\s+mi\s+ubicaci[oó]n|ubicaci[oó]n\s+actual/gi,
  },
];

const NATIVE_LOCATION_MODULES = [
  "expo-location",
  "@react-native-community/geolocation",
  "react-native-geolocation-service",
];

/** Rules applied to comment-stripped mobile source (the web API too: RN polyfills it). */
export const MOBILE_RULES: Rule[] = [
  {
    id: "native-location-module",
    pattern: new RegExp(
      `${QUOTE}(?:${NATIVE_LOCATION_MODULES.map((m) => m.replaceAll("/", "\\/")).join("|")})${QUOTE}`,
      "g",
    ),
  },
  ...WEB_RULES,
];

/** OS location permissions that must never appear in the app manifest. */
export const MANIFEST_RULE: Rule = {
  id: "os-location-permission",
  pattern: /ACCESS_(?:FINE|COARSE|BACKGROUND)_LOCATION|NSLocation\w*UsageDescription/g,
};

const WEB_GLOBS = [
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "middleware.ts",
  "instrumentation.ts",
];
const MOBILE_GLOBS = ["apps/mobile/app/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}"];
const MOBILE_MANIFESTS = ["apps/mobile/app.json", "apps/mobile/app.config.ts"];
const MOBILE_PACKAGE_JSON = "apps/mobile/package.json";
const NEXT_CONFIG = "next.config.ts";

/** Minimum file counts a healthy scan must clear — a broken glob (or a big
 * move) must fail this fence, not pass it by finding nothing to check. Both
 * sit well under the corpus size at the time of writing. */
export const MIN_WEB_FILES = 1000;
export const MIN_MOBILE_FILES = 100;

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || file.includes("/__tests__/");
}

function listFiles(globs: string[]): string[] {
  const seen = new Set<string>();
  for (const pattern of globs) {
    for (const f of globSync(pattern)) {
      const norm = String(f).replaceAll("\\", "/");
      if (norm.includes("/node_modules/") || isTestFile(norm)) continue;
      seen.add(norm);
    }
  }
  return [...seen].sort();
}

/** Scan one source text (comments stripped first). Exported for planted samples. */
export function scanSource(file: string, raw: string, rules: Rule[]): Offense[] {
  const clean = stripComments(raw);
  const offenses: Offense[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of clean.matchAll(re)) {
      const line = clean.slice(0, match.index).split(/\r?\n/).length;
      offenses.push({ file, line, rule: rule.id, snippet: match[0] });
    }
  }
  return offenses;
}

function scanFiles(files: string[], rules: Rule[]): { offenses: Offense[]; scanned: number } {
  const offenses: Offense[] = [];
  for (const file of files) offenses.push(...scanSource(file, readFileSync(file, "utf8"), rules));
  return { offenses, scanned: files.length };
}

export function findWebOffenses(): { offenses: Offense[]; scanned: number } {
  return scanFiles(listFiles(WEB_GLOBS), WEB_RULES);
}

export function findMobileOffenses(): { offenses: Offense[]; scanned: number } {
  const result = scanFiles(listFiles(MOBILE_GLOBS), MOBILE_RULES);
  for (const manifest of MOBILE_MANIFESTS) {
    if (!existsSync(manifest)) continue;
    // JSON carries no comments; stripComments is a no-op on it anyway.
    result.offenses.push(
      ...scanSource(manifest, blankBlockedPermissions(readFileSync(manifest, "utf8")), [
        MANIFEST_RULE,
      ]),
    );
  }
  result.offenses.push(
    ...findNativeLocationDependencies(readFileSync(MOBILE_PACKAGE_JSON, "utf8")),
  );
  return result;
}

/**
 * The manifest with every `blockedPermissions` array blanked out, line count
 * kept. A permission named THERE is the opposite of a request: Expo turns the
 * list into `tools:node="remove"`, which strips it from the merged manifest even
 * when a library (MapLibre, M17) brings it in. Listing the location permissions
 * there is how the app keeps them out, and apps/mobile's release-config test
 * pins that list; a location permission anywhere else in the manifest is still
 * an offense.
 */
export function blankBlockedPermissions(source: string): string {
  return source.replace(/"blockedPermissions"\s*:\s*\[[^\]]*\]/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

/** A native location module declared as a dependency of the app. */
export function findNativeLocationDependencies(packageJson: string): Offense[] {
  const pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
  const offenses: Offense[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (NATIVE_LOCATION_MODULES.includes(name)) {
        offenses.push({
          file: MOBILE_PACKAGE_JSON,
          line: 0,
          rule: "native-location-dependency",
          snippet: name,
        });
      }
    }
  }
  return offenses;
}

/** next.config.ts must deny the Geolocation API at the browser level. */
export function checkPermissionsPolicy(nextConfig: string): Offense[] {
  const clean = stripComments(nextConfig);
  const denied = /Permissions-Policy[^\n]*\bgeolocation=\(\)/.test(clean);
  const allowed = /\bgeolocation=\((?!\))/.test(clean);
  if (denied && !allowed) return [];
  return [
    {
      file: NEXT_CONFIG,
      line: 0,
      rule: "permissions-policy",
      snippet: "Permissions-Policy must carry geolocation=() (denied on every origin)",
    },
  ];
}

function runScan(): void {
  const web = findWebOffenses();
  const mobile = findMobileOffenses();

  if (web.scanned < MIN_WEB_FILES || mobile.scanned < MIN_MOBILE_FILES) {
    console.error(
      `✗ Non-vacuity guard: scanned ${web.scanned} web file(s) (floor ${MIN_WEB_FILES}) and ${mobile.scanned} mobile file(s) (floor ${MIN_MOBILE_FILES}). A broken glob would silently pass this fence — treat this as a failure.`,
    );
    process.exit(1);
  }

  const offenses = [
    ...web.offenses,
    ...mobile.offenses,
    ...checkPermissionsPolicy(readFileSync(NEXT_CONFIG, "utf8")),
  ];
  if (offenses.length > 0) {
    for (const o of offenses) {
      console.error(
        `${o.file}:${o.line}: [${o.rule}] "${o.snippet}" — device location is banned (W8, PO 2026-09-24). Places are entered by address search or the map pin, never read from the device.`,
      );
    }
    console.error(`\n✗ ${offenses.length} device-location site(s).`);
    process.exit(1);
  }

  console.log(
    `✓ No device GPS — clean across ${web.scanned} web and ${mobile.scanned} mobile file(s); Permissions-Policy denies geolocation.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /check-no-device-gps\.(?:ts|js)$/.test(process.argv[1].replaceAll("\\", "/"));

if (isMain) {
  runScan();
}
