// The `Idempotency-Key` reuse policy for `POST /api/v1/pets`.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------------------------------------------------------
// `createAttemptSession` takes an injected `generate` for one stated reason: so
// the reuse policy could be tested without `expo-crypto`, which cannot run under
// Jest. The seam was built and the test was never written — which means the
// policy the seam exists to protect had, until now, exactly nothing checking it.
//
// The policy is not arithmetic; it is a pair of opposite failures, and BOTH of
// them are silent:
//
//   · a NEW key per HTTP attempt turns the retry after a timeout — the one case
//     where the first request may well have committed — into a SECOND PET in the
//     national registry, on an append-only spine;
//   · the SAME key forever turns a real second animal into a replay, answered
//     201 `wasDuplicate: true`, and the pet the user just described is never
//     created.
//
// Neither shows up as an error. So the assertions here are about IDENTITY of the
// key across specific sequences, and each one names the sequence it stands for.

import { describe, expect, it } from "@jest/globals";

import { createAttemptSession } from "./idempotency";

/** A generator whose output is distinguishable per call, like a real UUID. */
function countingGenerator(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `key-${n}`;
  };
}

describe("createAttemptSession — one key per ATTEMPT, not per request", () => {
  it("hands back the SAME key on every read inside one attempt", () => {
    const session = createAttemptSession(countingGenerator());

    // Four reads: the first send, a timeout retry, a 503 retry, a "did it
    // work?" retry. Every one of those may reach a server that already
    // committed the pet.
    expect([session.key(), session.key(), session.key(), session.key()]).toEqual([
      "key-1",
      "key-1",
      "key-1",
      "key-1",
    ]);
  });

  it("generates LAZILY, so an abandoned wizard costs no key", () => {
    let calls = 0;
    const session = createAttemptSession(() => {
      calls += 1;
      return `key-${calls}`;
    });

    expect(calls).toBe(0);
    session.key();
    expect(calls).toBe(1);
    session.key();
    expect(calls).toBe(1);
  });

  it("gives a NEW key after restart() — the second real animal", () => {
    const session = createAttemptSession(countingGenerator());

    const first = session.key();
    session.restart();
    const second = session.key();

    // Without this, the second registration is answered as a replay of the
    // first: 201 `wasDuplicate: true`, and the animal the user just described
    // is never created.
    expect(second).not.toBe(first);
    expect(second).toBe("key-2");
  });

  it("restart() is the ONLY thing that changes the key", () => {
    const session = createAttemptSession(countingGenerator());

    const before = session.key();
    session.key();
    session.key();
    expect(session.key()).toBe(before);

    session.restart();
    expect(session.key()).not.toBe(before);
  });

  it("restarting twice in a row still yields one key per attempt", () => {
    const session = createAttemptSession(countingGenerator());

    session.restart(); // before the first key was ever read
    const first = session.key();
    session.restart();
    session.restart(); // a double-tap on "registrar otra"
    const second = session.key();

    expect(first).toBe("key-1");
    expect(second).toBe("key-2");
  });

  // THE 409 CASE, and the reason `duplicateOverride` has no key of its own.
  // Re-sending with `duplicateOverride: true` is the SAME registration answered
  // differently, not a new one. A fresh key there means a user who taps
  // "Registrar igual" on a flaky connection can end up with two pets — the exact
  // outcome the duplicate dialog exists to let them avoid.
  it("reuses the key when the 409 is overridden", () => {
    const session = createAttemptSession(countingGenerator());

    const firstSend = session.key();
    // …server answers 409 duplicate_suspected; the user taps "Registrar igual"…
    const overrideSend = session.key();
    // …that send times out and is retried…
    const overrideRetry = session.key();

    expect(overrideSend).toBe(firstSend);
    expect(overrideRetry).toBe(firstSend);
  });

  // The accepted cost, pinned so nobody "fixes" it into a duplicate-pet bug.
  // After a failed send the user may edit the form and submit again; that is
  // still the same attempt, so the key does not move. If the first request had
  // actually committed, the server replays it and returns the pet as first
  // described. A wrong name is a ten-second edit; a duplicate animal on an
  // append-only spine is a support case.
  it("reuses the key across an edit-and-resubmit within the same attempt", () => {
    const session = createAttemptSession(countingGenerator());

    const beforeEdit = session.key();
    // …send fails, user goes back and renames the pet, submits again…
    expect(session.key()).toBe(beforeEdit);
  });

  it("keeps two concurrent sessions independent", () => {
    // Not a flow the wizard produces today, but the store is a closure and this
    // is what makes "one key per attempt" true rather than "one key per module".
    const a = createAttemptSession(countingGenerator());
    const b = createAttemptSession(countingGenerator());

    expect(a.key()).toBe("key-1");
    expect(b.key()).toBe("key-1");
    a.restart();
    expect(a.key()).toBe("key-2");
    expect(b.key()).toBe("key-1");
  });
});
