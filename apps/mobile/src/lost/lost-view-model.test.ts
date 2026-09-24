// `lost-view-model` — the mapping between a search and what a person reads.
//
// The render test beside this one proves the screen wires up; these prove the
// DECISIONS the mapping makes, which are the ones a screen test would only reach
// through six taps each — and two of them are privacy decisions, which is the
// kind that must not depend on somebody remembering to tap.

import { describe, expect, it } from "@jest/globals";

import type { LostDisclosureV1, LostFeedItemV1, PetLostV1 } from "@dim/contract/api";
import { CONTENT_REPORT_CATEGORIES } from "@dim/contract/events";

import {
  DISCLOSURE_TITULAR_ONLY_NOTE,
  POSTER_UNAVAILABLE_NOTE,
  REPORT_ACTION_LABEL,
  REPORT_CATEGORY_OPTIONS,
  REPORT_INTRO,
  buildMarkLost,
  buildReportContent,
  buildReportLastSeen,
  buildSetDisclosure,
  commandDoneLabel,
  commandUnchangedLabel,
  disclosureHelp,
  disclosureLabel,
  disclosureRows,
  emptyLostDraft,
  feedItemContact,
  feedItemDetail,
  feedItemReportable,
  feedItemTitle,
  feedTruncationNote,
  foundAdjective,
  lostAdjective,
  lostInputCodeMessage,
  reportCategoryLabel,
  shareSearchMessage,
  situationHeadline,
} from "./lost-view-model";

const DISCLOSURE: LostDisclosureV1 = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
  discloseCaretakerContactWhenLost: false,
};

function view(overrides: Partial<PetLostV1> = {}): PetLostV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    publicToken: "DIM-PAMP-0001",
    petName: "Pampa",
    petSex: "female",
    status: "active",
    episode: null,
    disclosure: DISCLOSURE,
    capabilities: {
      canMarkLost: true,
      canReportLastSeen: false,
      canMarkFound: false,
      canReactivateSearch: false,
      canReportContent: true,
      editableDisclosureKeys: [
        "discloseFirstNameWhenLost",
        "disclosePhoneWhenLost",
        "discloseEmailWhenLost",
        "discloseLastLocationWhenLost",
        "allowFinderFormWhenLost",
        "discloseCaretakerContactWhenLost",
      ],
    },
    feed: { items: [], truncated: false, totalScans: 0, totalSightings: 0 },
    ...overrides,
  };
}

const EPISODE = {
  publicCode: "LOS-00042",
  openedAt: "2026-08-20T12:00:00.000Z",
  placeName: "Plaza San Martín",
  ownerNote: "Se escapó por el portón",
  lastSeenAt: "2026-08-21T15:00:00.000Z",
  lastSeenLat: -36.6167,
  lastSeenLng: -64.2833,
  jurisdictionLocality: "Santa Rosa",
  sightingsCount: 3,
};

describe("the gendered words, which are the whole reason petSex is on the wire", () => {
  it("says perdido, perdida, or names both when nobody said", () => {
    expect(lostAdjective("male")).toBe("perdido");
    expect(lostAdjective("female")).toBe("perdida");
    expect(lostAdjective(null)).toBe("perdido/a");
    expect(foundAdjective("male")).toBe("encontrado");
    expect(foundAdjective("female")).toBe("encontrada");
    expect(foundAdjective(null)).toBe("encontrada/o");
  });
});

describe("situationHeadline — the three states, and the one people find confusing", () => {
  it("names the animal and its state when it is not lost", () => {
    expect(situationHeadline(view())).toBe("Pampa no está perdida.");
  });

  it("says the search is ACTIVE when an episode is open", () => {
    expect(situationHeadline(view({ status: "lost", episode: EPISODE }))).toContain(
      "La búsqueda está activa",
    );
  });

  it("says a STALE search is closed AND that the animal is still lost", () => {
    // `status: "lost"` with no open episode is the auto-close state: the cron
    // closes the case and deliberately leaves the status alone, because an
    // automatic sweep must never declare an animal found. A headline that said
    // only "perdida" would leave somebody wondering why they cannot log a
    // sighting.
    const line = situationHeadline(view({ status: "lost", episode: null }));
    expect(line).toContain("se cerró por inactividad");
    expect(line).toContain("sigue marcada como perdida");
  });

  it("says a deceased animal is deceased rather than talking about a search", () => {
    expect(situationHeadline(view({ status: "deceased" }))).toContain("fallecida");
  });
});

