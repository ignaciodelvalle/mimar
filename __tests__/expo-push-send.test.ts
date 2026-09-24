// Unit tests for the native (Expo) delivery leg — lib/infra/expo-push.ts.
//
// Covers the fail-soft send contract, which is the WEB leg's contract with one
// substitution (DeviceNotRegistered where web reads 404/410):
//   1. No EXPO_ACCESS_TOKEN → complete no-op, and NOT a throw.
//   2. The eligibility predicate gates this leg exactly as it gates the other.
//   3. A ticket with status 'ok' bumps last_used_at.
//   4. DeviceNotRegistered soft-revokes the target and is NOT reported.
//   5. Any other ticket error reports and leaves the row ALONE.
//   6. A whole-chunk transport failure reports and revokes NOTHING.
//   7. A token the SDK does not recognise never reaches the network.
//   8. Nothing ever throws to the caller, even when the device lookup fails.
//
// The SDK and the store are mocked, so this file needs no local stack and no
// Expo credential. What it CANNOT prove is that a real device lights up — only
// hardware answers that, and this file does not pretend otherwise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: expo-server-sdk
//
// `chunkPushNotifications` is the real shape (one chunk here) rather than a
// pass-through stub, because the positional zip between messages and tickets is
// the thing most likely to break and a stub that never splits would hide it.
// ---------------------------------------------------------------------------

const sendPushNotificationsAsyncMock = vi.fn();
const getPushNotificationReceiptsAsyncMock = vi.fn();

vi.mock("expo-server-sdk", () => {
  class FakeExpo {
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === "string" && token.startsWith("ExponentPushToken[");
    }
    chunkPushNotifications(messages: unknown[]): unknown[][] {
      return messages.length === 0 ? [] : [messages];
    }
    sendPushNotificationsAsync(messages: unknown[]) {
      return sendPushNotificationsAsyncMock(messages);
    }
    // The receipt half. Chunked the same way and for the same reason: one chunk
    // here, because splitting is the SDK's business and the code under test is
    // only required to consume whatever it is handed.
    chunkPushNotificationReceiptIds(ids: unknown[]): unknown[][] {
      return ids.length === 0 ? [] : [ids];
    }
    getPushNotificationReceiptsAsync(ids: unknown[]) {
      return getPushNotificationReceiptsAsyncMock(ids);
    }
  }
  return { Expo: FakeExpo };
});

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/report-error
// ---------------------------------------------------------------------------

const reportErrorMock = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock: the store. Its own rules are tested against real Postgres in
// __tests__/push-target-store.test.ts; here it is a seam, so that a failure in
// THIS file names the sender rather than the database.
// ---------------------------------------------------------------------------

let mockTargets: Array<{ id: string; expoPushToken: string }> = [];
let lookupShouldThrow = false;
const markedUsed: string[] = [];
/** Every (target, receipt id) pair a successful ticket recorded. */
const recordedReceipts: Array<{ targetId: string; receiptId: string | undefined }> = [];
const revokedIds: string[] = [];
/** What `pendingPushReceipts` will answer, and the limit it was asked for. */
let mockPending: Array<{ targetId: string; receiptId: string; pendingSince: Date | null }> = [];
const pendingLimits: number[] = [];
const clearedReceipts: Array<{ targetId: string; receiptId: string }> = [];

vi.mock("@/lib/infra/push-target-store", () => ({
  // THE USER ID IS ASSERTED, not discarded. This stub used to be
  // `async () => mockTargets`, which answers the same list for every caller —
  // so an implementation that looked up the WRONG person's devices, or that
  // passed no id at all, passed every test in this file. A stub that drops its
  // arguments can only prove a function was reached.
  activePushTargetsForUser: async (userId: string) => {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error(`activePushTargetsForUser called with no user id: ${String(userId)}`);
    }
    if (userId !== USER_ID) return [];
    if (lookupShouldThrow) throw new Error("db unavailable");
    return mockTargets;
  },
  markPushTargetUsed: async (id: string, receiptId?: string) => {
    markedUsed.push(id);
    recordedReceipts.push({ targetId: id, receiptId });
  },
  revokePushTargetById: async (id: string) => {
    revokedIds.push(id);
  },
  pendingPushReceipts: async (limit: number) => {
    pendingLimits.push(limit);
    return mockPending;
  },
  clearPendingPushReceipt: async (targetId: string, receiptId: string) => {
    clearedReceipts.push({ targetId, receiptId });
  },
}));

