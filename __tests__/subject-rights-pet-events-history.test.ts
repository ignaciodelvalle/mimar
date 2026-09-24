// art. 16 erasure keeps the pet's history and removes the person (T3-A2b).
//
// PO decision 5A (2026-09-22): erasure removes what belongs to the PERSON,
// never the pet's health or compliance history. This file seeds a realistic
// life — an owner O, a vet V — erases O (and, separately, V) through the LIVE
// erase_subject_data, and reads the result back as data:
//   · every row survives with its id, event_type and occurred_at;
//   · vaccination, sterilization and rabies-observation rows are deep-equal;
//   · the bite keeps its epidemiology and loses the victim's identity;
//   · the enum `reason` of microchip_replaced survives (0159-0228 destroyed it);
//   · the finder's identity and the owner's own prose are gone;
//   · the compliance projections replay to the same answer before and after;
//   · no removed value reaches the override audit trail, and a second run
//     writes nothing.
// Everything runs inside one rolled-back transaction (__tests__/_helpers/erasure-tx.ts).

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveComplianceState } from "@/lib/projections/pet-compliance";
import { replayPetMicrochip } from "@/lib/projections/pet-microchip";
import { replayPetRabiesObservation } from "@/lib/projections/pet-rabies-observation";
import { replayPetStatus } from "@/lib/projections/pet-status";

import {
  type EventSnapshot,
  eraseAs,
  inRolledBackTx,
  insertEvent,
  overrideAuditText,
  rows,
  seedPet,
  seedUser,
  snapshotEvents,
} from "./_helpers/erasure-tx";

const SENTINEL = "[dato removido]";

const AGE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["70 años y 2 meses", "senior_65_plus"],
  ["1 año y 6 meses", "child_under_15"],
  ["18 meses", "child_under_15"],
  ["unos 9 años", "child_under_15"],
  ["40", "adult_15_64"],
  ["adulto de 40 anios", "adult_15_64"],
  ["niño", "unknown"],
  ["1234", "unknown"],
];
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);

/** Strings that belong to a person. None may survive the erasure anywhere. */
const PD = {
  victimName: "PD-Victima-Rosa-Quiroga",
  victimPhone: "PD-+5491177770001",
  victimAge: "unos 9 años, PD-edad",
  injuries: "PD-herida-en-la-mano-de-Rosa",
  context: "PD-estaba-jugando-en-la-vereda",
  incidentPlace: "PD-frente-a-Mitre-1234",
  ownerCause: "PD-el-titular-cree-que-comio-veneno",
  finderName: "PD-Hallador-Julio",
  finderContact: "PD-julio@correo.test",
  finderMessage: "PD-lo-tengo-en-casa-llamame",
  exOwnedNote: "PD-nota-sobre-mi-ex-perro",
  motivation: "PD-quiero-adoptar-porque",
  routine: "PD-trabajo-de-9-a-18",
  lostReason: "PD-se-escapo-cuando-vino-mi-cunado-Raul",
  infoRequest: "PD-Hola-Ana-contanos-si-tu-patio-esta-cerrado",
  infoRequestLegacy: "PD-Ana-necesitamos-ver-tu-casa-el-sabado",
  unverifiedDetails: "PD-la-titular-Ana-no-lo-vacuna",
  reversalReason: "PD-Ana-lo-dejaba-solo-todo-el-dia",
} as const;

type Observed = {
  before: EventSnapshot[];
  after: EventSnapshot[];
  ids: Record<string, string>;
  audit: Array<{ eventId: string; text: string }>;
  auditAfterSecondRun: number;
  vetId: string;
};