describe("shareSearchMessage — what leaves the owner's phone when they spread the search", () => {
  const URL = "https://mimar.example/p/DIM-PAMP-0001";

  it("names the animal, carries the URL verbatim, and genders the adjective", () => {
    const line = shareSearchMessage(view({ status: "lost", episode: EPISODE }), URL);
    expect(line).toContain("Pampa");
    expect(line).toContain("perdida");
    expect(line).toContain(URL);
    expect(shareSearchMessage(view({ petSex: "male" }), URL)).toContain("perdido");
    expect(shareSearchMessage(view({ petSex: null }), URL)).toContain("perdido/a");
  });

  it("carries NOTHING a disclosure toggle governs — the URL is the whole payload", () => {
    // The message outlives every toggle the moment it lands in a group chat;
    // the credential page obeys them at read time, so it alone carries them.
    const line = shareSearchMessage(view({ status: "lost", episode: EPISODE }), URL);
    expect(line).not.toContain(EPISODE.placeName);
    expect(line).not.toContain(EPISODE.jurisdictionLocality);
    expect(line).not.toContain(EPISODE.ownerNote);
    expect(line).not.toContain(EPISODE.publicCode);
  });
});

describe("the disclosure rows — the privacy surface", () => {
  it("marks a preference this caller may NOT change instead of hiding it", () => {
    // Hiding it leaves a caretaker wondering whether the setting exists; a live
    // switch that answers 403 is a control that lies. The third option is the
    // honest one.
    const rows = disclosureRows(DISCLOSURE, [
      "discloseFirstNameWhenLost",
      "disclosePhoneWhenLost",
      "discloseEmailWhenLost",
      "discloseLastLocationWhenLost",
      "allowFinderFormWhenLost",
    ]);
    expect(rows).toHaveLength(6);
    const caretakerRow = rows.find((r) => r.key === "discloseCaretakerContactWhenLost");
    expect(caretakerRow?.editable).toBe(false);
    expect(rows.filter((r) => r.editable)).toHaveLength(5);
  });

  it("gives every preference a label AND a sentence saying who sees it", () => {
    // A toggle labelled only "Mostrar mi teléfono" does not say to whom, and the
    // answer — anyone who scans the QR — is the entire decision.
    for (const row of disclosureRows(DISCLOSURE, [])) {
      expect(disclosureLabel(row.key).length).toBeGreaterThan(0);
      expect(disclosureHelp(row.key).length).toBeGreaterThan(0);
    }
    expect(disclosureHelp("disclosePhoneWhenLost")).toContain("escanee el QR");
    expect(disclosureHelp("discloseCaretakerContactWhenLost")).toContain("consentimiento");
    expect(DISCLOSURE_TITULAR_ONLY_NOTE.length).toBeGreaterThan(0);
  });
});

describe("buildMarkLost — the five toggles are STATED, never inherited", () => {
  it("starts every owner-PII toggle off, and only the finder form on", () => {
    // Publishing an owner's phone to anyone who scans a QR is a decision
    // somebody makes, not a default they discover afterwards.
    // `allowFinderFormWhenLost` publishes nothing about the owner — it only
    // decides whether a finder can write at all — and its column default is
    // `true`.
    const draft = emptyLostDraft();
    expect(draft.disclosure).toEqual({
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: true,
    });
  });

  it("sends all five every time, so the server never has to inherit", () => {
    const built = buildMarkLost(emptyLostDraft());
    expect(built.ok).toBe(true);
    expect(built.ok && built.input).toMatchObject({
      command: "mark_lost",
      disclosure: emptyLostDraft().disclosure,
    });
  });

  describe("the jurisdiction of the disappearance", () => {
    const picked = {
      provinceCode: "AR-X",
      localityName: "Villa Carlos Paz",
      localityIndecId: "14014010",
    };

    it("sends the trio the picker filled in", () => {
      const built = buildMarkLost({ ...emptyLostDraft(), ...picked });
      expect(built.ok && built.input).toMatchObject(picked);
    });

    it("sends three nulls when nobody chose a locality", () => {
      // "No sé exactamente dónde" is a real answer. The server falls back to the
      // animal's home jurisdiction, which is defined behaviour and not a hole.
      const built = buildMarkLost(emptyLostDraft());
      expect(built.ok && built.input).toMatchObject({
        provinceCode: null,
        localityName: null,
        localityIndecId: null,
      });
    });

    it("DROPS a partial trio rather than sending a place that does not exist", () => {
      // The writer falls back FIELD BY FIELD, so a province with no locality
      // would route the case to (new province, pet's locality) — a pair naming
      // nowhere, on a record an authority acts on. The picker cannot produce a
      // partial set; this refuses one anyway, because the cost of being wrong
      // lands on somebody looking for their dog.
      for (const partial of [
        { provinceCode: picked.provinceCode },
        { localityName: picked.localityName },
        { provinceCode: picked.provinceCode, localityName: picked.localityName },
      ]) {
        const built = buildMarkLost({ ...emptyLostDraft(), ...partial });
        expect(built.ok && built.input).toMatchObject({
          provinceCode: null,
          localityName: null,
          localityIndecId: null,
        });
      }
    });
  });

  it("OMITS the incident snapshot entirely when nothing was filled in", () => {
    // The writer branches on whether the section exists to decide if it builds a
    // `lost_description`. A block of six nulls is not the same fact as no block.
    const built = buildMarkLost(emptyLostDraft());
    expect(built.ok && built.input).toMatchObject({ enrichedDescription: null });
  });

  it("sends the snapshot when ANY one field was filled in", () => {
    const built = buildMarkLost({ ...emptyLostDraft(), behaviorNotes: "Es miedosa" });
    expect(built.ok && built.input).toMatchObject({
      enrichedDescription: { behaviorNotes: "Es miedosa", color: null, microchipId: null },
    });
  });

  it("turns every untouched optional into null, not into an empty string", () => {
    // A `""` on the wire would be a STATED empty value where the person stated
    // nothing.
    const built = buildMarkLost({ ...emptyLostDraft(), locationDescription: "   " });
    expect(built.ok && built.input).toMatchObject({ locationDescription: null, reason: null });
  });

  it("sends NO coordinates at all — this build has no map", () => {
    const built = buildMarkLost({ ...emptyLostDraft(), locationDescription: "Plaza" });
    expect(built.ok && built.input).not.toHaveProperty("locationLat");
  });
});