import { createHash } from "node:crypto";

import { PUSH_ANDROID_CHANNEL_ID } from "@dim/contract/input";

import { reconcileExpoPushReceipts, sendExpoPushForNotifications } from "@/lib/infra/expo-push";

const USER_ID = "user-0000-0000-0000-000000000001";
const URGENT = { userId: USER_ID, severity: "urgent" as const, title: "Hallazgo" };

function target(id: string, suffix = id) {
  return { id, expoPushToken: `ExponentPushToken[${suffix}]` };
}

function enableExpo() {
  vi.stubEnv("EXPO_ACCESS_TOKEN", "test-expo-access-token");
}

/**
 * THE AMBIENT ENVIRONMENT IS NOT ALLOWED TO DECIDE ANYTHING IN THIS FILE.
 *
 * `isExpoPushEnabled()` reads `process.env.EXPO_ACCESS_TOKEN`, and vitest loads
 * `.env.local`. So on a machine where somebody has put a real Expo credential
 * there — which is exactly the machine where this feature is being worked on —
 * every "no-ops when the credential is absent" test below ran with the
 * credential PRESENT and failed, while the same tests passed in CI and on every
 * other laptop.
 *
 * The fix is not to document the trap. It is to make the file answer the
 * question itself: each test declares the state it is testing, and the default
 * here is "absent". `vi.stubEnv` with an empty string is what `web-push-send.
 * test.ts` already does for its own flag, and the blank value is deliberately
 * the same one the "present but blank" test uses — the sender trims, so blank
 * and absent are one state by design.
 */
function disableExpo() {
  vi.stubEnv("EXPO_ACCESS_TOKEN", "");
}

