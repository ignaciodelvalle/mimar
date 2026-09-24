// The two things on this screen that are arithmetic rather than layout: how old
// a snapshot is, and which of a section's states it is in.
//
// Neither needs a renderer, a device, or the network, which is the point of
// keeping `credential-view-model.ts` pure. The section tests are not
// ceremony — `lostView` has THREE outcomes where the payload has two `status`
// values, and the pair that a nullable field would collapse ("not lost" vs "we
// could not find out") is the pair that matters most on a public credential.

// `describe`/`it`/`expect` are IMPORTED, not ambient, and that is not a style
// preference — TypeScript 6 (which Expo SDK 57 pins) no longer auto-includes
// `@types/*` packages into the global scope, so `@types/jest` alone leaves
// every one of these names unresolved. Importing them is Jest's own documented
// modern pattern, it survives that change, and in a repo whose OTHER test
// runner is Vitest it says which one this file belongs to on line one.
import { describe, expect, it } from "@jest/globals";

import {
  type CredentialLostSection,
  type CredentialNoticesSection,
  PUBLIC_CREDENTIAL_STALE_AFTER_MS,
  type PublicCredentialV1,
} from "@dim/contract/api";

import {
  SECTION_UNAVAILABLE_MESSAGE,
  STALE_NOTICE,
  buildCredentialView,
  cachedCredentialNotice,
  cachedCredentialReason,
  describeFreshness,
  lostView,
  noticeLines,
  petStatusLabel,
  rabiesProvenanceLabel,
  rabiesVigenciaLabel,
  sectionView,
  situationLabel,
} from "./credential-view-model";

const ISSUED_AT = "2026-08-25T12:00:00.000Z";
const ISSUED_AT_MS = Date.parse(ISSUED_AT);

/** `issuedAt` + the contract's own window, which is what the server sends. */
const STALE_AFTER = new Date(ISSUED_AT_MS + PUBLIC_CREDENTIAL_STALE_AFTER_MS).toISOString();

const at = (offsetMs: number): Date => new Date(ISSUED_AT_MS + offsetMs);

const noNotices: CredentialNoticesSection = {
  emergencyMedical: false,
  officialCustody: null,
  custodyDispute: false,
  potentiallyDangerousBreed: false,
  rabiesObservation: null,
  serviceDog: null,
  permanentConditions: null,
};

const lostData: CredentialLostSection = {
  since: ISSUED_AT,
  color: "negro",
  distinguishingFeatures: null,
  owner: { firstName: "Ignacio", phoneE164: "+5491100000000", email: null },
  caretakerContact: null,
  lastSeen: null,
  description: null,
  tattoo: null,
  allowFinderForm: true,
  allowSighting: true,
};

function payload(overrides: Partial<PublicCredentialV1> = {}): PublicCredentialV1 {
  return {
    payloadVersion: 1,
    issuedAt: ISSUED_AT,
    staleAfter: STALE_AFTER,
    publicToken: "DIM-PAMP-0001",
    identity: {
      status: "ok",
      data: {
        name: "Pampa",
        species: "dog",
        breed: "Caniche",
        sex: "female",
        ageYears: 4,
        photoUrl: null,
        libretaCode: "LIB-AR-DIM-PAMP-0001",
        hasMicrochip: true,
        hasTattoo: false,
        registryBacked: false,
      },
    },
    status: { status: "ok", data: { status: "active", situation: null } },
    vaccination: {
      status: "ok",
      data: {
        hasRecords: true,
        rabies: { vigencia: "vigente", provenance: "profesional" },
        confidence: "professional_verified",
      },
    },
    notices: { status: "ok", data: noNotices },
    lost: { status: "ok", data: null },
    tier2: {
      status: "ok",
      data: { enabled: true, permanent: true, enabledUntil: null, medical: "not_included" },
    },
    ...overrides,
  };
}

