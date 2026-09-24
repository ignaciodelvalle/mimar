// Canary test for the pet_events erasure, generated from the classification
// itself (T3-A2b, design §4).
//
// For EVERY event type, every leaf of its zod payload schema is set to a
// unique canary string `CANARY:<type>:<path>:<variant>` and the row is seeded in
// four variants that exercise each scope and author class:
//   a  owner row written by the subject on the subject's pet   (scopes 1+4)
//   b  vet row written by a vet on the subject's pet           (scope 4)
//   c  shelter row on somebody else's pet naming the subject   (scope 8)
//   d  legacy owner row, no recorded author, on a pet the subject used to own
//      (scope 2)
//   e  UNVERIFIED shelter row on the subject's pet (scope 4) — the PO default:
//      an unverified org's words are personal data, not a kept act
// plus the notes column and precise coordinates. After erasing the subject
// through the LIVE erase_subject_data, every canary the classification says is
// the person's must be gone from the payload, the notes and the override audit
// trail, and every other canary must survive byte for byte. The expectation is
// computed from PAYLOAD_PRIVACY, not retyped: add a key to a schema and this
// test covers it on the next run.

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { PayloadSchemas } from "@/lib/events/event-schemas";
import {
  COORDINATE_PRIVACY,
  PAYLOAD_PRIVACY,
  PET_EVENT_COLUMN_PRIVACY,
  PROFILE_CHANGE_FIELD_PRIVACY,
  type PrivacyEntry,
  authorKept,
} from "@/lib/events/payload-privacy";
import { schemaNodes } from "@/scripts/check-event-payload-privacy";

import {
  type EventSnapshot,
  type SeedEvent,
  type Tx,
  eraseAs,
  inRolledBackTx,
  insertEvent,
  overrideAuditText,
  seedPet,
  seedUser,
  snapshotEvents,
} from "./_helpers/erasure-tx";

type Variant = "a" | "b" | "c" | "d" | "e";
const VARIANTS: readonly Variant[] = ["a", "b", "c", "d", "e"];
const AUTHOR: Record<Variant, SeedEvent["authorRole"]> = {
  a: "owner",
  b: "vet",
  c: "shelter",
  d: "owner",
  e: "shelter",
};
const VERIFIED: Record<Variant, boolean> = { a: false, b: true, c: true, d: false, e: false };
const BROAD: Record<Variant, boolean> = { a: true, b: true, c: false, d: true, e: true };
const kept = (v: Variant): boolean => authorKept(AUTHOR[v], VERIFIED[v]);

const LAT = "-34.6037123";
const LNG = "-58.3815987";

/** Fields the changelog canary records: one personal, one compliance fact. */
const PROFILE_FIELD = "permanent_conditions_other";
const AMENDED_FIELD = "diagnosis"; // an author-gated key of vet_visit_logged

type Leaf = { path: string; canary: string; entry: PrivacyEntry };

