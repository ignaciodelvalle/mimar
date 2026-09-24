// `shouldOfferPushPriming` — decision 10A's gate for the in-app priming line.
//
// BOTH HALVES ARE REAL: the port seam (`setPushPort`, the same call
// `push-registration.test.ts` and `native-ports.test.ts` drive) and AsyncStorage
// (the in-memory mock from `jest.setup.js`). What is under test is the AND
// between them, so faking either away would test half a gate.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · dropping the dismissal check — "does not re-offer after Ahora no".
//   · dropping the permission peek — "does not offer once granted" and
//     "does not offer once denied".
//   · `status.outcome === "undetermined"` → `!== "denied"` — "does not offer
//     when the build has no push module at all" (unavailable would then pass).

import { beforeEach, describe, expect, it } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { PushPort } from "../native/push-port";
import { resetPushPort, setPushPort } from "../native/push-port";
import { shouldOfferPushPriming } from "./push-priming";
import { writePushPrimingDismissed } from "./push-priming-preference";

const OWNER = "11111111-1111-4111-8111-111111111111";

/** A port whose only relevant member for this file is the permission peek. */
function portWithPeek(outcome: PushPort["getPermissionStatus"]): PushPort {
  return {
    name: "fake",
    available: true,
    requestPermission: async () => ({ outcome: "granted" }),
    getPermissionStatus: outcome,
    getExpoPushToken: async () => ({ outcome: "unavailable" }),
    lastTap: async () => null,
    onTap: () => () => undefined,
    ensureNotificationChannel: async () => undefined,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetPushPort();
});

describe("shouldOfferPushPriming", () => {
  it("offers it when nobody has decided AND nobody dismissed it", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(true);
  });

  it("does not offer it once permission is already granted", async () => {
    // The existing-user case: an account that already said yes (or had a token
    // before this change shipped) must not see the line again.
    setPushPort(portWithPeek(async () => ({ outcome: "granted" })));

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(false);
  });

  it("does not offer it once the OS refused permanently", async () => {
    // Offering it would make the "Sí, avisame" button lie: the dialog it
    // promises to show cannot appear any more.
    setPushPort(portWithPeek(async () => ({ outcome: "denied" })));

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(false);
  });

  it("does not offer it on a build with no push module at all", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "unavailable" })));

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(false);
  });

  it("does not offer it when the peek itself failed", async () => {
    // A broken read is not license to interrupt somebody who just registered
    // a pet with a priming line that may not even be actionable.
    setPushPort(portWithPeek(async () => ({ outcome: "failed", detail: "boom" })));

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(false);
  });

  it("does not re-offer it once this account said 'Ahora no'", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));
    await writePushPrimingDismissed(OWNER);

    await expect(shouldOfferPushPriming(OWNER)).resolves.toBe(false);
  });

  it("a dismissal on one account does not silence the priming line for another", async () => {
    const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));
    await writePushPrimingDismissed(OWNER);

    await expect(shouldOfferPushPriming(OTHER_OWNER)).resolves.toBe(true);
  });
});
