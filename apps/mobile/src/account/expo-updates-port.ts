// `expo-updates`, bound to the port `update-check.ts` declares.
//
// WHY IT IS ITS OWN FILE AND NOT A CONST IN `AboutSection.tsx` (finding F7,
// review 2026-09-07). It was one, and `app/_layout.tsx` imported it from there
// — so the ROOT LAYOUT, the module that runs before anything is drawn, pulled
// in a Card component, `expo-constants`, the whole `ui/` kit and
// `crashReportingActive` to reach a four-line object literal. Nothing about the
// binding needs a screen, and a root layout that depends on a settings card is
// a root layout that breaks for reasons nobody would look for there.
//
// WHY NOT IN `update-check.ts`, WHICH OWNS THE TYPE. Because that module is
// deliberately native-free: `import * as Updates from "expo-updates"` is not an
// inert import — `expo-updates/build/ExpoUpdates.js` is
// `requireNativeModule('ExpoUpdates')`, which THROWS at module-evaluation time
// when the native module is absent (a dev client, Expo Go, a jest run with no
// mock). Putting the binding there would drag that throw into every consumer of
// the pure functions and into `foreground-update.test.tsx`, which imports them
// with no `expo-updates` mock at all. The type and the decisions stay in
// `update-check.ts`; the one line that touches the native module lives here,
// alone, where a file that imports it is opting into the native dependency
// knowingly.

import * as Updates from "expo-updates";

import type { UpdatesPort } from "./update-check";

/**
 * The real module, as a value.
 *
 * A VALUE AND NOT THE MODULE ITSELF, so `AboutSection`'s test can hand the same
 * component a fake and exercise all four outcomes without a device — which is
 * the reason the port exists at all (`update-check.ts`, "WHY A PORT AND A PURE
 * FUNCTION").
 */
export const EXPO_UPDATES_PORT: UpdatesPort = {
  isEnabled: Updates.isEnabled,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  updateId: Updates.updateId,
  checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
  fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
  reloadAsync: () => Updates.reloadAsync(),
};
