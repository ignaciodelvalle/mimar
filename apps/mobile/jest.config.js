// Jest, via `jest-expo` — the runner the Expo toolchain ships and validates.
//
// It is NOT the web app's Vitest, and that separation is deliberate on both
// sides: the root `vitest.config.ts` builds its file list by walking the repo
// for `*.test.ts`, and `apps` is excluded from that walk (`__tests__/db-
// reachability.ts`). Without that exclusion this file's tests would be swept
// into the web suite, collected in jsdom with the web app's aliases, and fail
// as "broken files" in the `pnpm test:verified` verdict — a mobile test taking
// the web gate down.
//
// `pnpm --filter mimar test` runs this, and since 2026-08-25 the root
// `verify` chain runs it too, via `pnpm verify:mobile` (with this app's
// `tsc --noEmit`). That reverses what this comment used to say — "deliberately
// NOT wired into the root verify chain in M1: a second runner with a second
// install to warm, slowing every web change down for no benefit" — and the
// reversal was not a change of taste. A clean `git merge` broke this app's
// build that morning and NOTHING went red: neither gate was in `pnpm verify`
// nor in .github/workflows/ci.yml, so the only thing standing between a broken
// Expo client and a release was somebody thinking to run it.
//
// The cost argument was also just wrong once measured: 33 tests in ~1.3s, on an
// install the root `pnpm install` already warmed (one workspace, one lockfile).
// The benefit is not hypothetical either — this app and the web app share
// `packages/contract`, and a contract change that compiles on the web and not
// under React Native is the exact failure the package boundary exists to catch.
//
// Still separate RUNNERS, though, and that part of the original reasoning
// stands: the root `vitest.config.ts` builds its file list by walking the repo
// for `*.test.ts` and excludes `apps` (`__tests__/db-reachability.ts`). Without
// that exclusion these files would be collected in jsdom with the web app's
// aliases and fail as "broken files" in the `pnpm test:verified` verdict.

module.exports = {
  preset: "jest-expo",

  // THE ENVIRONMENT MOVED WHEN THE FIRST RENDER TEST ARRIVED, and it is worth
  // being precise about how little that means. It was `"node"`, chosen because
  // the pure mapping modules under test needed nothing else. `react-native-env`
  // is `jest-environment-node` with ONE line added:
  //
  //     customExportConditions = ["require", "react-native"];
  //
  // That is the whole file. No jsdom, no DOM, no measurable cost to the pure
  // tests — React Native Testing Library renders through `react-test-renderer`,
  // which produces a JSON tree and never wanted a DOM. What the condition buys
  // is correct resolution for packages with conditional `exports` maps
  // (react-native-svg, react-native-screens, expo-router): under plain `node`
  // they resolve their web/default entry point, which is not the code this app
  // ships.
  //
  // The globals a component needs under test (`requestAnimationFrame`, the
  // mocked native modules) come from the preset's `setupFiles` and arrive either
  // way.
  testEnvironment: require.resolve("@react-native/jest-preset/jest/react-native-env.js"),

  // The safe-area mock every render test needs. See jest.setup.js for why it is
  // a setup file and not a `moduleNameMapper` entry.
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],

  // `roots` is a PATH; `testMatch` is a GLOB. Keeping `<rootDir>` out of the
  // glob is load-bearing on Windows, and it cost a debugging round to find out.
  //
  // `testMatch: ["<rootDir>/src/**/*.test.ts"]` expands to an absolute Windows
  // path, and micromatch reads `\` as an ESCAPE character, not a separator. In
  // this checkout the path contains `\.claude\`, so the pattern became
  // `…/dim\.claude/…` — an escaped literal dot — and matched nothing. Jest
  // reported "16 files checked, 0 matches" with no hint that the pattern itself
  // was the problem. Anchoring with `roots` and leaving the glob relative sides
  // steps the whole class: no separator ever reaches micromatch.
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],

  // Derived, not borrowed. The first test of every screen file pays the lazy
  // React Native requires that jest-expo defers until first render, so it runs
  // several times slower than its siblings. Measured on 2026-09-02 over two
  // full `jest --json` runs on an idle machine: the slowest first test without
  // a ceiling of its own was SharesScreen at 4432 ms, i.e. 89% of jest's
  // 5000 ms default. On a loaded machine (three orphaned grep.exe pinning
  // cores, gate 0902i attempt 1) the same test crossed 5000 ms and the file
  // failed with no assertion wrong. 15 s is 3x the measured idle worst case —
  // the same ratio PetPhotoScreen.test.tsx already uses for its own file-level
  // `jest.setTimeout(15_000)`, which stays as is. Re-measure before raising
  // this: a ceiling that grows with the slowdown stops being a ceiling.
  testTimeout: 15_000,

  // The preset's list, plus `lucide-react-native`. That package ships
  // untransformed ESM (`dist/esm/*.mjs`) and its exports map puts the
  // `react-native` condition before `require`, so the test environment's
  // customExportConditions resolve the .mjs — which Jest cannot parse without
  // Babel. The preset's default exception list covers the RN ecosystem by
  // name-prefix and "lucide-react-native" does not start with "react-native",
  // so it must be named. Everything except that one addition is the preset's
  // own value, copied because transformIgnorePatterns REPLACES rather than
  // merges; re-check `require("jest-expo/jest-preset").transformIgnorePatterns`
  // when upgrading the SDK.
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|lucide-react-native))",
    "/node_modules/react-native-reanimated/plugin/",
    "/node_modules/@react-native/babel-preset/",
  ],

  // The preset's transform, extended to `.mjs`. Its babel entry is keyed
  // `\.[jt]sx?$`, which never matches `lucide-react-native`'s ESM build
  // (`dist/esm/*.mjs` — what the `react-native` export condition resolves, i.e.
  // what Metro actually bundles), so exempting the package above still fed raw
  // `export` statements to the runtime. Reusing the preset's own babel-jest
  // entry keeps the options (caller: metro, this app's babel.config.js) in one
  // place instead of copying them.
  transform: {
    ...require("jest-expo/jest-preset").transform,
    "\\.mjs$": require("jest-expo/jest-preset").transform["\\.[jt]sx?$"],
  },
};