async function runOwnerErasure(): Promise<Observed> {
  return inRolledBackTx(async (tx) => {
    const O = await seedUser(tx, "a2b-owner");
    const V = await seedUser(tx, "a2b-vet");
    const X = await seedUser(tx, "a2b-other");

    const pet = await seedPet(tx, O);
    // A pet O used to own; X owns it now.
    const exPet = await seedPet(tx, O, { startedAt: at(400), endedAt: at(100) });
    const otherPet = await seedPet(tx, X);
    const shelterPet = await seedPet(tx, X);

    const ids: Record<string, string> = {};
    ids.vaccination = await insertEvent(tx, {
      petId: pet,
      eventType: "vaccination_administered",
      recordedByUserId: V,
      authorRole: "vet",
      occurredAt: at(60),
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: "Nobivac",
        batch: "L-2026-01",
        administered_by: "Dra. Vet Fixture",
        administered_by_user_id: V,
        next_due_at: new Date(Date.now() + 300 * DAY).toISOString(),
      },
      notes: "Aplicada sin reacciones adversas.",
      extra: {
        loteBiologico: "L-2026-01",
        laboratorio: "MSD",
        vetMatricula: "MP-1234",
        firmadoAt: at(60),
      },
    });
    ids.sterilization = await insertEvent(tx, {
      petId: pet,
      eventType: "sterilization_performed",
      recordedByUserId: V,
      authorRole: "vet",
      occurredAt: at(55),
      payload: {
        payload_version: 1,
        procedure: "spay",
        performed_by: "Dra. Vet Fixture",
        clinic: "Clínica Norte",
      },
    });
    ids.bite = await insertEvent(tx, {
      petId: pet,
      eventType: "incident_reported",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(20),
      payload: {
        payload_version: 1,
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: PD.injuries,
        vet_involved: false,
        location_description: PD.incidentPlace,
        victim_kind: "human",
        victim_contact_name: PD.victimName,
        victim_contact_phone: PD.victimPhone,
        victim_age_estimate: PD.victimAge,
        context: PD.context,
        rabies_vaccine_valid_at_incident: true,
        reporter_role: "owner",
        jurisdiction_province: "Buenos Aires",
        jurisdiction_locality: "La Plata",
      },
      locationLat: "-34.9214321",
      locationLng: "-57.9545678",
    });
    ids.rabiesStart = await insertEvent(tx, {
      petId: pet,
      eventType: "rabies_observation_started",
      recordedByUserId: V,
      authorRole: "vet",
      occurredAt: at(19),
      payload: {
        payload_version: 1,
        bite_event_id: ids.bite,
        observation_until: at(9).toISOString(),
        observation_days: 10,
        location: "home",
        official_site_organization_id: null,
      },
    });
    ids.rabiesEnd = await insertEvent(tx, {
      petId: pet,
      eventType: "rabies_observation_ended",
      recordedByUserId: V,
      authorRole: "vet",
      occurredAt: at(9),
      payload: {
        payload_version: 1,
        bite_event_id: ids.bite,
        observation_started_event_id: ids.rabiesStart,
        outcome: "healthy",
        closed_by_role: "vet",
        closure_notes: "Sin signos compatibles con rabia al día 10.",
        death_event_id: null,
      },
    });
    ids.chip = await insertEvent(tx, {
      petId: pet,
      eventType: "microchip_replaced",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(8),
      payload: {
        payload_version: 1,
        previous_chip_number: "985112000000001",
        new_chip_number: "985112000000002",
        reason: "damaged",
        replaced_by: "Dra. Vet Fixture",
        replaced_at: at(8).toISOString(),
      },
    });
    ids.sighting = await insertEvent(tx, {
      petId: pet,
      eventType: "note_added",
      recordedByUserId: null,
      authorRole: "scanner",
      occurredAt: at(7),
      payload: {
        payload_version: 1,
        category: null,
        kind: "sighting",
        text: "Lo vi en la plaza",
        finderName: PD.finderName,
        finderContact: PD.finderContact,
        message: PD.finderMessage,
      },
      locationLat: "-34.6037123",
      locationLng: "-58.3815987",
    });
    ids.death = await insertEvent(tx, {
      petId: pet,
      eventType: "death_recorded",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(2),
      payload: {
        payload_version: 1,
        cause: "illness",
        cause_detail: PD.ownerCause,
        vet_name: "Dra. Vet Fixture",
        disease_code: "rabia",
        is_reportable: true,
      },
    });
    ids.vetDeath = await insertEvent(tx, {
      petId: otherPet,
      eventType: "death_recorded",
      recordedByUserId: V,
      authorRole: "vet",
      occurredAt: at(3),
      payload: {
        payload_version: 1,
        cause: "illness",
        cause_detail: "Insuficiencia renal crónica, estadio IV.",
        vet_name: "Dra. Vet Fixture",
        is_reportable: false,
      },
    });
    ids.exOwnedNote = await insertEvent(tx, {
      petId: exPet,
      eventType: "note_added",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(200),
      payload: { payload_version: 1, category: "behavior", text: PD.exOwnedNote },
    });
    ids.application = await insertEvent(tx, {
      petId: shelterPet,
      eventType: "adoption_application_submitted",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(5),
      payload: {
        payload_version: 2,
        applicant_user_id: O,
        related_organization_id: X,
        housing_type: "departamento",
        other_pets: null,
        daily_routine: PD.routine,
        notes: null,
        profile_sharing_consent_at: at(5).toISOString(),
        motivation: PD.motivation,
        prior_pets: "yes_before",
      },
    });

    // Security review of T3-A2b, item 1: a MACHINE CODE under a prose key
    // survives; prose in the same key does not.
    ids.statusCode = await insertEvent(tx, {
      petId: pet,
      eventType: "status_changed",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(6),
      payload: {
        payload_version: 1,
        from_status: "lost",
        to_status: "active",
        reason: "return_to_original_owner",
      },
    });
    ids.statusProse = await insertEvent(tx, {
      petId: pet,
      eventType: "status_changed",
      recordedByUserId: O,
      authorRole: "owner",
      occurredAt: at(7),
      payload: {
        payload_version: 1,
        from_status: "active",
        to_status: "lost",
        reason: PD.lostReason,
      },
    });
    // Item 3: the shelter's info request to the applicant — new shape and the
    // legacy shape (message in `text`). Written by a VERIFIED shelter on its own
    // pet: only the named-party scope reaches them.
    ids.infoRequest = await insertEvent(tx, {
      petId: shelterPet,
      eventType: "note_added",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(4),
      payload: {
        payload_version: 1,
        category: "system",
        text: "El refugio pidió más información sobre una postulación",
        info_request_message: PD.infoRequest,
        kind: "adoption_info_requested",
        application_event_id: ids.application,
      },
      extra: { authorVerified: true },
    });
    ids.infoRequestLegacy = await insertEvent(tx, {
      petId: shelterPet,
      eventType: "note_added",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(4),
      payload: {
        payload_version: 1,
        category: "system",
        text: PD.infoRequestLegacy,
        kind: "adoption_info_requested",
        application_event_id: ids.application,
      },
      extra: { authorVerified: true },
    });
    // Item 2: an adoption reversal describes the ADOPTER, whoever writes it.
    ids.finalization = await insertEvent(tx, {
      petId: shelterPet,
      eventType: "adoption_finalized",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(3),
      payload: { payload_version: 1, adopter_user_id: O },
      extra: { authorVerified: true },
    });
    ids.reversal = await insertEvent(tx, {
      petId: shelterPet,
      eventType: "adoption_reversed",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(2),
      payload: {
        payload_version: 1,
        actor: "shelter",
        reason: PD.reversalReason,
        reverted_finalization_event_id: ids.finalization,
      },
      extra: { authorVerified: true },
    });
    // Item 5 (PO default): on O's pet, an UNVERIFIED shelter's clinical prose
    // is personal data; a verified shelter's is a kept professional act.
    ids.unverifiedShelter = await insertEvent(tx, {
      petId: pet,
      eventType: "clinical_info_logged",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(10),
      payload: {
        payload_version: 1,
        sub_kind: "other",
        title: "Control",
        details: PD.unverifiedDetails,
      },
      extra: { authorVerified: false },
    });
    ids.verifiedShelter = await insertEvent(tx, {
      petId: pet,
      eventType: "clinical_info_logged",
      recordedByUserId: X,
      authorRole: "shelter",
      occurredAt: at(11),
      payload: {
        payload_version: 1,
        sub_kind: "other",
        title: "Control",
        details: "Peso estable, sin hallazgos.",
      },
      extra: { authorVerified: true },
    });

    const allIds = Object.values(ids);
    const before = await snapshotEvents(tx, allIds);

    await eraseAs(tx, O);
    const after = await snapshotEvents(tx, allIds);
    const audit = await overrideAuditText(tx);

    await eraseAs(tx, O);
    const auditAfterSecondRun = (await overrideAuditText(tx)).length;

    return { before, after, ids, audit, auditAfterSecondRun, vetId: V };
  });
}