beforeEach(() => {
  // FIRST, before any fixture. Every test in this file starts from a declared
  // environment; the ones that need the credential call `enableExpo()`.
  disableExpo();
  mockTargets = [];
  lookupShouldThrow = false;
  markedUsed.length = 0;
  revokedIds.length = 0;
  sendPushNotificationsAsyncMock.mockReset().mockResolvedValue([{ status: "ok", id: "receipt-1" }]);
  getPushNotificationReceiptsAsyncMock.mockReset().mockResolvedValue({});
  recordedReceipts.length = 0;
  mockPending = [];
  pendingLimits.length = 0;
  clearedReceipts.length = 0;
  reportErrorMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendExpoPushForNotifications — enablement", () => {
  it("no-ops when EXPO_ACCESS_TOKEN is absent", async () => {
    // `disableExpo()` in beforeEach is what makes this true regardless of what
    // .env.local holds. Before it, this test failed on exactly the machines
    // where somebody had configured the feature.
    mockTargets = [target("t1")];
    await sendExpoPushForNotifications([URGENT]);
    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
    // And it did not even look the devices up: a missing credential is not a
    // reason to spend a query.
    expect(markedUsed).toHaveLength(0);
  });

  it("no-ops when EXPO_ACCESS_TOKEN is present but blank", async () => {
    vi.stubEnv("EXPO_ACCESS_TOKEN", "   ");
    mockTargets = [target("t1")];
    await sendExpoPushForNotifications([URGENT]);
    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
  });

  it("does NOT read the web channel's flag", async () => {
    // The whole point of the guard that moved out of `sendPushForNotifications`:
    // a deployment with web push off must still reach phones.
    enableExpo();
    vi.stubEnv("NEXT_PUBLIC_PUSH_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([URGENT]);

    expect(sendPushNotificationsAsyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendExpoPushForNotifications — eligibility", () => {
  it("sends an urgent row", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    await sendExpoPushForNotifications([URGENT]);
    expect(sendPushNotificationsAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("skips a row that does not qualify, without looking anything up", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    await sendExpoPushForNotifications([{ userId: USER_ID, severity: "info", title: "Aviso" }]);
    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
  });

  it("sends a warning-severity pet_sighting, the one type the filter names", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "warning",
        notificationType: "pet_sighting",
        title: "Avistaje de Pampa",
      },
    ]);
    expect(sendPushNotificationsAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the person has no live device", async () => {
    enableExpo();
    mockTargets = [];
    await sendExpoPushForNotifications([URGENT]);
    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
  });
});

describe("sendExpoPushForNotifications — what it puts on the wire", () => {
  it("carries the title, the body and the deep link as data for a lock-screen-safe type", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        ...URGENT,
        notificationType: "rabies_observation_escalation_owner",
        title: "URGENTE — posible signo de rabia en tu mascota",
        body: "Consultá al veterinario inmediatamente.",
        ctaUrl: "/mis-mascotas/DIM-PAMP-0001",
      },
    ]);

    const [messages] = sendPushNotificationsAsyncMock.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe("ExponentPushToken[t1]");
    expect(messages[0].title).toBe("URGENTE — posible signo de rabia en tu mascota");
    expect(messages[0].body).toBe("Consultá al veterinario inmediatamente.");
    expect(messages[0].data).toEqual({ url: "/mis-mascotas/DIM-PAMP-0001" });
  });

  it("addresses the Android channel the app creates, by the shared constant", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([URGENT]);

    const [messages] = sendPushNotificationsAsyncMock.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    // THE TWO HALVES ARE ONE DESIGN AND THIS IS WHERE THEY MEET. The app calls
    // `setNotificationChannelAsync(PUSH_ANDROID_CHANNEL_ID, …)` and declares a
    // name, a description and an importance; without this field every message
    // lands in expo-notifications' unnamed fallback channel and all three apply
    // to nothing. The failure is silent — the notification still arrives — which
    // is exactly why it is pinned rather than trusted.
    expect(messages[0].channelId).toBe(PUSH_ANDROID_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// The lock-screen classification. Expo is a third-party processor in the United
// States and the title/body travel through it in the clear, so a type that has
// not been read and declared safe must not put its text on a lock screen.
//
// These assertions are about the DEFAULT, not about the two names currently on
// the allowlist: the ones that matter most are the two that use a type nobody
// has classified, because that is the shape a future type arrives in.
//
// AND ABOUT ONE CORRECTION THE DEFAULT DID NOT CATCH. Six types were on this
// allowlist while interpolating `${pet.name}` into their titles — a field
// nothing validates beyond "non-empty, at most 80 characters". The tests below
// pin each of the six as GENERIC, and one of them registers a pet whose name is
// a phishing line and asserts that the line never reaches the payload.
// ---------------------------------------------------------------------------

describe("sendExpoPushForNotifications — lock-screen PII (Ley 25.326 art. 12)", () => {
  function sentMessage(): Record<string, unknown> {
    const [messages] = sendPushNotificationsAsyncMock.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    return messages[0];
  }

  it("genericises a notification whose type carries a third party's personal data", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    // The real shape of a `pet_in_possession` body: the finder's name, their
    // phone, where they are holding the animal and what they typed.
    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType: "pet_in_possession",
        title: "Alguien tiene a Pampa",
        body: 'Laura Gómez dice que tiene a Pampa en Belgrano. Contactala al 11-5555-4444. Mensaje: "está en mi casa".',
        ctaUrl: "/mis-mascotas/DIM-PAMP-0001",
      },
    ]);

    const message = sentMessage();
    // The CATEGORY is named, the row's own strings are not (PO decision
    // 2026-09-16). "miMAR · Tenés un aviso nuevo" said nothing under a line
    // where the OS had already written "miMAR"; this says what happened
    // without saying who it happened to.
    expect(message.title).toBe("Alguien tiene a tu mascota");
    expect(message.body).toBe("Abrí miMAR para ver los detalles");
    // THE PROPERTY THIS TEST IS ACTUALLY FOR, unchanged and widened: nothing
    // anybody TYPED reaches the lock screen. The three below were here before;
    // the pet's name is new, and it is the one the allowlist's own docblock
    // argues hardest about — a name is a free-text field with no content
    // validation, so it is exactly what must not travel.
    expect(JSON.stringify(message)).not.toContain("Laura");
    expect(JSON.stringify(message)).not.toContain("11-5555-4444");
    expect(JSON.stringify(message)).not.toContain("Belgrano");
    expect(JSON.stringify(message)).not.toContain("Pampa");
    // The deep link survives: the app opens the right screen and fetches the
    // real content over an authenticated request.
    expect(message.data).toEqual({ url: "/mis-mascotas/DIM-PAMP-0001" });
  });

  it("genericises an UNKNOWN type — the default is closed, not open", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType: "some_type_invented_next_month",
        title: "Nombre de una persona",
        body: "Un dato personal de un tercero",
      },
    ]);

    expect(sentMessage().title).toBe("miMAR");
    expect(sentMessage().body).toBe("Tenés un aviso nuevo");
  });

  it("genericises a row with NO type at all", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([URGENT]);

    expect(sentMessage().title).toBe("miMAR");
    expect(sentMessage().body).toBe("Tenés un aviso nuevo");
  });

  it("names the CATEGORY for pet_sighting, and still renders none of its content", async () => {
    // The one type the eligibility filter names by hand is NOT on the
    // lock-screen allowlist: its body carries the finder's name and contact
    // (src/modules/pets/application/sighting/report-pet-sighting.ts:318-330).
    // Push-eligible and lock-screen-safe are two different questions, and a
    // third one joined them in 2026-09-16: a type can have a STATIC sentence
    // written for it here without being allowed to render its own. "Alguien
    // vio" and "alguien tiene" must not read alike — one means somebody saw
    // the animal, the other means somebody has it.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "warning",
        notificationType: "pet_sighting",
        title: "Avistaje de Pampa",
        body: "Laura Gómez dejó su contacto: 11-5555-4444.",
      },
    ]);

    expect(sentMessage().title).toBe("Alguien vio a tu mascota");
    expect(sentMessage().body).toBe("Abrí miMAR para ver los detalles");
    expect(JSON.stringify(sentMessage())).not.toContain("Laura");
    expect(JSON.stringify(sentMessage())).not.toContain("11-5555-4444");
    expect(JSON.stringify(sentMessage())).not.toContain("Pampa");
  });

  // -------------------------------------------------------------------------
  // A pet's name is free text, and six types used to render it on a lock
  // screen. Each of these pins the type as GENERIC; the first one is the attack
  // written out, so the failure is legible if somebody ever puts a type back.
  // -------------------------------------------------------------------------

  /** 39 characters. Passes `requiredText` and `PET_NAME_MAX` without a murmur. */
  const HOSTILE_PET_NAME = "miMAR: verificá tu cuenta en bit.ly/xY7";

  it("never puts a pet's name on the wire, even for an urgent allowlisted-looking type", async () => {
    // THE WHOLE FINDING, IN ONE TEST. `eno_disease_diagnosis` is urgent,
    // push-eligible, and was on the allowlist. Its title is
    // `ENO: ${disease.label} — ${petRow.name}`, and nothing validates that name
    // beyond non-empty and ≤ 80 characters — so an attacker registers a pet
    // named after their phishing line and the government official reading the
    // lock screen reads it instead of us.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType: "eno_disease_diagnosis",
        title: `ENO: Leptospirosis — ${HOSTILE_PET_NAME}`,
        body: "Diagnóstico de Leptospirosis reportado en La Plata. SLA: 24h.",
        ctaUrl: "/gob/vigilancia",
      },
    ]);

    const message = sentMessage();
    expect(message.title).toBe("miMAR");
    expect(message.body).toBe("Tenés un aviso nuevo");
    // Not "the title was replaced" — that a substring of a name a stranger
    // typed appears NOWHERE in what leaves this process.
    expect(JSON.stringify(message)).not.toContain(HOSTILE_PET_NAME);
    expect(JSON.stringify(message)).not.toContain("bit.ly");
    // And the doorbell still rings at the right door.
    expect(message.data).toEqual({ url: "/gob/vigilancia" });
  });

  it.each([
    "rabies_observation_pending_review",
    "microchip_fraud_detected",
    "microchip_updated_by_institution",
    "eno_disease_diagnosis",
    "eno_pet_disease_diagnosis",
    "disease_public_alert",
  ])("genericises %s, which renders a pet's name", async (notificationType) => {
    // One reason for all six, which is why they share one test: every one of
    // them interpolates `${pet.name}` into its title, and a pet name is typed.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType,
        title: `Algo sobre ${HOSTILE_PET_NAME}`,
        body: `Más sobre ${HOSTILE_PET_NAME}.`,
      },
    ]);

    expect(sentMessage().title).toBe("miMAR");
    expect(sentMessage().body).toBe("Tenés un aviso nuevo");
    expect(JSON.stringify(sentMessage())).not.toContain(HOSTILE_PET_NAME);
  });

  it("still renders the two types that name nobody and nothing", async () => {
    // The other half of the correction: shrinking the list must not have
    // emptied it. `outbreak_signal_detected` is a disease label, a species, a
    // PLACE and two integers — no person, no organisation, no pet.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType: "outbreak_signal_detected",
        title: "URGENTE — posible Rabia en La Plata",
        body: "- Especie: Perro\n- Match strength: 2 high · 1 medium",
        ctaUrl: "/gob/cola",
      },
    ]);

    expect(sentMessage().title).toBe("URGENTE — posible Rabia en La Plata");
    expect(sentMessage().body).toBe("- Especie: Perro\n- Match strength: 2 high · 1 medium");
  });

  // -------------------------------------------------------------------------
  // The collapse key. It travels to Expo, to Apple and to Google on every
  // message, genericised or not — so what it SAYS is as much a transfer as the
  // body is.
  // -------------------------------------------------------------------------

  /** What `collapseKeyFor` must produce. Recomputed, never pasted. */
  function expectedCollapseKey(dedupeKey: string): string {
    return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  }

  it("keeps collapsing when the payload is genericised, and says nothing while doing it", async () => {
    // Genericisation is about what a person READS. Replacing-instead-of-stacking
    // is about how many rows pile up, and the two must not move together — the
    // collapse key is still present and still derived from the dedupe key.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      {
        userId: USER_ID,
        severity: "urgent",
        notificationType: "pet_in_possession",
        title: "Alguien tiene a Pampa",
        body: "Laura Gómez dice que tiene a Pampa.",
        dedupeKey: `event:evt-1:${USER_ID}:pet_in_possession`,
      },
    ]);

    expect(sentMessage().collapseId).toBe(
      expectedCollapseKey(`event:evt-1:${USER_ID}:pet_in_possession`),
    );
    // Still genericised: the title is this type's STATIC category sentence, not
    // the row's own "Alguien tiene a Pampa". The two properties stay
    // independent, which is what this test is for.
    expect(sentMessage().title).toBe("Alguien tiene a tu mascota");
    expect(JSON.stringify(sentMessage())).not.toContain("Pampa");
    expect(JSON.stringify(sentMessage())).not.toContain("Laura");
  });

  it("does NOT ship the dedupe key's text — not the category, not the user id", async () => {
    // The finding. A real dedupe key is a sentence: it names the kind of event
    // and it carries the addressee's user id. Sending it alongside a body that
    // was blanked out on purpose hands Expo, Apple and Google a stable
    // pseudonymous identifier joined to "perro potencialmente peligroso".
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([{ ...URGENT, dedupeKey: `ppp-flip:pet-77:${USER_ID}` }]);

    const wire = JSON.stringify(sentMessage());
    expect(wire).not.toContain("ppp-flip");
    expect(wire).not.toContain(USER_ID);
    expect(wire).not.toContain("pet-77");
  });

  it("sets a STABLE collapse key from the dedupe key, so a retry replaces instead of stacking", async () => {
    // Stability is the property the feature needs and the property a hash
    // preserves: the same write, retried, must produce the same key.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([{ ...URGENT, dedupeKey: "hallazgo:pampa:2026-09-11" }]);
    const first = sentMessage().collapseId;

    sendPushNotificationsAsyncMock.mockClear();
    await sendExpoPushForNotifications([{ ...URGENT, dedupeKey: "hallazgo:pampa:2026-09-11" }]);

    expect(first).toBe(expectedCollapseKey("hallazgo:pampa:2026-09-11"));
    expect(sentMessage().collapseId).toBe(first);
    expect(typeof first).toBe("string");
  });

  it("gives two different dedupe keys two different collapse keys", async () => {
    // The other half of stability, and the one a constant would break: two
    // unrelated notifications must not eat each other on the shade.
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([
      { ...URGENT, dedupeKey: "hallazgo:pampa:2026-09-11" },
      { ...URGENT, dedupeKey: "hallazgo:pampa:2026-09-12" },
    ]);

    const [messages] = sendPushNotificationsAsyncMock.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    expect(messages[0].collapseId).not.toBe(messages[1].collapseId);
  });

  it("sends no collapse key at all when the row has no dedupe key", async () => {
    enableExpo();
    mockTargets = [target("t1")];

    await sendExpoPushForNotifications([URGENT]);

    // A digest of nothing would be a constant, and a constant collapse key
    // makes every notification replace every other one.
    expect(sentMessage().collapseId).toBeUndefined();
  });

  it("addresses every live device the person has", async () => {
    enableExpo();
    mockTargets = [target("t1"), target("t2")];

    await sendExpoPushForNotifications([URGENT]);

    const [messages] = sendPushNotificationsAsyncMock.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    expect(messages.map((m) => m.to)).toEqual(["ExponentPushToken[t1]", "ExponentPushToken[t2]"]);
  });
});

