// WHEN THE REGISTRATION FIRES, which is the half of this feature that is easiest
// to get wrong and hardest to see wrong.
//
// A registration that never happens looks exactly like a person who declined:
// no row, no error, no screen. So these tests are about TIMING and COUNT — that
// it fires on a restored session and not only on a typed sign-in, that it fires
// once per person rather than once per notification, and that it fires again
// when the phone changes hands.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · dropping the immediate `react()` after subscribing — the "registers from
//     a session that was already restored" test.
//   · setting `registeredFor` AFTER the await instead of before — the "does not
//     register twice for one person" test.
//   · clearing `registeredFor` on a `denied` outcome — the "does not retry a
//     refusal" test.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRegister = jest.fn();
let mockListener: (() => void) | null = null;
let mockSessionState: unknown = { phase: "starting" };

jest.mock("../auth/session-store", () => ({
  getSessionState: () => mockSessionState,
  subscribeToSession: (fn: () => void) => {
    mockListener = fn;
    return () => {
      mockListener = null;
    };
  },
  sessionPort: { accessToken: async () => "bearer" },
}));

jest.mock("./push-registration", () => ({
  registerThisDeviceForPush: (...args: unknown[]) => mockRegister(...args),
}));

import { resetPushRegistrationBinding, startPushRegistration } from "./push-session-binding";

function signedIn(id: string): unknown {
  return { phase: "signed-in", user: { id } };
}

/** Let the `void`-ed promise inside the binding settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockRegister.mockReset();
  mockRegister.mockResolvedValue({ outcome: "registered" } as never);
  mockListener = null;
  mockSessionState = { phase: "starting" };
  resetPushRegistrationBinding();
});

describe("startPushRegistration", () => {
  it("registers from a session that was ALREADY restored before it subscribed", async () => {
    // The ordinary launch. `bootstrapSession()` runs from module scope and may
    // resolve first; a listener that only heard about future changes would
    // never register on any launch that was not a fresh sign-in.
    mockSessionState = signedIn("user-1");

    startPushRegistration();
    await flush();

    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("does not register while the store is still starting", () => {
    startPushRegistration();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("registers when the session becomes signed-in later", async () => {
    startPushRegistration();
    expect(mockRegister).not.toHaveBeenCalled();

    mockSessionState = signedIn("user-1");
    mockListener?.();
    await flush();

    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("does NOT register twice for one person, however often the store notifies", async () => {
    mockSessionState = signedIn("user-1");
    startPushRegistration();

    // The store notifies synchronously and more than once per sign-in. If the
    // marker were set after the await, each of these would start its own
    // registration while the first was still reading a token.
    mockListener?.();
    mockListener?.();
    mockListener?.();
    await flush();

    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("registers AGAIN when a different person signs in on the same phone", async () => {
    mockSessionState = signedIn("user-1");
    startPushRegistration();
    await flush();

    mockSessionState = { phase: "signed-out", reason: "user_action" };
    mockListener?.();
    mockSessionState = signedIn("user-2");
    mockListener?.();
    await flush();

    // The row's owner has to flip, or the second person's device keeps
    // delivering to the first person's notifications.
    expect(mockRegister).toHaveBeenCalledTimes(2);
  });

  it("retries after a failure rather than giving up until the app restarts", async () => {
    mockRegister.mockResolvedValue({ outcome: "failed", detail: "api: unreachable" } as never);
    mockSessionState = signedIn("user-1");
    startPushRegistration();
    await flush();
    expect(mockRegister).toHaveBeenCalledTimes(1);

    mockRegister.mockResolvedValue({ outcome: "registered" } as never);
    mockListener?.();
    await flush();

    expect(mockRegister).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a refusal — the person decided", async () => {
    mockRegister.mockResolvedValue({ outcome: "denied" } as never);
    mockSessionState = signedIn("user-1");
    startPushRegistration();
    await flush();

    mockListener?.();
    mockListener?.();
    await flush();

    // iOS shows its prompt once ever and Android 13+ stops after a refusal;
    // asking again is not something the OS would even honour.
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("does not treat 'unavailable' as a reason to keep trying either", async () => {
    mockRegister.mockResolvedValue({ outcome: "unavailable" } as never);
    mockSessionState = signedIn("user-1");
    startPushRegistration();
    await flush();

    mockListener?.();
    await flush();

    // This is the state of every installed build today. Retrying it on every
    // session notification would be a loop that can never succeed.
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("forgets who is registered whenever nobody is signed in", async () => {
    mockSessionState = signedIn("user-1");
    startPushRegistration();
    await flush();

    mockSessionState = { phase: "session-unverified", message: "..." };
    mockListener?.();
    mockSessionState = signedIn("user-1");
    mockListener?.();
    await flush();

    // Same person, but the session was rebuilt — and a rebuilt session is the
    // moment a token rotation would have been missed. Registering again is an
    // upsert on one row, so the cost is one request and the alternative is a
    // dead token nobody notices.
    expect(mockRegister).toHaveBeenCalledTimes(2);
  });

  it("returns an unsubscribe that actually stops it", async () => {
    const stop = startPushRegistration();
    stop();
    expect(mockListener).toBeNull();
  });
});