function byId(snap: EventSnapshot[], id: string): EventSnapshot {
  const found = snap.find((r) => r.id === id);
  if (!found) throw new Error(`row ${id} missing`);
  return found;
}

function projections(snap: EventSnapshot[]) {
  const events = snap.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    recordedAt: r.occurred_at,
    payload: r.payload,
    authorRole: r.author_role,
    recordedByUserId: r.recorded_by_user_id,
  }));
  const compliance = deriveComplianceState({
    now: new Date("2026-09-22T12:00:00Z"),
    events,
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
  });
  return {
    compliance: compliance.cards.map((c) => JSON.stringify(c)),
    status: replayPetStatus(events),
    rabies: replayPetRabiesObservation(events),
    chip: replayPetMicrochip(events),
  };
}

describe("erase_subject_data keeps the pet's history (PO decision 5A)", () => {
  let o: Observed;
  beforeAll(async () => {
    o = await runOwnerErasure();
  }, 120_000);
  const b = (k: string) => byId(o.before, o.ids[k] as string);
  const a = (k: string) => byId(o.after, o.ids[k] as string);

  it("keeps every row, with its id, event_type and occurred_at", () => {
    expect(o.after).toHaveLength(o.before.length);
    expect(o.after.map((r) => [r.id, r.event_type, r.occurred_at])).toEqual(
      o.before.map((r) => [r.id, r.event_type, r.occurred_at]),
    );
  });

  it("keeps the vet's vaccination, sterilization and rabies observation deep-equal", () => {
    for (const k of ["vaccination", "sterilization", "rabiesStart", "rabiesEnd"]) {
      expect(a(k), k).toEqual(b(k));
    }
    expect(a("rabiesEnd").payload.closure_notes).toBe(
      "Sin signos compatibles con rabia al día 10.",
    );
    expect(a("vaccination").notes).toBe("Aplicada sin reacciones adversas.");
  });

  it("keeps the bite's epidemiology and removes the victim's identity", () => {
    const p = a("bite").payload;
    expect(p.incident_type).toBe("bite_inflicted");
    expect(p.severity).toBe("moderate");
    expect(p.victim_kind).toBe("human");
    expect(p.rabies_vaccine_valid_at_incident).toBe(true);
    expect(p.jurisdiction_province).toBe("Buenos Aires");
    expect(p.jurisdiction_locality).toBe("La Plata");
    expect("victim_contact_name" in p).toBe(false);
    expect("victim_contact_phone" in p).toBe(false);
    expect(p.injuries_summary).toBe(SENTINEL);
    expect(p.context).toBe(SENTINEL);
    expect(p.location_description).toBe(SENTINEL);
    expect(p.victim_age_estimate).toBe(SENTINEL);
    expect(p.victim_age_band).toBe("child_under_15");
    expect(a("bite").location_lat).toBe("-34.9200000");
    expect(a("bite").location_lng).toBe("-57.9500000");
  });

  it("keeps the death's facts; the owner's cause_detail goes, the vet's stays", () => {
    const p = a("death").payload;
    expect(p.cause).toBe("illness");
    expect(p.disease_code).toBe("rabia");
    expect(p.is_reportable).toBe(true);
    expect(p.vet_name).toBe("Dra. Vet Fixture");
    expect(p.cause_detail).toBe(SENTINEL);
    expect(a("vetDeath")).toEqual(b("vetDeath"));
  });

  it("keeps microchip_replaced.reason — the enum 0159-0228 overwrote", () => {
    expect(a("chip").payload.reason).toBe("damaged");
    expect(a("chip").payload.new_chip_number).toBe("985112000000002");
  });

  it("removes the finder's identity from a sighting on the owner's pet", () => {
    const p = a("sighting").payload;
    expect("finderName" in p).toBe(false);
    expect("finderContact" in p).toBe(false);
    expect(p.message).toBe(SENTINEL);
    expect(p.kind).toBe("sighting");
    expect(a("sighting").location_lat).toBe("-34.6000000");
  });

  it("reaches what the owner wrote on a pet they no longer own, and their adoption application", () => {
    expect(a("exOwnedNote").payload.text).toBe(SENTINEL);
    expect(a("exOwnedNote").payload.category).toBe("behavior");
    const app = a("application").payload;
    expect(app.motivation).toBe(SENTINEL);
    expect(app.daily_routine).toBe(SENTINEL);
    expect(app.housing_type).toBeNull();
    expect(app.prior_pets).toBeNull();
    expect(app.applicant_user_id).toBe(b("application").payload.applicant_user_id);
  });

  it("replays the compliance projections to the same answer", () => {
    const petIds = [
      "vaccination",
      "sterilization",
      "bite",
      "rabiesStart",
      "rabiesEnd",
      "chip",
      "sighting",
      "death",
    ].map((k) => o.ids[k] as string);
    const pick = (snap: EventSnapshot[]) => snap.filter((r) => petIds.includes(r.id));
    expect(projections(pick(o.after))).toEqual(projections(pick(o.before)));
    expect(projections(pick(o.after)).status.status).toBe("deceased");
  });

  it("leaves no removed value anywhere in the rows or the override audit trail", () => {
    const rowsText = JSON.stringify(o.after);
    const auditText = o.audit.map((x) => x.text).join("\n");
    for (const v of Object.values(PD)) {
      expect(rowsText, v).not.toContain(v);
      expect(auditText, v).not.toContain(v);
    }
    // The trail exists: one override row per changed event.
    expect(o.audit.length).toBeGreaterThan(0);
  });

  it("keeps a machine code under a prose key and redacts prose in the same key (review item 1)", () => {
    expect(a("statusCode").payload.reason).toBe("return_to_original_owner");
    expect(a("statusProse").payload.reason).toBe(SENTINEL);
  });

  it("reaches the shelter's info request to the applicant, new and legacy shape (review item 3)", () => {
    expect(a("infoRequest").payload.info_request_message).toBe(SENTINEL);
    // The per-kind legacy rule also reaches the new shape's fixed label; the
    // label names nobody, so losing it costs nothing — the kind still says
    // what the row was.
    expect(a("infoRequest").payload.text).toBe(SENTINEL);
    expect(a("infoRequest").payload.kind).toBe("adoption_info_requested");
    expect(a("infoRequestLegacy").payload.text).toBe(SENTINEL);
    expect(a("infoRequestLegacy").payload.kind).toBe("adoption_info_requested");
  });

  it("reaches an adoption reversal's reason about the adopter, although a shelter wrote it (review item 2)", () => {
    expect(a("reversal").payload.reason).toBe(SENTINEL);
    expect(a("reversal").payload.actor).toBe("shelter");
  });

  it("keeps a verified shelter's clinical prose and redacts an unverified one's (review item 5)", () => {
    expect(a("unverifiedShelter").payload.details).toBe(SENTINEL);
    expect(a("verifiedShelter")).toEqual(b("verifiedShelter"));
  });

  it("writes nothing on a second run", () => {
    expect(o.auditAfterSecondRun).toBe(o.audit.length);
  });
});

