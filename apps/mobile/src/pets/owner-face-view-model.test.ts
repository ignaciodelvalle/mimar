import type {
  CredentialSection,
  OwnerPetBannersSection,
  OwnerPetCasesSection,
  OwnerPetComplianceSection,
  OwnerPetDetailV1,
  OwnerPetDetailViewerRole,
  OwnerPetIdentitySection,
  OwnerPetStatusSection,
} from "@dim/contract/api";
import type { PetActionId } from "@dim/contract/reference";
import { describe, expect, it } from "@jest/globals";

import {
  EMPTY_SCHEDULE_REMINDER_DRAFT,
  type OwnerPanelRow,
  type OwnerPanelSource,
  type OwnerPanelView,
  SECTION_UNAVAILABLE_MESSAGE,
  alertHeadline,
  alertTone,
  buildCancelReminder,
  buildOwnerFaceView,
  buildScheduleReminder,
  caretakerBannerLines,
  caseKindLabel,
  caseLine,
  caseStatusLabel,
  casesLine,
  complianceStampLabel,
  complianceSummaryLabel,
  findHomeWebUrl,
  isAttestationDoorCard,
  ownerPanelView,
  petTagWebUrl,
  rehomeBannerLine,
  reminderCancelledMessage,
  reminderDueLabel,
  sectionView,
  transitBannerLine,
  truncationNote,
  viewerRoleLabel,
} from "./owner-face-view-model";

