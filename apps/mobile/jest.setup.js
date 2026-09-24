// What every test file in this app gets, before it runs.
//
// ONE ENTRY, AND IT IS NOT OPTIONAL. `useSafeAreaInsets()` throws "No safe area
// value available" without a provider, and `Screen` — the kit primitive every
// screen in this app is built on — renders a `SafeAreaView`. So a render test
// that did not mock this could not render anything at all.
//
// THE `.default` UNWRAP IS THE WHOLE REASON THIS IS A SETUP FILE rather than a
// `moduleNameMapper` line, and it cost a debugging round to find out. The
// package's own `jest/mock.tsx` is written as `export default { ...actual,
// useSafeAreaInsets, SafeAreaView, … }` — a DEFAULT export holding the named
// ones. Mapping the module path straight at it therefore resolves
// `import { SafeAreaView } from "react-native-safe-area-context"` to
// `undefined`, and React reports it as "Element type is invalid … check the
// render method of `Screen`", which points at the kit and not at the mock.
// `jest.mock` with the factory below hands back the object itself, so the named
// imports exist.
//
// It is applied globally rather than per file for the reason the mapper was
// attempted: a `jest.mock` line every render test has to remember is a line one
// of them eventually forgets.

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);

// `Crypto.randomUUID()` RETURNS `undefined` UNDER JEST, and it fails several
// frames away from where you would look. `jest-expo` mocks `expo-modules-core`
// wholesale, which is what makes `expo-crypto` importable at all — but the mock
// answers every native call with `undefined`, so `newIdempotencyKey()` hands its
// result to `isValidIdempotencyKey`, which calls `.trim()` on nothing, and the
// stack blames `packages/contract/src/api/pets.ts`.
//
// A CONSTANT would be the obvious mock and the wrong one: two different asientos
// must get two different keys, and a fixed value would make the test that proves
// it pass for a build where every form shared one key — the exact bug that
// silently no-ops a second write at the unique index. So this counts, and every
// value it returns is a well-formed v4.
// The `mock` prefix is not decoration: jest's factories may not close over an
// unprefixed outer binding, and the counter has to live outside the factory to
// survive between calls.
const mockUuidState = { next: 0 };
jest.mock("expo-crypto", () => ({
  ...jest.requireActual("expo-crypto"),
  randomUUID: () => {
    mockUuidState.next += 1;
    const tail = mockUuidState.next.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${tail}`;
  },
}));

// AsyncStorage, in memory.
//
// WITHOUT IT, IMPORTING IT THROWS. The package resolves its native module at
// import time and answers "NativeModule: AsyncStorage is null" under Jest —
// which is the whole reason `launch-gate-marker-store.ts` and
// `qr-spotlight-preference.ts` isolate the import in a file of their own. Every
// module that touches it is one file away from making a test of pure functions
// explode several frames from where anyone would look.
//
// THE PACKAGE SHIPS ITS OWN MOCK AND IT DOES NOT LOAD HERE. `jest/async-storage-
// mock.js` opens with `require("merge-options")`, which is not installed in this
// workspace (`require.resolve` fails, checked 2026-09-17), so pointing
// `moduleNameMapper` at it throws "Cannot find module" before a single test
// runs. Hence a local one — deliberately small, and only the six methods this
// app calls, so a seventh appearing in the source is a loud `undefined is not a
// function` and not a silent no-op.
//
// GLOBAL, for the reason the safe-area entry above is global: a `jest.mock` line
// every test file has to remember is a line one of them eventually forgets — and
// the forgetting surfaces as a native crash blamed on whatever imported the
// module three hops away.
//
// IT IS REAL STORAGE, NOT A STUB, and that is load-bearing for
// `event-draft-store.test.ts`: the thing under test there is what survives a
// write and comes back, and a `jest.fn()` returning `undefined` would prove
// nothing about it. Values are stringified on the way in exactly as the native
// module does, so a test cannot accidentally round-trip an object.
//
// It is one Map for the whole FILE (jest gives every test file its own module
// registry), so a suite whose cases must not see each other's writes clears it
// in `beforeEach` — `RecordEventScreen.test.tsx` does.
const mockAsyncStorage = new Map();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: async (key) => (mockAsyncStorage.has(key) ? mockAsyncStorage.get(key) : null),
    setItem: async (key, value) => {
      mockAsyncStorage.set(key, String(value));
    },
    removeItem: async (key) => {
      mockAsyncStorage.delete(key);
    },
    multiRemove: async (keys) => {
      for (const key of keys) mockAsyncStorage.delete(key);
    },
    getAllKeys: async () => [...mockAsyncStorage.keys()],
    clear: async () => {
      mockAsyncStorage.clear();
    },
  },
}));