describe("describeFreshness", () => {
  it("says 'recién' under a minute", () => {
    const freshness = describeFreshness(payload(), at(59_000));
    expect(freshness).toMatchObject({ state: "fresh", label: "actualizado recién" });
  });

  it("pluralizes minutes in es-AR", () => {
    expect(describeFreshness(payload(), at(60_000)).label).toBe("actualizado hace 1 minuto");
    expect(describeFreshness(payload(), at(120_000)).label).toBe("actualizado hace 2 minutos");
  });

  it("rounds DOWN, so it never claims a snapshot is newer than it is", () => {
    // 119s is one minute and fifty-nine seconds. "hace 2 minutos" would be
    // closer, and would also be a claim the payload does not support.
    expect(describeFreshness(payload(), at(119_000)).label).toBe("actualizado hace 1 minuto");
  });

  it("switches to hours and days", () => {
    expect(describeFreshness(payload(), at(3_600_000)).label).toBe("actualizado hace 1 hora");
    expect(describeFreshness(payload(), at(7_200_000)).label).toBe("actualizado hace 2 horas");
    expect(describeFreshness(payload(), at(86_400_000)).label).toBe("actualizado hace 1 día");
    expect(describeFreshness(payload(), at(2 * 86_400_000)).label).toBe("actualizado hace 2 días");
  });

  it("is fresh right up to staleAfter and stale at it", () => {
    expect(describeFreshness(payload(), at(PUBLIC_CREDENTIAL_STALE_AFTER_MS - 1)).state).toBe(
      "fresh",
    );
    expect(describeFreshness(payload(), at(PUBLIC_CREDENTIAL_STALE_AFTER_MS)).state).toBe("stale");
  });

  it("obeys the SERVER's staleAfter, not the client's constant", () => {
    // A server that shortened its window to one minute must win: a client that
    // recomputes the deadline from its own constant silently ignores it.
    // NON-VACUITY GUARD, not an assertion about the code: if the contract ever
    // shortens its own window below 61s, the check underneath would pass for
    // the wrong reason — the client constant and the server value would agree,
    // and the test would stop distinguishing them. This fails first and says so.
    expect(61_000).toBeLessThan(PUBLIC_CREDENTIAL_STALE_AFTER_MS);

    const shortWindow = payload({ staleAfter: new Date(ISSUED_AT_MS + 60_000).toISOString() });
    expect(describeFreshness(shortWindow, at(61_000)).state).toBe("stale");
  });

  it("falls back to the contract constant when staleAfter is unusable", () => {
    const broken = payload({ staleAfter: "not-a-date" });
    expect(describeFreshness(broken, at(PUBLIC_CREDENTIAL_STALE_AFTER_MS - 1)).state).toBe("fresh");
    expect(describeFreshness(broken, at(PUBLIC_CREDENTIAL_STALE_AFTER_MS)).state).toBe("stale");
  });

  it("reports 'unknown' rather than inventing a freshness", () => {
    const freshness = describeFreshness(payload({ issuedAt: "" }), at(0));
    expect(freshness.state).toBe("unknown");
    expect(freshness.label).not.toContain("hace");
  });

  it("clamps a skewed clock to zero instead of showing a negative age", () => {
    // Phone clock behind the server: the payload is stamped in its future.
    const freshness = describeFreshness(payload(), at(-90_000));
    expect(freshness).toMatchObject({ ageMs: 0, label: "actualizado recién" });
  });
});