describe("sectionView — unavailable is not empty", () => {
  it("carries the data through when the server read it", () => {
    const section: CredentialSection<number> = { status: "ok", data: 7 };
    expect(sectionView(section)).toEqual({ state: "ok", data: 7 });
  });

  it("carries COPY, not a bare tag, when the server could not read it", () => {
    // A screen cannot render this as an empty view without noticing it threw a
    // string away — which is the point.
    const section: CredentialSection<number> = { status: "unavailable" };
    expect(sectionView(section)).toEqual({
      state: "unavailable",
      message: SECTION_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("alerts — copy and tone, never order", () => {
  it("names every alert the contract can send", () => {
    const ids = [
      "lost",
      "rabies",
      "transit",
      "caretaker",
      "rehome",
      "open-cases",
      "pregnancy",
    ] as const;
    for (const id of ids) {
      const headline = alertHeadline({ id, tone: "info" });
      expect(headline.length).toBeGreaterThan(0);
      // No arm may fall through to the unknown-id branch.
      expect(headline).not.toContain("sin descripción");
    }
  });

  it("maps urgency onto the kit's callout tones", () => {
    expect(alertTone({ id: "lost", tone: "urgent" })).toBe("err");
    expect(alertTone({ id: "transit", tone: "warning" })).toBe("warn");
    expect(alertTone({ id: "pregnancy", tone: "info" })).toBe("neutral");
  });
});

describe("viewerRoleLabel — a holder must know why things are missing", () => {
  // The titular gets NO line. Their document is missing nothing, so the
  // sentence the line exists to say does not apply to them — see the function's
  // docblock. Asserted as null rather than as "not the old string", because a
  // future edit that returned some other always-true phrase would pass the
  // weaker check and put the noise straight back.
  it("says nothing at all to the titular", () => {
    expect(viewerRoleLabel("owner")).toBeNull();
  });

  it("names every other holder, and never twice the same way", () => {
    const others = (["co_owner", "foster", "caretaker", "org_member"] as const).map((role) =>
      viewerRoleLabel(role),
    );
    // Each one says something…
    for (const label of others) expect(label).toBeTruthy();
    // …and each says something DIFFERENT, which is the whole point of a line
    // whose job is to explain which gap the reader is looking at.
    expect(new Set(others).size).toBe(others.length);
    expect(viewerRoleLabel("org_member")).toContain("organización");
  });
});

describe("complianceStampLabel — SIN DATO is not a temporal word", () => {
  const state = (over: Partial<OwnerPetComplianceSection>): OwnerPetComplianceSection => ({
    cards: [],
    summary: { total: 4, ok: 3, label: "3 de 4 al día" },
    worstTone: "ok",
    worstIsUnknown: false,
    ...over,
  });

  it("never borrows a deadline word for a missing fact", () => {
    // The PPP "Faltan datos" card is deliberately toned `due` so it ranks high.
    // Stamping "POR VENCER" over it would announce a deadline that does not
    // exist — the projection already says which case this is.
    expect(complianceStampLabel(state({ worstTone: "due", worstIsUnknown: true }))).toBe(
      "SIN DATO",
    );
    expect(complianceStampLabel(state({ worstTone: "due", worstIsUnknown: false }))).toBe(
      "POR VENCER",
    );
  });

  it("prints the word for each tone", () => {
    expect(complianceStampLabel(state({ worstTone: "ok" }))).toBe("AL DÍA");
    expect(complianceStampLabel(state({ worstTone: "over" }))).toBe("VENCIDA");
    expect(complianceStampLabel(state({ worstTone: "reserved" }))).toBe("TURNO RESERVADO");
  });

  it("says there are no obligations rather than '0 de 0 al día'", () => {
    expect(
      complianceSummaryLabel(state({ summary: { total: 0, ok: 0, label: "0 de 0 al día" } })),
    ).toBe("Sin obligaciones cargadas para tu jurisdicción");
    expect(complianceSummaryLabel(state({}))).toBe("3 de 4 al día");
  });
});

describe("reminderDueLabel — a date, never a bare number", () => {
  it("reads naturally around today", () => {
    expect(reminderDueLabel(0)).toBe("Vence hoy");
    expect(reminderDueLabel(1)).toBe("Vence mañana");
    expect(reminderDueLabel(5)).toBe("Vence en 5 días");
  });

  it("says an overdue reminder is overdue, in the past tense", () => {
    expect(reminderDueLabel(-1)).toBe("Venció ayer");
    expect(reminderDueLabel(-4)).toBe("Venció hace 4 días");
  });
});

describe("truncationNote — a partial list must SAY it is partial", () => {
  it("is silent when the list is whole", () => {
    expect(truncationNote(8, 8, "mascotas")).toBeNull();
    // Defensive: a shown count above the total is nonsense, but it must not
    // produce "Mostrando 9 de 8".
    expect(truncationNote(9, 8, "mascotas")).toBeNull();
  });

  it("names both numbers when the list was capped", () => {
    expect(truncationNote(8, 14, "mascotas")).toBe("Mostrando 8 de 14 mascotas.");
  });
});

describe("casesLine — a capped count is a floor, and says so", () => {
  const cases = (over: Partial<OwnerPetCasesSection>): OwnerPetCasesSection => ({
    openCount: 0,
    truncated: false,
    items: [],
    ...over,
  });

  it("is an honest zero", () => {
    expect(casesLine(cases({}))).toBe("No tiene trámites abiertos.");
  });

  it("agrees in number", () => {
    expect(casesLine(cases({ openCount: 1 }))).toBe("1 trámite abierto.");
    expect(casesLine(cases({ openCount: 3 }))).toBe("3 trámites abiertos.");
  });

  it("says 'al menos' when the read hit its cap", () => {
    expect(casesLine(cases({ openCount: 50, truncated: true }))).toBe(
      "Al menos 50 trámites abiertos.",
    );
  });
});

describe("caseLine — the CAS- code the reporter has to quote", () => {
  it("prints code, kind and status, in the web badge's order", () => {
    expect(
      caseLine({ casePublicCode: "CAS-1234-5678", kind: "bite_incident", status: "open" }),
    ).toBe("CAS-1234-5678 · Mordedura / observación rábica · Abierto");
  });

  it("says Escalado when an authority moved the case up", () => {
    expect(
      caseLine({ casePublicCode: "CAS-1111-2222", kind: "custody_dispute", status: "escalated" }),
    ).toBe("CAS-1111-2222 · Disputa de custodia · Escalado");
  });

  it("labels every kind the contract can send, and never a raw key", () => {
    // Pinned against LITERALS, not against the function that produced them:
    // these are the web's own `caseKindLabel` strings, so one expediente reads
    // the same way in a browser and on a phone.
    expect(caseKindLabel("adoption_listing")).toBe("Publicación en adopción");
    expect(caseKindLabel("rehome_request")).toBe("Solicitud de nuevo hogar");
    expect(caseKindLabel("microchip_remediation")).toBe("Remediación de microchip");
    expect(caseKindLabel("other")).toBe("Otro trámite");
  });

  it("has a word for both open states", () => {
    expect(caseStatusLabel("open")).toBe("Abierto");
    expect(caseStatusLabel("escalated")).toBe("Escalado");
  });
});

describe("banners — the two-key public-contact model", () => {
  const banners = (over: Partial<OwnerPetBannersSection>): OwnerPetBannersSection => ({
    transit: null,
    caretaker: null,
    rehome: null,
    ...over,
  });

  it("has nothing to say when there are no arrangements", () => {
    expect(caretakerBannerLines(banners({}))).toEqual([]);
    expect(rehomeBannerLine(banners({}))).toBeNull();
    expect(transitBannerLine(banners({}))).toBeNull();
  });

  it("names the caretaker when one is active", () => {
    const lines = caretakerBannerLines(
      banners({
        caretaker: { state: "active", caretakerName: "Ana", publicContactName: null },
      }),
    );
    expect(lines[0]).toBe("Ana la está cuidando.");
    // KEY 2 absent → no public-contact line at all. A row offering something
    // the caretaker never consented to would be a lie shaped like a control.
    expect(lines).toHaveLength(1);
  });

  it("adds the public-contact line ONLY when consent was given", () => {
    const lines = caretakerBannerLines(
      banners({
        caretaker: { state: "active", caretakerName: "Ana", publicContactName: "Ana" },
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("contacto público");
  });

  it("distinguishes a pending arrangement from a lapsed one", () => {
    expect(
      caretakerBannerLines(
        banners({ caretaker: { state: "pending", caretakerName: null, publicContactName: null } }),
      )[0],
    ).toContain("sin responder");
    expect(
      caretakerBannerLines(
        banners({
          caretaker: { state: "recently_ended", caretakerName: null, publicContactName: null },
        }),
      )[0],
    ).toContain("terminó");
  });

  it("falls back to a neutral noun when the org has no display name", () => {
    expect(rehomeBannerLine(banners({ rehome: { kind: "pending", orgDisplayName: null } }))).toBe(
      "Hay una propuesta de adopción pendiente con la organización.",
    );
    expect(
      rehomeBannerLine(banners({ rehome: { kind: "active", orgDisplayName: "Refugio Sur" } })),
    ).toBe("Refugio Sur está buscándole un nuevo hogar.");
  });

  it("tells a transit holder where the actions live", () => {
    // The actions are org-mediated and would dead-end for a vecino who picked
    // up a stray, so the banner shows and the actions do not.
    expect(transitBannerLine(banners({ transit: { canManageFosterActions: false } }))).toContain(
      "web",
    );
  });
});

describe("buildScheduleReminder — the contract's schema, the web's words", () => {
  it("converts the typed DD/MM/AAAA to the wire's YYYY-MM-DD and blank notes to null", () => {
    const built = buildScheduleReminder({
      vaccineName: "  Sextuple ",
      dueAt: "20/11/2026",
      description: "   ",
    });
    expect(built).toEqual({
      ok: true,
      input: {
        command: "create_vaccine_reminder",
        vaccineName: "Sextuple",
        dueAt: "2026-11-20",
        description: null,
      },
    });
  });

  it("refuses a blank name with the sentence the web's own form shows", () => {
    const built = buildScheduleReminder({ ...EMPTY_SCHEDULE_REMINDER_DRAFT, dueAt: "20/11/2026" });
    expect(built).toEqual({
      ok: false,
      code: "VACCINE_NAME_REQUIRED",
      message: "Falta el nombre de la vacuna.",
    });
  });

  it("refuses a half-typed date as MALFORMED and a day that does not exist as INVALID", () => {
    const half = buildScheduleReminder({
      ...EMPTY_SCHEDULE_REMINDER_DRAFT,
      vaccineName: "X",
      dueAt: "20/1",
    });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.code).toBe("DUE_AT_MALFORMED");

    // 31/02 rolls over to 3 March under `new Date`; the contract's
    // `isRealArDay` is the backstop, and the sentence must not be the
    // "escribí la fecha como" one — the shape was right, the day was not.
    const rolled = buildScheduleReminder({
      ...EMPTY_SCHEDULE_REMINDER_DRAFT,
      vaccineName: "X",
      dueAt: "31/02/2026",
    });
    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.code).toBe("DUE_AT_INVALID");
  });

  it("cancels by the row id, in the contract's shape", () => {
    expect(buildCancelReminder("rem-1")).toEqual({
      command: "cancel_vaccine_reminder",
      reminderId: "rem-1",
    });
  });
});

describe("reminderCancelledMessage — a replayed cancel is a success", () => {
  it("words both arms of `changed` as done, never as a refusal", () => {
    expect(
      reminderCancelledMessage({
        command: "cancel_vaccine_reminder",
        reminderId: "r",
        changed: true,
      }),
    ).toBe("Listo. El recordatorio quedó eliminado.");
    expect(
      reminderCancelledMessage({
        command: "cancel_vaccine_reminder",
        reminderId: "r",
        changed: false,
      }),
    ).toBe("Ese recordatorio ya estaba eliminado.");
  });
});

// The two web handoffs behind the "Disponible en la web" rows of the ⋯ Más
// sheet (2026-09-11). Until that day both rows rendered with no `onPress`: the
// caption named a destination and the tap went nowhere.
//
// A FIXED ORIGIN, NOT `API_BASE_URL`. The origin these run with in production is
// build configuration and varies per build; passing a literal is what lets the
// whole expected string be written out by hand instead of composed from the
// same pieces the function composes it from.
describe("petTagWebUrl / findHomeWebUrl — the pages the Más sheet hands off to", () => {
  const ORIGIN = "https://example.test";

  it("builds the chapita page for this pet", () => {
    expect(petTagWebUrl(ORIGIN, "DIM-PAMP-0001")).toBe(
      "https://example.test/mis-mascotas/DIM-PAMP-0001/chapita",
    );
  });

  it("builds the buscar-hogar page for this pet", () => {
    expect(findHomeWebUrl(ORIGIN, "DIM-PAMP-0001")).toBe(
      "https://example.test/mis-mascotas/DIM-PAMP-0001/buscar-hogar",
    );
  });

  it("names TWO DIFFERENT pages", () => {
    // The one assertion that survives a copy-paste between the two builders.
    // Both take the same two arguments and differ in a single trailing word, so
    // a body pasted from its neighbour would leave both tests above passing on
    // whichever literal was edited second.
    expect(petTagWebUrl(ORIGIN, "DIM-PAMP-0001")).not.toBe(findHomeWebUrl(ORIGIN, "DIM-PAMP-0001"));
  });

  it("does not double the slash when the origin carries a trailing one", () => {
    // `EXPO_PUBLIC_API_BASE_URL` is read from the environment, and an origin
    // typed with a trailing slash is the ordinary way that happens.
    expect(petTagWebUrl("https://example.test/", "DIM-PAMP-0001")).toBe(
      "https://example.test/mis-mascotas/DIM-PAMP-0001/chapita",
    );
  });

  it("percent-encodes a token that would otherwise change the path", () => {
    // The token is a server-issued `DIM-XXXX-XXXX`, so this is a guard and not
    // a live case — but a raw interpolation is how a path becomes a different
    // path, and the encoding is cheap.
    expect(findHomeWebUrl(ORIGIN, "a/b")).toBe(
      "https://example.test/mis-mascotas/a%2Fb/buscar-hogar",
    );
  });
});

// ---------------------------------------------------------------------------
// isAttestationDoorCard — the door survives a state the card did not have
// (T4-I1 / #753)
// ---------------------------------------------------------------------------
//
// `derivePpp` used to give this card two states; #753 gave it three, adding
// "Declarada" (an attestation exists but cites no inscription number and
// carries no institutional signature, so it does not clear the obligation).
// The door must stay OPEN there — filing an attestation that DOES cite the
// number is the remedy the card's own hint asks for, and this door is the only
// way to file one. The web twin (ComplianceObligationsPanel's
// `showPppRegister`) reads the same `tone` so the two surfaces answer alike.
describe("isAttestationDoorCard — three card states (#753)", () => {
  // The panel's `attestationDoor`, from the catalogue. `true` = the regime
  // covers this living animal and this viewer may file.
  const OPEN = true;

  const card = (state: string, tone: string, dataUnknown = false) =>
    ({ key: "ppp", label: "Atestación PPP", state, tone, dataUnknown }) as Parameters<
      typeof isAttestationDoorCard
    >[0];

  it("opens when nothing is on record", () => {
    expect(isAttestationDoorCard(card("Atestación requerida", "due"), OPEN)).toBe(true);
  });

  it("STAYS OPEN on a Declarada card — that is how the number gets added", () => {
    expect(isAttestationDoorCard(card("Declarada", "neutral"), OPEN)).toBe(true);
  });

  it("closes once the attestation counts", () => {
    expect(isAttestationDoorCard(card("Atestada", "ok"), OPEN)).toBe(false);
  });

  it("stays shut when the catalogue closed the door, whatever the card says", () => {
    expect(isAttestationDoorCard(card("Atestación requerida", "due"), false)).toBe(false);
    expect(isAttestationDoorCard(card("Declarada", "neutral"), false)).toBe(false);
  });

  // THE FOURTH CARD derivePpp can return, and the one `tone !== "ok"` alone
  // gets wrong: the indeterminado nudge for a dog whose breed or weight is
  // unknown. That dog is not yet KNOWN to be PPP, so offering to register it
  // in the dangerous-breed registry answers a question nobody asked. The web
  // twin excluded it all along via the same flag.
  it("stays shut on the 'Faltan datos' nudge", () => {
    expect(isAttestationDoorCard(card("Faltan datos", "due", true), OPEN)).toBe(false);
  });

  it("is not offered on another obligation's card", () => {
    const rabies = { key: "rabies", label: "Antirrábica", state: "Vencida", tone: "over" };
    expect(isAttestationDoorCard(rabies as Parameters<typeof isAttestationDoorCard>[0], OPEN)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The owner panel — the contract's catalogue, with this app's doors behind it
// (owner-pet-actions 5.2)
// ---------------------------------------------------------------------------
//
// WHAT MOVED. Until owner-pet-actions this file computed `ownerFaceGates`, its
// own copy of who gets which row, beside the web's two other copies. The
// catalogue in `@dim/contract/reference` (`derivePetActions`) now decides that
// for both platforms, with its own gate matrix in the contract's tests. What is
// left HERE is what is genuinely the app's: WHERE each row goes on a phone, and
// what a row this build has no screen for says instead. These tests pin those
// doors, plus as much of the matrix as it takes to prove the app reads the
// catalogue rather than a copy of it.
//
// EVERY EXPECTED ROUTE IS A LITERAL, not a call to the route builders. The
// contacts row and the death row differ from their neighbours only in a query
// string (`?seccion=contactos`, `?kind=death`); a panel that dropped it would
// still navigate, and only a spelled-out string notices.

const UNREAD = { state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE } as const;

/** What the panel reads off the face, with every section loaded by default. */
function source(
  over: {
    viewerRole?: OwnerPetDetailViewerRole;
    isTitular?: boolean;
    /** The server's "Editar datos" verdict; `null` = an older server sent none. */
    canEditProfile?: boolean | null;
    /** `null` = the status section did not load. */
    petStatus?: string | null;
    /** `null` = the identity section did not load. */
    species?: string | null;
    /** `unread` = the registries section did not load. */
    ppp?: "applies" | "none" | "unread";
  } = {},
): OwnerPanelSource {
  const viewerRole = over.viewerRole ?? "owner";
  const ppp = over.ppp ?? "none";
  return {
    publicToken: "DIM-PAMP-0001",
    viewerRole,
    isTitular: over.isTitular ?? viewerRole === "owner",
    canEditProfile: over.canEditProfile ?? null,
    status:
      over.petStatus === null
        ? UNREAD
        : {
            state: "ok",
            data: { petStatus: over.petStatus ?? "active" } as OwnerPetStatusSection,
          },
    identity:
      over.species === null
        ? UNREAD
        : {
            state: "ok",
            data: { name: "Pampa", species: over.species ?? "dog" } as OwnerPetIdentitySection,
          },
    pppRegistries:
      ppp === "unread"
        ? UNREAD
        : {
            state: "ok",
            data:
              ppp === "applies"
                ? [{ id: "caba_ley_4078", label: "CABA · Ley 4078", required: true }]
                : null,
          },
  } as OwnerPanelSource;
}

const panelOf = (over: Parameters<typeof source>[0] = {}) => ownerPanelView(source(over));

/** One row wherever it sits, or `null` when the panel does not draw it. */
function rowOf(panel: OwnerPanelView, id: PetActionId): OwnerPanelRow | null {
  for (const row of panel.primary) if (row.id === id) return row;
  for (const group of panel.groups) {
    for (const row of group.rows) if (row.id === id) return row;
  }
  return null;
}

/** Every row the panel draws, in reading order. */
function idsOf(panel: OwnerPanelView): PetActionId[] {
  return [...panel.primary, ...panel.groups.flatMap((group) => group.rows)].map((row) => row.id);
}

describe("ownerPanelView — the titular of an active dog gets every door, in the catalogue's order", () => {
  it("draws the primary row as Anotar, Compartir and Modo perdida, each to its own screen", () => {
    const panel = panelOf();
    expect(panel.primary.map((row) => [row.label, row.target])).toEqual([
      ["Anotar", "/mascotas/DIM-PAMP-0001/asentar"],
      ["Compartir", "/mascotas/DIM-PAMP-0001/compartir"],
      ["Modo perdida", "/mascotas/DIM-PAMP-0001/perdida"],
    ]);
    // The emergency reads as one, and the other two do not.
    expect(panel.primary.map((row) => row.tone)).toEqual(["default", "default", "danger"]);
  });

  it("draws the groups under their headings, the death row alone and last", () => {
    expect(panelOf().groups.map((group) => [group.heading, group.rows.map((r) => r.id)])).toEqual([
      ["La mascota", ["edit", "photo", "contacts", "service_dog", "physical_tag"]],
      ["Salud", ["vaccine_reminders"]],
      ["Viajes", ["travel"]],
      ["Custodia", ["caretaker", "return", "find_home", "transfer"]],
      [null, ["death"]],
    ]);
  });

  it("sends every group row to the app's own screen for it", () => {
    const targets = Object.fromEntries(
      panelOf().groups.flatMap((group) => group.rows.map((row) => [row.id, row.target])),
    );
    expect(targets).toEqual({
      edit: "/mascotas/DIM-PAMP-0001/editar",
      photo: "/mascotas/DIM-PAMP-0001/foto",
      // One screen with Editar datos, opened on its own section (PO plan 7).
      contacts: "/mascotas/DIM-PAMP-0001/editar?seccion=contactos",
      service_dog: "/mascotas/DIM-PAMP-0001/asistencia",
      physical_tag: "/mascotas/DIM-PAMP-0001/chapita",
      vaccine_reminders: "/mascotas/DIM-PAMP-0001/vacunas",
      travel: "/mascotas/DIM-PAMP-0001/viaje",
      caretaker: { pathname: "/mascotas/DIM-PAMP-0001/cuidado", params: { name: "Pampa" } },
      return: "/mascotas/DIM-PAMP-0001/devolucion",
      find_home: "/mascotas/DIM-PAMP-0001/buscar-hogar",
      transfer: { pathname: "/mascotas/DIM-PAMP-0001/transferir", params: { name: "Pampa" } },
      death: "/mascotas/DIM-PAMP-0001/asentar?kind=death",
    });
  });

  it("says what the death row does BEFORE the tap, and captions no other live row", () => {
    const panel = panelOf();
    expect(rowOf(panel, "death")?.caption).toBe("Cierra el registro del animal");
    expect(rowOf(panel, "edit")?.caption).toBeNull();
    expect(rowOf(panel, "transfer")?.caption).toBeNull();
  });

  it("carries no name when the identity read failed — empty params, never the word undefined", () => {
    expect(rowOf(panelOf({ species: null }), "transfer")?.target).toEqual({
      pathname: "/mascotas/DIM-PAMP-0001/transferir",
      params: {},
    });
  });
});

describe("ownerPanelView — a row that does not apply is grey, with its reason", () => {
  it("draws a co-owner's titular-only rows inert, each saying 'Solo el titular'", () => {
    const panel = panelOf({ viewerRole: "co_owner" });
    for (const id of ["contacts", "service_dog", "caretaker", "find_home", "transfer"] as const) {
      expect([id, rowOf(panel, id)?.target, rowOf(panel, id)?.caption]).toEqual([
        id,
        null,
        "Solo el titular",
      ]);
    }
    // The control: what a co-owner MAY do is still a door.
    expect(rowOf(panel, "edit")?.target).toBe("/mascotas/DIM-PAMP-0001/editar");
  });

  it("tells a titular whose animal is LOST to find it first, and keeps the cockpit", () => {
    const panel = panelOf({ petStatus: "lost" });
    expect(rowOf(panel, "transfer")?.caption).toBe("No se puede en esta situación");
    expect(rowOf(panel, "caretaker")?.target).toBeNull();
    // Kept on a lost animal: the row is the cockpit for both directions.
    expect(rowOf(panel, "lost")?.target).toBe("/mascotas/DIM-PAMP-0001/perdida");
  });

  it("names the arrangement for a caretaker, and keeps what a caretaker MAY do live", () => {
    const panel = panelOf({ viewerRole: "caretaker" });
    expect(rowOf(panel, "edit")?.caption).toBe("No disponible para cuidadores");
    expect(rowOf(panel, "edit")?.target).toBeNull();
    // `titular-only.ts` lists photos and the death record among a caretaker's acts.
    expect(rowOf(panel, "photo")?.target).toBe("/mascotas/DIM-PAMP-0001/foto");
    expect(rowOf(panel, "death")?.target).toBe("/mascotas/DIM-PAMP-0001/asentar?kind=death");
  });
});

describe("ownerPanelView — Editar datos follows the server's verdict (vecino en tránsito, PO 2026-10-01)", () => {
  // A user-held custody row reaches the app as `caretaker`; the verdict is what
  // tells the vecino of an animal with no titular from a real caretaker.
  it("opens Editar datos for the vecino while the animal has no titular", () => {
    const panel = panelOf({ viewerRole: "caretaker", canEditProfile: true });
    expect(rowOf(panel, "edit")?.target).toBe("/mascotas/DIM-PAMP-0001/editar");
    expect(rowOf(panel, "edit")?.caption).toBeNull();
    // Nothing else moves: the titular's rows stay the titular's.
    expect(rowOf(panel, "transfer")?.target).toBeNull();
  });

  it("greys it once the animal has a titular", () => {
    const panel = panelOf({ viewerRole: "caretaker", canEditProfile: false });
    expect(rowOf(panel, "edit")?.target).toBeNull();
    expect(rowOf(panel, "edit")?.caption).toBe("No disponible para cuidadores");
  });

  it("an older server (no verdict) keeps the role rule", () => {
    expect(rowOf(panelOf({ viewerRole: "caretaker" }), "edit")?.target).toBeNull();
    expect(rowOf(panelOf({ viewerRole: "foster" }), "edit")?.target).toBe(
      "/mascotas/DIM-PAMP-0001/editar",
    );
  });

  it("reads the verdict off the payload, and an absent one as `null`", () => {
    const gone = { status: "unavailable" } as const;
    const base = {
      publicToken: "DIM-PAMP-0001",
      issuedAt: "2026-10-01T12:00:00Z",
      identity: gone,
      status: gone,
      alerts: gone,
      compliance: gone,
      reminders: gone,
      banners: gone,
      cases: gone,
      pregnancy: gone,
      carousel: gone,
      pppRegistries: gone,
    };
    const withVerdict = buildOwnerFaceView({
      ...base,
      viewer: { role: "caretaker", isTitular: false, canEditProfile: true },
    } as unknown as OwnerPetDetailV1);
    expect(withVerdict.canEditProfile).toBe(true);
    const older = buildOwnerFaceView({
      ...base,
      viewer: { role: "caretaker", isTitular: false },
    } as unknown as OwnerPetDetailV1);
    expect(older.canEditProfile).toBeNull();
  });
});

describe("ownerPanelView — a deceased animal keeps Compartir, Editar datos, Foto and Contactos (PO)", () => {
  it("draws those four and nothing else, all of them live", () => {
    const panel = panelOf({ petStatus: "deceased" });
    expect(idsOf(panel)).toEqual(["share", "edit", "photo", "contacts"]);
    expect(rowOf(panel, "contacts")?.target).toBe(
      "/mascotas/DIM-PAMP-0001/editar?seccion=contactos",
    );
  });

  it("closes the attestation door even where the regime applies", () => {
    expect(panelOf({ petStatus: "deceased", ppp: "applies" }).attestationDoor).toBe(false);
    expect(panelOf({ ppp: "applies" }).attestationDoor).toBe(true);
  });
});

describe("ownerPanelView — one destination, two asks, and only one has a screen here", () => {
  it("shows the FOSTER's 'Buscar hogar' grey, saying where it lives, and sends nobody anywhere", () => {
    // `foster`'s `sendRehomeRequest` has no v1 route yet (a follow-up of this
    // change); `RehomeScreen` serves the titular's ask, not this one.
    const row = rowOf(panelOf({ viewerRole: "foster" }), "find_home");
    expect([row?.label, row?.target, row?.caption]).toEqual([
      "Buscar hogar",
      null,
      "Se hace desde la web",
    ]);
  });

  it("sends the titular's 'Acompañamiento de adopción' to the native screen", () => {
    const row = rowOf(panelOf(), "find_home");
    expect([row?.label, row?.target]).toEqual([
      "Acompañamiento de adopción",
      "/mascotas/DIM-PAMP-0001/buscar-hogar",
    ]);
  });
});

describe("ownerPanelView — the trip is the travel titulars' (TRAVEL_TITULAR_ROLES)", () => {
  // THE PIN, kept from `ownerFaceGates.canPlanTravel` (the web's twin lived in
  // `MasSheet.helpers.test.ts`): the server's `TRAVEL_TITULAR_ROLES`
  // (`lib/infra/travel-private-events.ts`) is owner, co-owner and foster. A
  // caretaker is often the person keeping the animal while the family travels.
  it("is a door for the three travel titulars", () => {
    for (const viewerRole of ["owner", "co_owner", "foster"] as const) {
      expect([viewerRole, rowOf(panelOf({ viewerRole }), "travel")?.target]).toEqual([
        viewerRole,
        "/mascotas/DIM-PAMP-0001/viaje",
      ]);
    }
  });

  it("is grey for a caretaker and absent from the organization path", () => {
    expect(rowOf(panelOf({ viewerRole: "caretaker" }), "travel")?.caption).toBe(
      "No disponible para cuidadores",
    );
    expect(rowOf(panelOf({ viewerRole: "org_member" }), "travel")).toBeNull();
  });

  it("stays a door on a LOST animal — only a death takes it away", () => {
    expect(rowOf(panelOf({ petStatus: "lost" }), "travel")?.target).toBe(
      "/mascotas/DIM-PAMP-0001/viaje",
    );
    expect(rowOf(panelOf({ petStatus: "deceased" }), "travel")).toBeNull();
  });
});

describe("ownerPanelView — an organization member gets Compartir and acts from the portal", () => {
  it("draws Compartir alone, with no groups and no photo door", () => {
    const panel = panelOf({ viewerRole: "org_member" });
    expect(idsOf(panel)).toEqual(["share"]);
    expect(panel.groups).toEqual([]);
    expect(panel.photoTarget).toBeNull();
  });
});

describe("ownerPanelView — a section that did not load takes nothing away", () => {
  it("keeps every titular door while the status is unread", () => {
    const panel = panelOf({ petStatus: null });
    expect(rowOf(panel, "transfer")?.target).toEqual({
      pathname: "/mascotas/DIM-PAMP-0001/transferir",
      params: { name: "Pampa" },
    });
    expect(rowOf(panel, "lost")?.target).toBe("/mascotas/DIM-PAMP-0001/perdida");
  });

  it("keeps 'Perro de asistencia' while the species is unread, and drops it for a known cat", () => {
    expect(rowOf(panelOf({ species: null }), "service_dog")?.target).toBe(
      "/mascotas/DIM-PAMP-0001/asistencia",
    );
    expect(rowOf(panelOf({ species: "cat" }), "service_dog")).toBeNull();
  });

  it("is the ONE exception for the attestation door: an unread registry closes it", () => {
    // The regime covers a small minority of dogs; offering its form on an
    // outage would put it in front of almost every owner.
    expect(panelOf({ ppp: "unread" }).attestationDoor).toBe(false);
  });
});

describe("ownerPanelView — the photo frame is a door with the Foto row's own gate", () => {
  it("opens the photo screen for every person-path holder, a caretaker and a fallecida included", () => {
    for (const over of [{}, { viewerRole: "caretaker" as const }, { petStatus: "deceased" }]) {
      const panel = panelOf(over);
      expect(panel.photoTarget).toBe("/mascotas/DIM-PAMP-0001/foto");
      expect(panel.photoTarget).toBe(rowOf(panel, "photo")?.target);
    }
  });
});