function coveringEntry(eventType: string, path: string): PrivacyEntry {
  const entries = PAYLOAD_PRIVACY[eventType as keyof typeof PAYLOAD_PRIVACY];
  let p = path;
  for (;;) {
    if (Object.hasOwn(entries, p)) return entries[p] as PrivacyEntry;
    if (p.endsWith("[]")) p = p.slice(0, -2);
    else if (p.includes(".")) p = p.slice(0, p.lastIndexOf("."));
    else throw new Error(`${eventType}.${path} has no covering entry`);
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node: Record<string, unknown> = target;
  segs.forEach((raw, i) => {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const last = i === segs.length - 1;
    if (isArray) {
      const arr = (node[key] as Record<string, unknown>[] | undefined) ?? [{}];
      node[key] = arr;
      node = arr[0] as Record<string, unknown>;
    } else if (last) {
      node[key] = value;
    } else {
      node[key] = (node[key] as Record<string, unknown> | undefined) ?? {};
      node = node[key] as Record<string, unknown>;
    }
  });
}

function getPath(target: unknown, path: string): unknown {
  let node: unknown = target;
  for (const raw of path.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    node = (node as Record<string, unknown> | undefined)?.[key];
    if (isArray) node = (node as unknown[] | undefined)?.[0];
  }
  return node;
}

type Refs = {
  subject: string;
  other: string;
  application: string;
  finalization: string;
  amendTarget: string;
};

/** Local party keys (`a`) and dereferencing ones (`a>b`, keyed by `a`) of a type. */
function partyKeysOf(eventType: string): { direct: Set<string>; refs: Set<string> } {
  const direct = new Set<string>();
  const refs = new Set<string>();
  for (const entry of Object.values(PAYLOAD_PRIVACY[eventType as keyof typeof PAYLOAD_PRIVACY])) {
    if (entry.class !== "personal_data" && entry.class !== "professional_act") continue;
    for (const pk of entry.partyKeys ?? []) {
      const [local, inner] = pk.split(">");
      (inner === undefined ? direct : refs).add(local as string);
    }
  }
  return { direct, refs };
}

/**
 * The value a leaf must hold for the scopes to be exercised (a party id, a
 * reference to a seeded row, a changelog field name), or undefined when the
 * leaf simply gets its canary.
 */
function wiredValue(eventType: string, path: string, variant: Variant, refs: Refs): unknown {
  const party = partyKeysOf(eventType);
  if (party.direct.has(path)) return variant === "c" ? refs.subject : refs.other;
  if (party.refs.has(path)) {
    return path === "application_event_id" ? refs.application : refs.finalization;
  }
  if (eventType === "event_amended" && path === "target_event_id") return refs.amendTarget;
  if (path === "changes[].field") {
    return eventType === "pet_profile_updated" ? PROFILE_FIELD : AMENDED_FIELD;
  }
  return undefined;
}

/** The payload of one variant, with every leaf set to its canary. */
function buildPayload(
  eventType: string,
  variant: Variant,
  refs: Refs,
): { payload: Record<string, unknown>; leaves: Leaf[] } {
  const schema = PayloadSchemas[eventType as keyof typeof PayloadSchemas] as z.ZodTypeAny;
  const payload: Record<string, unknown> = {};
  const leaves: Leaf[] = [];
  for (const [path, node] of schemaNodes(schema)) {
    if (!node.leaf) continue;
    const wired = wiredValue(eventType, path, variant, refs);
    if (wired !== undefined) {
      setPath(payload, path, wired);
      continue;
    }
    const canary = `CANARY:${eventType}:${path}:${variant}`;
    setPath(
      payload,
      path,
      node.kinds.has("array") && !node.kinds.has("string") ? [canary] : canary,
    );
    leaves.push({ path, canary, entry: coveringEntry(eventType, path) });
  }
  return { payload, leaves };
}

/** Should the erasure remove this leaf, for this variant? */
function expectRemoved(eventType: string, leaf: Leaf, variant: Variant): boolean {
  const authorIsKept = kept(variant);
  const e = leaf.entry;
  if (e.class === "compliance_fact") return false;
  if (e.class === "mirrored") {
    if (!BROAD[variant]) return false;
    if (eventType === "pet_profile_updated") {
      return PROFILE_CHANGE_FIELD_PRIVACY[PROFILE_FIELD]?.class === "personal_data";
    }
    // event_amended mirrors vet_visit_logged.diagnosis: author-gated.
    return !authorIsKept;
  }
  const reached = BROAD[variant] || (e.partyKeys?.length ?? 0) > 0;
  if (!reached) return false;
  if (e.class === "professional_act") return e.authorGated !== undefined && !authorIsKept;
  return true;
}

type Seeded = { id: string; eventType: string; variant: Variant; leaves: Leaf[] };

type Observed = {
  seeded: Seeded[];
  before: EventSnapshot[];
  after: EventSnapshot[];
  audit: Array<{ eventId: string; text: string }>;
};

async function seedAndErase(): Promise<Observed> {
  return inRolledBackTx(async (tx: Tx) => {
    const S = await seedUser(tx, "a2b-canary-subject");
    const V = await seedUser(tx, "a2b-canary-vet");
    const X = await seedUser(tx, "a2b-canary-shelter");
    const DAY = 86_400_000;
    const subjectPet = await seedPet(tx, S);
    const exPet = await seedPet(tx, S, {
      startedAt: new Date(Date.now() - 400 * DAY),
      endedAt: new Date(Date.now() - 10 * DAY),
    });
    const otherPet = await seedPet(tx, X);

    // Referenced rows for the S3 keys that dereference another event.
    const application = await insertEvent(tx, {
      petId: otherPet,
      eventType: "adoption_application_submitted",
      recordedByUserId: X,
      authorRole: "shelter",
      payload: { applicant_user_id: S },
    });
    const finalization = await insertEvent(tx, {
      petId: otherPet,
      eventType: "adoption_finalized",
      recordedByUserId: X,
      authorRole: "shelter",
      payload: { adopter_user_id: S },
    });
    const amendTarget = await insertEvent(tx, {
      petId: subjectPet,
      eventType: "vet_visit_logged",
      recordedByUserId: V,
      authorRole: "vet",
      payload: { reason: "Control", diagnosis: "Dx" },
    });
    const refs: Refs = { subject: S, other: randomUUID(), application, finalization, amendTarget };

    const seeded: Seeded[] = [];
    for (const eventType of Object.keys(PayloadSchemas)) {
      for (const variant of VARIANTS) {
        const { payload, leaves } = buildPayload(eventType, variant, refs);
        const where = {
          a: { petId: subjectPet, recordedByUserId: S },
          b: { petId: subjectPet, recordedByUserId: V },
          c: { petId: otherPet, recordedByUserId: X },
          d: { petId: exPet, recordedByUserId: null },
          e: { petId: subjectPet, recordedByUserId: X },
        }[variant];
        const id = await insertEvent(tx, {
          ...where,
          eventType,
          authorRole: AUTHOR[variant],
          extra: { authorVerified: VERIFIED[variant] },
          payload,
          occurredAt: new Date(Date.now() - 100 * DAY),
          notes: `CANARY:${eventType}:#notes:${variant}`,
          locationLat: LAT,
          locationLng: LNG,
        });
        seeded.push({ id, eventType, variant, leaves });
      }
    }

    const ids = seeded.map((s) => s.id);
    const before = await snapshotEvents(tx, ids);
    await eraseAs(tx, S);
    const after = await snapshotEvents(tx, ids);
    const audit = await overrideAuditText(tx);
    return { seeded, before, after, audit };
  });
}

describe("canary — every leaf of every event type, per scope and author class", () => {
  let o: Observed;
  beforeAll(async () => {
    o = await seedAndErase();
  }, 300_000);

  it("seeds every event type in every variant", () => {
    expect(new Set(o.seeded.map((s) => s.eventType)).size).toBe(Object.keys(PayloadSchemas).length);
    expect(o.after).toHaveLength(o.seeded.length);
  });

  it("removes every personal canary and keeps every other canary byte for byte", () => {
    const failures: string[] = [];
    let removedCount = 0;
    let keptCount = 0;
    for (const s of o.seeded) {
      const row = o.after.find((r) => r.id === s.id);
      if (!row) {
        failures.push(`${s.eventType}/${s.variant}: row missing`);
        continue;
      }
      const text = JSON.stringify(row.payload);
      for (const leaf of s.leaves) {
        if (expectRemoved(s.eventType, leaf, s.variant)) {
          removedCount++;
          if (text.includes(leaf.canary)) failures.push(`${leaf.canary} survived`);
        } else {
          keptCount++;
          const got = getPath(row.payload, leaf.path);
          const want = getPath(o.before.find((r) => r.id === s.id)?.payload, leaf.path);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            failures.push(`${leaf.canary} changed: ${JSON.stringify(got)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Non-vacuity: both halves of the claim were exercised at scale.
    expect(removedCount).toBeGreaterThan(200);
    expect(keptCount).toBeGreaterThan(1000);
  });

  it("the notes column follows its class; coordinates are coarsened only where they locate a person", () => {
    const notesEntry = PET_EVENT_COLUMN_PRIVACY.notes;
    const coarsened = (t: string) =>
      COORDINATE_PRIVACY[t as keyof typeof COORDINATE_PRIVACY] === "coarsen";
    const failures: string[] = [];
    for (const s of o.seeded) {
      const row = o.after.find((r) => r.id === s.id) as EventSnapshot;
      const notesRemoved =
        BROAD[s.variant] &&
        notesEntry?.class === "professional_act" &&
        notesEntry.authorGated !== undefined &&
        !kept(s.variant);
      const wantNotes = notesRemoved
        ? "[dato removido]"
        : `CANARY:${s.eventType}:#notes:${s.variant}`;
      if (row.notes !== wantNotes) failures.push(`${s.eventType}/${s.variant} notes=${row.notes}`);
      const coarse = BROAD[s.variant] && coarsened(s.eventType);
      const wantLat = coarse ? "-34.6000000" : LAT;
      if (row.location_lat !== wantLat)
        failures.push(`${s.eventType}/${s.variant} lat=${row.location_lat}`);
    }
    expect(failures).toEqual([]);
  });

  it("no removed canary reaches the override audit trail", () => {
    const auditText = o.audit.map((a) => a.text).join("\n");
    const leaked: string[] = [];
    for (const s of o.seeded) {
      for (const leaf of s.leaves) {
        if (expectRemoved(s.eventType, leaf, s.variant) && auditText.includes(leaf.canary)) {
          leaked.push(leaf.canary);
        }
      }
    }
    expect(leaked).toEqual([]);
    expect(o.audit.length).toBeGreaterThan(0);
  });
});