describe("sectionView", () => {
  it("carries the data through on ok", () => {
    expect(sectionView({ status: "ok", data: 42 })).toEqual({ state: "ok", data: 42 });
  });

  it("turns unavailable into es-AR copy, never into empty data", () => {
    expect(sectionView({ status: "unavailable" })).toEqual({
      state: "unavailable",
      message: SECTION_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("lostView — the three states", () => {
  it("distinguishes 'not lost' from 'we could not find out'", () => {
    // This is the assertion the whole per-section contract exists for. If these
    // two ever compare equal, the screen tells a finder that an animal whose
    // owner is searching for it is fine.
    const notLost = lostView({ status: "ok", data: null });
    const unknown = lostView({ status: "unavailable" });

    expect(notLost).toEqual({ state: "not-lost" });
    expect(unknown).toEqual({ state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE });
    expect(notLost).not.toEqual(unknown);
  });

  it("surfaces the search when the pet is lost", () => {
    expect(lostView({ status: "ok", data: lostData })).toEqual({
      state: "lost",
      data: lostData,
    });
  });
});

describe("buildCredentialView", () => {
  it("maps every section and reads the name from identity", () => {
    const view = buildCredentialView(payload(), at(0));
    expect(view.petName).toBe("Pampa");
    expect(view.publicToken).toBe("DIM-PAMP-0001");
    expect(view.identity.state).toBe("ok");
    expect(view.lost.state).toBe("not-lost");
  });

  it("reports a null name — not an empty string — when identity is unavailable", () => {
    const view = buildCredentialView(payload({ identity: { status: "unavailable" } }), at(0));
    expect(view.petName).toBeNull();
    expect(view.identity.state).toBe("unavailable");
  });

  it("keeps sections independent — one failure does not blank the others", () => {
    const view = buildCredentialView(
      payload({ notices: { status: "unavailable" }, vaccination: { status: "unavailable" } }),
      at(0),
    );
    expect(view.notices.state).toBe("unavailable");
    expect(view.vaccination.state).toBe("unavailable");
    expect(view.identity.state).toBe("ok");
    expect(view.status.state).toBe("ok");
  });
});

describe("noticeLines", () => {
  it("returns nothing for a LOADED section with no notices raised", () => {
    expect(noticeLines(noNotices)).toEqual([]);
  });

  it("renders each notice it is given", () => {
    const lines = noticeLines({
      ...noNotices,
      emergencyMedical: true,
      officialCustody: { authorityName: "Zoonosis CABA" },
      potentiallyDangerousBreed: true,
      rabiesObservation: { windowExpired: true },
      serviceDog: { rabiesAtRisk: false },
      permanentConditions: { codes: ["ceguera"], other: "cadera" },
    });

    expect(lines).toHaveLength(6);
    expect(lines).toContain("Alerta médica publicada por el titular.");
    expect(lines).toContain("Bajo custodia oficial (Zoonosis CABA).");
    expect(lines).toContain("Observación antirrábica con plazo vencido.");
    expect(lines).toContain("Condiciones permanentes: ceguera, cadera.");
  });

  it("omits the authority when the payload does not disclose one", () => {
    expect(noticeLines({ ...noNotices, officialCustody: { authorityName: null } })).toEqual([
      "Bajo custodia oficial.",
    ]);
  });
});

describe("es-AR labels", () => {
  it("covers every status and situation the endpoint can emit", () => {
    expect(petStatusLabel("active")).toBe("Activa");
    expect(petStatusLabel("lost")).toBe("Perdida");
    expect(petStatusLabel("deceased")).toBe("Fallecida");

    expect(situationLabel("perdida")).toBe("Perdida");
    expect(situationLabel("custodia-oficial")).toBe("Bajo custodia oficial");
    expect(situationLabel("observacion-antirrabica")).toBe("En observación antirrábica");
    expect(situationLabel("fallecida")).toBe("Fallecida");
  });

  it("never states a rabies vigencia without its provenance", () => {
    expect(rabiesVigenciaLabel("vigente")).toBe("Vigente");
    expect(rabiesVigenciaLabel("none")).toBe("Sin registro");
    // "Vigente" alone would claim a verification this registry never performed.
    expect(rabiesProvenanceLabel("declarada")).toBe("declarada por el titular");
    expect(rabiesProvenanceLabel("profesional")).toBe("carga profesional");
  });
});

describe("cachedCredentialNotice — the offline banner", () => {
  const issuedAt = "2026-08-25T12:00:00.000Z";
  const staleAfter = "2026-08-25T12:05:00.000Z";
  const at = (iso: string) => new Date(iso);

  it("names the age and the fact that this came from disk", () => {
    const freshness = describeFreshness({ issuedAt, staleAfter }, at("2026-08-25T12:03:00.000Z"));
    const notice = cachedCredentialNotice(freshness);
    expect(notice.headline).toBe("actualizado hace 3 minutos · sin conexión");
    expect(notice.warning).toBeNull();
  });

  it("warns when the SERVER's staleAfter has passed", () => {
    // The judgement is the server's, not ours: `staleAfter` is what the payload
    // declares, and this app must not invent a different expiry.
    const freshness = describeFreshness({ issuedAt, staleAfter }, at("2026-08-25T15:00:00.000Z"));
    const notice = cachedCredentialNotice(freshness);
    expect(notice.headline).toBe("actualizado hace 3 horas · sin conexión");
    expect(notice.warning).toBe(STALE_NOTICE);
  });

  it("ALWAYS produces a headline, so a cached credential can never render bare", () => {
    // The one failure this banner exists to prevent: presenting a rabies status
    // that reads "Vigente" and expired last month, on a screen that gives no
    // hint it is not live.
    const cases = [
      describeFreshness({ issuedAt, staleAfter }, at("2026-08-25T12:00:00.000Z")),
      describeFreshness({ issuedAt, staleAfter }, at("2026-09-25T12:00:00.000Z")),
      describeFreshness({ issuedAt: "not-a-date", staleAfter }, at(issuedAt)),
      describeFreshness({ issuedAt, staleAfter: "not-a-date" }, at(issuedAt)),
    ];
    for (const freshness of cases) {
      const notice = cachedCredentialNotice(freshness);
      expect(notice.headline.trim().length).toBeGreaterThan(0);
      expect(notice.headline).toContain("sin conexión");
    }
  });

  it("does not compose the unknown-age sentence into a fragment", () => {
    // `describeFreshness` answers "No se pudo determinar la antigüedad." there,
    // and "No se pudo determinar la antigüedad. · sin conexión" is not a
    // sentence anybody wrote.
    const freshness = describeFreshness({ issuedAt: "nope", staleAfter }, at(issuedAt));
    expect(freshness.state).toBe("unknown");
    const notice = cachedCredentialNotice(freshness);
    expect(notice.headline).toBe("Copia guardada en este dispositivo · sin conexión");
    expect(notice.warning).not.toBeNull();
  });

  it("falls back to the contract's own stale window when staleAfter is unreadable", () => {
    // PUBLIC_CREDENTIAL_STALE_AFTER_MS is the contract's answer to "how long is
    // a snapshot good for". A client that invented its own number would draw a
    // different line than the server on the same payload.
    const justInside = new Date(Date.parse(issuedAt) + PUBLIC_CREDENTIAL_STALE_AFTER_MS - 1_000);
    const justOutside = new Date(Date.parse(issuedAt) + PUBLIC_CREDENTIAL_STALE_AFTER_MS + 1_000);
    expect(
      cachedCredentialNotice(describeFreshness({ issuedAt, staleAfter: "x" }, justInside)).warning,
    ).toBeNull();
    expect(
      cachedCredentialNotice(describeFreshness({ issuedAt, staleAfter: "x" }, justOutside)).warning,
    ).toBe(STALE_NOTICE);
  });
});

// ---------------------------------------------------------------------------
// A3-documento-credencial-02 — THE BANNER NAMES THE ACTUAL REASON
// ---------------------------------------------------------------------------

describe("cachedCredentialNotice — why the live read failed", () => {
  const fresh = describeFreshness(
    { issuedAt: "2026-09-06T12:00:00.000Z", staleAfter: "2026-09-06T12:00:30.000Z" },
    new Date("2026-09-06T12:00:10.000Z"),
  );

  it("says 'sin conexión' only when there was no connection", () => {
    expect(cachedCredentialNotice(fresh, "offline").headline).toContain("sin conexión");
  });

  it("names the SERVER for a refusal, and the app for a version it cannot read", () => {
    // Somebody in a vet's waiting room with four bars was told to check their
    // connection, and the action actually available to them — wait, or update
    // the app — was never named.
    const server = cachedCredentialNotice(fresh, "server").headline;
    expect(server).toContain("servidor no disponible");
    expect(server).not.toContain("sin conexión");

    const version = cachedCredentialNotice(fresh, "version").headline;
    expect(version).toContain("actualizar la app");
    expect(version).not.toContain("sin conexión");
  });

  it("maps every failed outcome to a reason", () => {
    expect(cachedCredentialReason("unreachable")).toBe("offline");
    expect(cachedCredentialReason("api-error")).toBe("server");
    expect(cachedCredentialReason("degraded")).toBe("server");
    expect(cachedCredentialReason("unsupported-version")).toBe("version");
    expect(cachedCredentialReason("malformed")).toBe("unreadable");
  });

  it("keeps the stale warning whatever the reason was", () => {
    // The reason is about the READ; the warning is about the AGE of what is on
    // screen. Naming one must not silence the other.
    const stale = describeFreshness(
      { issuedAt: "2026-09-01T12:00:00.000Z", staleAfter: "2026-09-01T12:00:30.000Z" },
      new Date("2026-09-06T12:00:00.000Z"),
    );
    expect(cachedCredentialNotice(stale, "server").warning).not.toBeNull();
  });
});