describe("sendExpoPushForNotifications — what it does with the tickets", () => {
  it("bumps last_used_at on a delivered ticket", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([{ status: "ok", id: "r1" }]);

    await sendExpoPushForNotifications([URGENT]);

    expect(markedUsed).toEqual(["t1"]);
    expect(revokedIds).toHaveLength(0);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("soft-revokes on DeviceNotRegistered, and does NOT report it", async () => {
    enableExpo();
    mockTargets = [target("gone"), target("ok")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([
      { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
      { status: "ok", id: "r2" },
    ]);

    await sendExpoPushForNotifications([URGENT]);

    // The dead device is revoked and the live one is bumped — which together
    // prove the positional zip between messages and tickets holds.
    expect(revokedIds).toEqual(["gone"]);
    expect(markedUsed).toEqual(["ok"]);
    // An uninstall is the ordinary end of an install's life. Reporting it would
    // make every uninstall an incident.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("reports any OTHER ticket error and leaves the row alone", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([
      { status: "error", message: "too big", details: { error: "MessageTooBig" } },
    ]);

    await sendExpoPushForNotifications([URGENT]);

    expect(revokedIds).toHaveLength(0);
    expect(markedUsed).toHaveLength(0);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("expo-push/ticket");
  });

  it("does not revoke a device because OUR credential was refused", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([
      { status: "error", message: "bad creds", details: { error: "InvalidCredentials" } },
    ]);

    await sendExpoPushForNotifications([URGENT]);

    // Revoking here would silence a working phone over a server-side problem,
    // and the person would have to reinstall to get notifications back.
    expect(revokedIds).toHaveLength(0);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendExpoPushForNotifications — failure containment", () => {
  it("reports and revokes NOTHING when the whole request fails", async () => {
    enableExpo();
    mockTargets = [target("t1"), target("t2")];
    sendPushNotificationsAsyncMock.mockRejectedValueOnce(new Error("network down"));

    await sendExpoPushForNotifications([URGENT]);

    // A transport failure says nothing about whether these devices exist.
    expect(revokedIds).toHaveLength(0);
    expect(markedUsed).toHaveLength(0);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("expo-push/send");
  });

  it("revokes a token the SDK does not recognise, without sending it", async () => {
    enableExpo();
    mockTargets = [{ id: "malformed", expoPushToken: "not-a-token" }];

    await sendExpoPushForNotifications([URGENT]);

    expect(sendPushNotificationsAsyncMock).not.toHaveBeenCalled();
    expect(revokedIds).toEqual(["malformed"]);
  });

  it("never throws even when the device lookup fails", async () => {
    enableExpo();
    lookupShouldThrow = true;

    await expect(sendExpoPushForNotifications([URGENT])).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("expo-push/send-all");
  });
});

// ---------------------------------------------------------------------------
// THE SECOND HALF OF A SEND — receipts
//
// A ticket says whether EXPO accepted the message. A receipt says what FCM and
// APNs did with it, and that is where `DeviceNotRegistered` arrives in the
// ordinary case, because Expo has not spoken to either store when it writes the
// ticket. Reading only tickets meant the revocation path existed and was almost
// never reached: dead rows accumulated forever and every send paid to address a
// phone that no longer exists.
// ---------------------------------------------------------------------------

/** Roughly an hour old: inside Expo's ~24h retention. */
function recently(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

describe("the ticket records the receipt id", () => {
  it("carries the id a successful ticket handed back", async () => {
    enableExpo();
    mockTargets = [target("t1")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([{ status: "ok", id: "receipt-abc" }]);

    await sendExpoPushForNotifications([URGENT]);

    // Without this the receipt is unreachable: the id exists only in the ticket,
    // on the request path, and the answer it unlocks is not ready for minutes.
    expect(recordedReceipts).toEqual([{ targetId: "t1", receiptId: "receipt-abc" }]);
  });

  it("records nothing for a device the ticket refused", async () => {
    enableExpo();
    mockTargets = [target("gone")];
    sendPushNotificationsAsyncMock.mockResolvedValueOnce([
      { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
    ]);

    await sendExpoPushForNotifications([URGENT]);

    // There is no receipt to wait for, and the row is already revoked.
    expect(recordedReceipts).toHaveLength(0);
    expect(revokedIds).toEqual(["gone"]);
  });
});

describe("reconcileExpoPushReceipts", () => {
  it("no-ops without EXPO_ACCESS_TOKEN, and does not even read the queue", async () => {
    mockPending = [{ targetId: "t1", receiptId: "r1", pendingSince: recently() }];

    await expect(reconcileExpoPushReceipts()).resolves.toEqual({
      checked: 0,
      revoked: 0,
      expired: 0,
    });
    expect(pendingLimits).toHaveLength(0);
  });

  it("revokes the device whose receipt says the token is dead", async () => {
    enableExpo();
    mockPending = [
      { targetId: "alive", receiptId: "r-alive", pendingSince: recently() },
      { targetId: "dead", receiptId: "r-dead", pendingSince: recently() },
    ];
    getPushNotificationReceiptsAsyncMock.mockResolvedValueOnce({
      "r-alive": { status: "ok" },
      "r-dead": {
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered" },
      },
    });

    const result = await reconcileExpoPushReceipts();

    // THE WHOLE POINT: the same revocation the ticket path performs, reached
    // from the channel the signal actually arrives on.
    expect(revokedIds).toEqual(["dead"]);
    expect(result).toEqual({ checked: 2, revoked: 1, expired: 0 });
    // An uninstall is the ordinary end of an install's life, not an incident.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("clears the pending id either way, so a row is asked about once", async () => {
    enableExpo();
    mockPending = [
      { targetId: "alive", receiptId: "r-alive", pendingSince: recently() },
      { targetId: "dead", receiptId: "r-dead", pendingSince: recently() },
    ];
    getPushNotificationReceiptsAsyncMock.mockResolvedValueOnce({
      "r-alive": { status: "ok" },
      "r-dead": {
        status: "error",
        message: "gone",
        details: { error: "DeviceNotRegistered" },
      },
    });

    await reconcileExpoPushReceipts();

    expect(clearedReceipts).toEqual([
      { targetId: "alive", receiptId: "r-alive" },
      { targetId: "dead", receiptId: "r-dead" },
    ]);
  });

  it("clears by RECEIPT id as well as row, so a newer send is not erased", async () => {
    // A push that lands while this job is running writes a newer id onto the
    // same row. The store's UPDATE matches on the id for that reason, and the
    // call has to carry it — asserted here because the alternative is silent:
    // an id nobody ever asked about, dropped with its answer.
    enableExpo();
    mockPending = [{ targetId: "t1", receiptId: "r-old", pendingSince: recently() }];
    getPushNotificationReceiptsAsyncMock.mockResolvedValueOnce({ "r-old": { status: "ok" } });

    await reconcileExpoPushReceipts();

    expect(clearedReceipts).toEqual([{ targetId: "t1", receiptId: "r-old" }]);
  });

  it("does NOT revoke over a failure that is not the device's fault", async () => {
    enableExpo();
    mockPending = [{ targetId: "t1", receiptId: "r1", pendingSince: recently() }];
    getPushNotificationReceiptsAsyncMock.mockResolvedValueOnce({
      r1: { status: "error", message: "bad creds", details: { error: "InvalidCredentials" } },
    });

    const result = await reconcileExpoPushReceipts();

    // Same rule the ticket path states: revoking somebody's working phone
    // because OUR credential expired is the worst reading of a server problem.
    expect(revokedIds).toHaveLength(0);
    expect(result.revoked).toBe(0);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("expo-push/receipt");
  });

  it("drops an id Expo can no longer answer for, without spending a request", async () => {
    enableExpo();
    // Two days old. Expo keeps receipts for roughly one, so asking buys an empty
    // answer and a row that stays pending forever.
    mockPending = [
      {
        targetId: "stale",
        receiptId: "r-stale",
        pendingSince: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    ];

    const result = await reconcileExpoPushReceipts();

    expect(getPushNotificationReceiptsAsyncMock).not.toHaveBeenCalled();
    expect(clearedReceipts).toEqual([{ targetId: "stale", receiptId: "r-stale" }]);
    expect(result).toEqual({ checked: 0, revoked: 0, expired: 1 });
  });

  it("keeps the ids pending when the whole request fails", async () => {
    enableExpo();
    mockPending = [{ targetId: "t1", receiptId: "r1", pendingSince: recently() }];
    getPushNotificationReceiptsAsyncMock.mockRejectedValueOnce(new Error("network down"));

    const result = await reconcileExpoPushReceipts();

    // Nothing cleared and nothing revoked: these ids are still owed an answer,
    // and the next run asks again. That retry is the one thing this shape buys
    // over reading receipts inline, and losing it would be losing the feature.
    expect(clearedReceipts).toHaveLength(0);
    expect(revokedIds).toHaveLength(0);
    expect(result).toEqual({ checked: 0, revoked: 0, expired: 0 });
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0][0]).toBe("expo-push/receipts");
  });

  it("ignores an answer for an id it never asked about", async () => {
    enableExpo();
    mockPending = [{ targetId: "t1", receiptId: "r1", pendingSince: recently() }];
    getPushNotificationReceiptsAsyncMock.mockResolvedValueOnce({
      r1: { status: "ok" },
      "r-somebody-elses": {
        status: "error",
        message: "gone",
        details: { error: "DeviceNotRegistered" },
      },
    });

    const result = await reconcileExpoPushReceipts();

    // The map from receipt id to row is what ties an answer to a device. Acting
    // without it would be revoking a device chosen by the response body.
    expect(revokedIds).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it("asks for a bounded batch rather than the whole table", async () => {
    enableExpo();
    mockPending = [];

    await reconcileExpoPushReceipts();

    expect(pendingLimits).toHaveLength(1);
    expect(pendingLimits[0]).toBeGreaterThan(0);
    // The job runs inside the daily dispatcher's shared 55 s budget; an
    // unbounded read is how one job starves the twenty-three others.
    expect(pendingLimits[0]).toBeLessThanOrEqual(1000);
  });
});