describe("buildReportLastSeen", () => {
  it("carries the place and the note separately, as the payload needs them", () => {
    const built = buildReportLastSeen({
      ...emptyLostDraft(),
      locationDescription: "Cerca de la plaza",
      note: "La vio un vecino",
    });
    expect(built.ok && built.input).toEqual({
      command: "report_last_seen",
      locationDescription: "Cerca de la plaza",
      note: "La vio un vecino",
      locationLat: undefined,
      locationLng: undefined,
    });
  });

  it("accepts a completely empty update — the server supplies the fallback text", () => {
    expect(buildReportLastSeen(emptyLostDraft()).ok).toBe(true);
  });
});

describe("buildSetDisclosure", () => {
  it("always states the value it wants, never a toggle-by-omission", () => {
    // A command that flipped whatever was there would make a retry after a
    // timeout undo the thing it was retrying.
    const built = buildSetDisclosure("disclosePhoneWhenLost", true);
    expect(built.ok && built.input).toEqual({
      command: "set_disclosure",
      key: "disclosePhoneWhenLost",
      value: true,
    });
  });
});

describe("the feed", () => {
  it("says how many times a QR was scanned without counting rows", () => {
    // A burst is ONE row carrying its count.
    expect(feedItemTitle({ kind: "scan", id: "s", at: "", count: 1, localityLabel: null })).toBe(
      "Escanearon su QR",
    );
    expect(
      feedItemTitle({ kind: "scan", id: "s", at: "", count: 4, localityLabel: null }),
    ).toContain("4 veces");
  });

  it("names the finder row as the one that ends the search", () => {
    const finder = {
      kind: "finder" as const,
      id: "f",
      at: "",
      finderName: "Vecina",
      finderContact: "11-5555-5555",
      petCondition: "bien",
      localityLabel: "Santa Rosa",
      message: "La tengo en casa",
      availabilityLabel: "indefinido",
      hasPhoto: true,
    };
    expect(feedItemTitle(finder)).toBe("Vecina dice que la tiene");
    expect(feedItemDetail(finder)).toContain("La tengo en casa");
    // The lead an owner follows. Withholding it here would make the app the one
    // surface where a lead cannot be followed.
    expect(feedItemContact(finder)).toBe("11-5555-5555");
  });

  it("returns null rather than an empty string when a row has nothing to add", () => {
    expect(
      feedItemDetail({ kind: "scan", id: "s", at: "", count: 1, localityLabel: null }),
    ).toBeNull();
    expect(
      feedItemContact({ kind: "scan", id: "s", at: "", count: 1, localityLabel: null }),
    ).toBeNull();
  });

  it("owes a note when the list was capped, and none when it was not", () => {
    expect(feedTruncationNote(false)).toBeNull();
    expect(feedTruncationNote(true)).toContain("Puede haber más");
  });
});