describe("erasing the VET keeps the professional acts (A05-6, art. 16 inc. 5)", () => {
  let v: { before: EventSnapshot[]; after: EventSnapshot[] };
  beforeAll(async () => {
    v = await inRolledBackTx(async (tx) => {
      const O = await seedUser(tx, "a2b-owner2");
      const V = await seedUser(tx, "a2b-vet2");
      const pet = await seedPet(tx, O);
      const ids = [
        await insertEvent(tx, {
          petId: pet,
          eventType: "vaccination_administered",
          recordedByUserId: V,
          authorRole: "vet",
          payload: {
            payload_version: 1,
            vaccine_name: "Séxtuple",
            administered_by: "Dr. V",
            administered_by_user_id: V,
            next_due_at: null,
          },
          notes: "Refuerzo en 21 días.",
        }),
        await insertEvent(tx, {
          petId: pet,
          eventType: "vet_visit_logged",
          recordedByUserId: V,
          authorRole: "vet",
          payload: {
            payload_version: 1,
            reason: "Control",
            diagnosis: "Otitis externa bilateral",
            vet_name: "Dr. V",
            clinic: "Clínica Sur",
          },
        }),
        await insertEvent(tx, {
          petId: pet,
          eventType: "rabies_observation_ended",
          recordedByUserId: V,
          authorRole: "vet",
          payload: {
            payload_version: 1,
            bite_event_id: null,
            observation_started_event_id: pet,
            outcome: "healthy",
            closed_by_role: "vet",
            closure_notes: "Alta sanitaria al día 10.",
            death_event_id: null,
          },
        }),
      ];
      const before = await snapshotEvents(tx, ids);
      await eraseAs(tx, V);
      const after = await snapshotEvents(tx, ids);
      return { before, after };
    });
  }, 120_000);

  it("administered_by, diagnosis, closure_notes and the notes column survive the vet's own erasure", () => {
    expect(v.before).toHaveLength(3);
    expect(v.after).toEqual(v.before);
    const text = JSON.stringify(v.after);
    for (const kept of [
      "Dr. V",
      "Otitis externa bilateral",
      "Alta sanitaria al día 10.",
      "Refuerzo en 21 días.",
    ]) {
      expect(text).toContain(kept);
    }
  });
});

describe("pii.victim_age_band — years win over months (review item 4)", () => {
  let bands: Record<string, string>;
  beforeAll(async () => {
    bands = await inRolledBackTx(async (tx) => {
      const out: Record<string, string> = {};
      for (const text of AGE_CASES.map(([t]) => t)) {
        const [row] = await rows(tx, sql`SELECT pii.victim_age_band(${text}) AS band`);
        out[text] = row?.band as string;
      }
      return out;
    });
  }, 60_000);

  it.each(AGE_CASES)("%s → %s", (text, band) => {
    expect(bands[text]).toBe(band);
  });
});