describe("the copy every branch owes", () => {
  it("has a sentence for a command that changed something and one for a no-op", () => {
    for (const command of [
      "mark_lost",
      "report_last_seen",
      "mark_found",
      "reactivate_search",
      "set_disclosure",
      "report_content",
    ] as const) {
      expect(commandDoneLabel(command, "female").length).toBeGreaterThan(0);
      expect(commandUnchangedLabel(command).length).toBeGreaterThan(0);
    }
  });

  it("says the animal came home in the right gender", () => {
    expect(commandDoneLabel("mark_found", "male")).toContain("encontrado");
    expect(commandDoneLabel("mark_found", "female")).toContain("encontrada");
  });

  it("says SOMETHING even when the contract named nothing", () => {
    expect(lostInputCodeMessage(null).length).toBeGreaterThan(0);
  });

  it("explains where the poster lives instead of leaving a gap", () => {
    // The cartel resolves the titular's own name and phone with a query narrower
    // than this screen's guard and embeds a server-generated QR; a native copy
    // would be a second implementation of a privacy filter.
    expect(POSTER_UNAVAILABLE_NOTE).toContain("web");
  });
});

// ---------------------------------------------------------------------------
// Reportar — the rule that decides where the affordance may appear
// ---------------------------------------------------------------------------

describe("lost-view-model — reportar un mensaje", () => {
  const A_SIGHTING: LostFeedItemV1 = {
    kind: "sighting",
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    at: "2026-08-22T10:00:00.000Z",
    description: "Andá a buscarla vos",
    localityLabel: null,
    lat: null,
    lng: null,
    finderContact: null,
    hasPhoto: false,
  };
  const A_FINDER: LostFeedItemV1 = {
    kind: "finder",
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
    at: "2026-08-22T11:00:00.000Z",
    finderName: "Vecina",
    finderContact: null,
    petCondition: null,
    localityLabel: null,
    message: null,
    availabilityLabel: null,
    hasPhoto: false,
  };
  const A_SCAN: LostFeedItemV1 = {
    kind: "scan",
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    at: "2026-08-22T09:00:00.000Z",
    count: 1,
    localityLabel: null,
  };

  it("reports the two AUTHORED kinds and refuses the scan", () => {
    // A QR read has no author and no text. There is nothing anybody could have
    // written wrongly, so there is nothing to report — and the server refuses
    // the target regardless, which is what this line keeps the app from
    // discovering in somebody's hands.
    expect(feedItemReportable(A_SIGHTING)).toBe(true);
    expect(feedItemReportable(A_FINDER)).toBe(true);
    expect(feedItemReportable(A_SCAN)).toBe(false);
  });

  it("builds the command from the row's own id and a category", () => {
    const built = buildReportContent(A_SIGHTING.id, "harassment", "  Me insultó.  ");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toEqual({
      command: "report_content",
      targetEventId: A_SIGHTING.id,
      category: "harassment",
      // Trimmed by the contract, so the spine never stores a person's stray
      // whitespace as if it were part of what they said.
      reason: "Me insultó.",
    });
  });

  it("sends an untouched motive as null, not as an empty string", () => {
    const built = buildReportContent(A_SIGHTING.id, "other", "   ");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.input as { reason: string | null }).reason).toBeNull();
  });

  it("refuses an id that is not an event id, with a message that blames the app", () => {
    // A person cannot cause this: the screen echoes the row it was handed. It
    // means a build out of step with its own contract, and the copy says so
    // rather than sending somebody to fix a field they never saw.
    const built = buildReportContent("ev-sighting-1", "spam", "");
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("REPORT_TARGET_REQUIRED");
    expect(built.message).toContain("Actualizá la app");
  });

  it("refuses a motive longer than the spine will store", () => {
    // 500 is the STORED limit; saying so before the send beats a 400 after it.
    const built = buildReportContent(A_SIGHTING.id, "other", "x".repeat(501));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("REPORT_REASON_TOO_LONG");
  });

  it("has es-AR copy for every category the contract names — no gaps, no repeats", () => {
    const labels = REPORT_CATEGORY_OPTIONS.map(reportCategoryLabel);
    expect(labels).toHaveLength(CONTENT_REPORT_CATEGORIES.length);
    // Distinct: two motives with the same words is a list where one of them can
    // never be chosen on purpose.
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it("never says 'denunciar' — that word is already a Ley 14.346 complaint", () => {
    // In this product `denuncia` names an animal-cruelty complaint routed to a
    // real authority. Borrowing it for content moderation would promise a
    // proceeding that is not happening.
    const strings = [
      REPORT_ACTION_LABEL,
      REPORT_INTRO,
      ...REPORT_CATEGORY_OPTIONS.map(reportCategoryLabel),
      commandDoneLabel("report_content", "female"),
      commandUnchangedLabel("report_content"),
    ];
    for (const text of strings) expect(text.toLowerCase()).not.toContain("denunci");
  });

  it("tells the person what does NOT happen, not only what does", () => {
    // The two things people assume wrongly: that the message is erased, and
    // that its author is told. Neither is true, and this app's whole promise is
    // that events are never deleted.
    expect(REPORT_INTRO).toContain("No se borra");
    expect(REPORT_INTRO).toContain("ningún aviso");
  });
});
