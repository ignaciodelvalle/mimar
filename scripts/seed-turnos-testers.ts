/**
 * Live, bookable turnos for the localities REAL testers live in.
 *
 * WHY THIS EXISTS (measured 2026-09-01, pre-test audit): the bulk seed's
 * campaign windows are frozen on purpose — seed-panorama.ts anchors at
 * ANCHOR_ISO 2026-06-20 for reproducibility, so its `effectiveUntil` passed on
 * 2026-07-20 and re-running it cannot mint a single future slot
 * (lib/infra/slot-materialization.ts clamps to the rule's window). The one
 * run-relative campaign (seed-demo-scenario.ts) is locked to CABA/Palermo. So
 * a tester whose pet lives anywhere else opens "Buscar turno" and gets an
 * empty list forever — and the phone cannot search another locality (it uses
 * the pet's own jurisdiction). This script plants an approved offering with
 * OPEN FUTURE slots per locality the operator names — the 14 pilot testers'
 * real localities, which only the PO knows.
 *
 * RELATIVE DATES, DELIBERATELY: everything derives from run time, so
 * RE-RUNNING REFRESHES — an existing rule's `effectiveUntil` is pushed out to
 * +30 days and missing future slots are filled in. That is the exact property
 * the frozen seeds cannot have and this one must.
 *
 * RE-RUN SAFETY, per the rule seed-test-users.ts:43 wrote after the 2026-08-21
 * staging incident: every step guards ON THE CONSTRAINT IT WILL HIT, and the
 * function converges from a PARTIAL state, not just from nothing —
 *   offering  → (host org, province, locality, kind) among this script's own
 *               `DIM-PILOT-…` stock. NOT the token: the token derivation changed
 *               on 2026-09-02 and rows seeded before it keep the old one, so a
 *               lookup by token would plant a duplicate. See `seedPair`.
 *   rule      → one per offering (updated, never duplicated)
 *   slots     → time_slots_unique_starts UNIQUE (offering, starts_at)
 *
 * Usage (pairs are "Provincia|Localidad", catalog spelling for the province):
 *   pnpm tsx scripts/seed-turnos-testers.ts "Buenos Aires|La Plata" "CABA|Palermo"
 *
 * DATABASE_URL decides the target (read from .env.local / .env, same as
 * migrate.ts); the Destino line prints before anything is written. Writing to
 * staging is an operator action — same rule as every seed here.
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { and, eq, like } from "drizzle-orm";

import { describeTarget } from "./_db-target";

const SLOT_DAYS_AHEAD = 14;
const RULE_DAYS_AHEAD = 30;
/** UTC hours that land in the AR working morning/afternoon (UTC-3: 11–14h). */
const SLOT_HOURS_UTC = [14, 15, 16, 17];
const SLOT_CAPACITY = 4;
const DURATION_MINUTES = 15;

/** Every offering this script has ever minted starts with it. */
const PILOT_TOKEN_PREFIX = "DIM-PILOT-";

/**
 * Deterministic per-locality token so the offering guard has a constraint.
 *
 * OFF-FORMAT ON PURPOSE. The app mints `service_offerings.public_token` as
 * `OFR-XXXX-XXXX` (`generateOfferingToken`, lib/infra/publicToken.ts — a random
 * 31-char-alphabet draw). This one is derived, not drawn, so re-running
 * converges instead of minting a second offering, and it is unmistakable at a
 * glance for seeded pilot stock rather than a real row.
 *
 * SHAPE: `DIM-PILOT-<readable head, <=24 chars>-<6 hex of the FULL slug>`.
 *
 * WHY THE HASH TAIL EXISTS (fixed 2026-09-02, cola item 30(ii)). The head is a
 * readability cap and nothing more — `public_token` is `text NOT NULL UNIQUE`
 * with no length constraint. But a cap on a derived UNIQUE key is never free:
 * the province is slugged FIRST and eats the budget first, so "Santiago del
 * Estero" leaves four characters for the locality. Two localities in one
 * province whose slugs agreed through character 24 produced the SAME token, and
 * the guard below read that as "offering exists" and SKIPped the second one
 * silently — a tester in that locality would open "Buscar turno" and find the
 * empty list this whole script exists to prevent. The tail is taken over the
 * UNCAPPED slug, so the token stays scannable AND distinct.
 *
 * Still deterministic across runs and machines: the digest is computed here from
 * the string, with no salt, clock or randomness in it.
 */
function pilotToken(province: string, locality: string): string {
  const slug = `${province}-${locality}`
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const head = slug.slice(0, 24).replace(/-$/, "");
  return `${PILOT_TOKEN_PREFIX}${head}-${slugDigest(slug)}`;
}

/**
 * Six hex characters of FNV-1a over the full slug.
 *
 * FNV-1a rather than `crypto.createHash`: this has to be a pure, synchronous,
 * dependency-free derivation that a reader can check by eye, and the property
 * needed is "two different localities differ", not preimage resistance. 24 bits
 * over a pilot of a few dozen localities is a collision probability in the
 * 1-in-10^4 range, and the pair it would take is also visible in the log lines
 * below, which print the token beside the province/locality that produced it.
 */
function slugDigest(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(8, "0").slice(-6);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function seedPair(
  deps: {
    db: typeof import("../db")["db"];
    serviceOfferings: typeof import("../db")["serviceOfferings"];
    serviceScheduleRules: typeof import("../db")["serviceScheduleRules"];
    timeSlots: typeof import("../db")["timeSlots"];
  },
  hostOrgId: string,
  province: string,
  locality: string,
  now: Date,
  effFrom: string,
  effUntil: string,
): Promise<void> {
  const { db, serviceOfferings, serviceScheduleRules, timeSlots } = deps;
  const token = pilotToken(province, locality);

  // THE GUARD LOOKS UP THE LOCALITY, NOT THE TOKEN, and that is what makes the
  // 2026-09-02 token change safe on a database this script has already run
  // against. Rows seeded before it carry the OLD 24-char token, which the new
  // derivation does not reproduce; a lookup by token would miss them and plant a
  // SECOND approved offering for the same locality — every tester there would
  // then see two identical campaigns. Matching on (host org, province, locality,
  // service kind) is what "this locality's pilot offering" actually means, and it
  // converges from both shapes.
  //
  // The `DIM-PILOT-` predicate is not decoration: without it this tuple could
  // also match a REAL offering, or one of the demo seeds' rabies campaigns in the
  // same org and locality, and the script would then push its window and slots
  // onto a row it does not own. Narrowed to its own stock, it cannot.
  //
  // Already-seeded rows KEEP their old token. Nothing reads the shape (no test,
  // no e2e spec, no query outside this file), the column only has to be unique,
  // and rewriting live tokens would break any link an operator already shared.
  const [existingOffering] = await db
    .select({ id: serviceOfferings.id, publicToken: serviceOfferings.publicToken })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.organizationId, hostOrgId),
        eq(serviceOfferings.jurisdictionProvince, province),
        eq(serviceOfferings.jurisdictionLocality, locality),
        eq(serviceOfferings.serviceKind, "vaccination_rabies"),
        like(serviceOfferings.publicToken, `${PILOT_TOKEN_PREFIX}%`),
      ),
    )
    .limit(1);

  let offeringId = existingOffering?.id ?? null;
  if (offeringId) {
    // The EXISTING token, never the freshly derived one: on a pre-2026-09-02 row
    // they differ, and printing the derived one would tell the operator a token
    // that resolves to nothing.
    console.log(
      `  SKIP  ${existingOffering.publicToken} — offering exists (${province} / ${locality})`,
    );
  } else {
    const [inserted] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: token,
        organizationId: hostOrgId,
        jurisdictionCountry: "AR",
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
        serviceKind: "vaccination_rabies",
        displayName: "Vacunación antirrábica (prueba piloto)",
        description:
          "Campaña de la prueba piloto — turnos reales para los testers de esta localidad.",
        durationMinutes: DURATION_MINUTES,
        slotCapacity: SLOT_CAPACITY,
        eligibilitySpecies: ["dog", "cat"],
        status: "approved",
        isPublic: true,
      })
      .returning({ id: serviceOfferings.id });
    offeringId = inserted.id;
    console.log(`  NEW   ${token} — offering created (${province} / ${locality})`);
  }

  // One rule per pilot offering; re-running REFRESHES its window instead of
  // stacking a second rule.
  const [existingRule] = await db
    .select({ id: serviceScheduleRules.id })
    .from(serviceScheduleRules)
    .where(eq(serviceScheduleRules.serviceOfferingId, offeringId))
    .limit(1);

  let ruleId = existingRule?.id ?? null;
  if (ruleId) {
    await db
      .update(serviceScheduleRules)
      .set({ effectiveFrom: effFrom, effectiveUntil: effUntil, status: "active" })
      .where(eq(serviceScheduleRules.id, ruleId));
    console.log(`        rule window refreshed → ${effUntil}`);
  } else {
    const [rule] = await db
      .insert(serviceScheduleRules)
      .values({
        serviceOfferingId: offeringId,
        daysOfWeek: [1, 2, 3, 4, 5, 6],
        startTimeLocal: "11:00:00",
        endTimeLocal: "14:00:00",
        effectiveFrom: effFrom,
        effectiveUntil: effUntil,
        status: "active",
      })
      .returning({ id: serviceScheduleRules.id });
    ruleId = rule.id;
    console.log(`        rule created → ${effUntil}`);
  }

  // Slots materialized here rather than left to the cron, so the operator
  // sees bookable rows the moment the script exits. Guarded per
  // (offering, starts_at); a re-run only fills what is missing.
  let created = 0;
  let kept = 0;
  for (let day = 1; day <= SLOT_DAYS_AHEAD; day++) {
    const base = new Date(now.getTime() + day * 24 * 3600 * 1000);
    if (base.getUTCDay() === 0) continue; // rule excludes Sundays
    for (const hour of SLOT_HOURS_UTC) {
      const startsAt = new Date(base);
      startsAt.setUTCHours(hour, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + DURATION_MINUTES * 60 * 1000);

      const [existingSlot] = await db
        .select({ id: timeSlots.id })
        .from(timeSlots)
        .where(and(eq(timeSlots.serviceOfferingId, offeringId), eq(timeSlots.startsAt, startsAt)))
        .limit(1);
      if (existingSlot) {
        kept++;
        continue;
      }
      await db.insert(timeSlots).values({
        serviceOfferingId: offeringId,
        ruleId,
        startsAt,
        endsAt,
        capacity: SLOT_CAPACITY,
        bookingsCount: 0,
        status: "open",
      });
      created++;
    }
  }
  console.log(`        slots: ${created} created, ${kept} already present\n`);
}

async function main() {
  const pairs = process.argv.slice(2).map((raw) => {
    const [province, locality] = raw.split("|").map((s) => s?.trim() ?? "");
    return { raw, province, locality };
  });

  if (pairs.length === 0) {
    console.error(
      'Usage: pnpm tsx scripts/seed-turnos-testers.ts "Provincia|Localidad" ["Provincia|Localidad" ...]',
    );
    process.exit(2);
  }

  for (const p of pairs) {
    if (!p.province || !p.locality) {
      console.error(`✗ malformed pair ${JSON.stringify(p.raw)} — expected "Provincia|Localidad"`);
      process.exit(2);
    }
  }

  const DATABASE_URL = process.env.DATABASE_URL ?? "";
  if (!DATABASE_URL) {
    console.error("✗ DATABASE_URL is not set (read from .env.local / .env)");
    process.exit(2);
  }
  const target = describeTarget(DATABASE_URL);
  console.log(`\n  Destino: ${target.label}${target.isLocal ? "  [LOCAL]" : "  [REMOTO]"}\n`);

  // Imported AFTER loadEnv — db/index.ts throws when DATABASE_URL is missing
  // at module load, the same arrangement every seed in this directory uses.
  const { db, organizations, serviceOfferings, serviceScheduleRules, timeSlots } = await import(
    "../db"
  );
  // Same reason, transitively: jurisdiction-validation → ar-localidades → db.
  const { resolveCanonicalJurisdiction, JurisdictionValidationError } = await import(
    "../lib/infra/jurisdiction-validation"
  );

  // Resolved against the ar_localities catalog, not merely checked for a known
  // province. The search this offering must be found by
  // (src/modules/events/application/booking/search-bookable-slots.ts:245-272)
  // matches the two columns DIFFERENTLY, and both halves need the canonical
  // spelling:
  //   · PROVINCE by equality — `eq(jurisdictionProvince, args.province)`.
  //   · LOCALITY by SUBSUMPTION, never equality — `inArray(jurisdictionLocality,
  //     localitiesCoveringSearch(province, locality))`, which accepts the
  //     searched locality itself OR a whole-province marker, so a
  //     province-wide offering answers a barrio search
  //     (lib/domain/jurisdiction-canonical.ts:264-270).
  // The subsumption widens which OFFERING answers a search — it does not widen
  // what the offering may be SPELLED as. The accepted set is built from the
  // SEARCHER's canonical locality plus the whole-province forms, and the search
  // takes that locality from the pet's own jurisdiction. So a province typed as
  // an alias ("Ciudad Autónoma de Buenos Aires" instead of the catalog's
  // "CABA") fails the equality, and a locality outside the catalog is in no
  // subsumption set: either one plants a row nobody's search can ever match.
  // Fail loudly instead of writing an invisible one. The CANONICAL names come
  // back out of this resolution and are what gets stored below, never the raw
  // typed strings.
  const resolvedPairs: { raw: string; province: string; locality: string }[] = [];
  for (const p of pairs) {
    try {
      const canonical = await resolveCanonicalJurisdiction({
        rawProvince: p.province,
        rawLocality: p.locality,
      });
      resolvedPairs.push({
        raw: p.raw,
        province: canonical.province.name,
        locality: canonical.locality.localityName,
      });
    } catch (err) {
      const message = err instanceof JurisdictionValidationError ? err.message : String(err);
      console.error(`✗ ${JSON.stringify(p.raw)} — ${message}`);
      process.exit(2);
    }
  }

  // The offering needs an org that exists on BOTH stacks. Preference order:
  // the seeded clinic (real vet login attached), then the seeded shelter.
  const HOST_ORGS = ["Clínica Veterinaria Recoleta", "Refugio Test (Seed)"];
  let hostOrgId: string | null = null;
  let hostOrgName: string | null = null;
  for (const name of HOST_ORGS) {
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.displayName, name))
      .limit(1);
    if (row) {
      hostOrgId = row.id;
      hostOrgName = name;
      break;
    }
  }
  if (!hostOrgId) {
    console.error(
      `✗ none of the host orgs exist here (${HOST_ORGS.join(" / ")}) — run pnpm seed:test (and seed:demo) first`,
    );
    process.exit(1);
  }
  console.log(`  Host org: ${hostOrgName}`);

  const now = new Date();
  const effFrom = isoDate(new Date(now.getTime() - 24 * 3600 * 1000));
  const effUntil = isoDate(new Date(now.getTime() + RULE_DAYS_AHEAD * 24 * 3600 * 1000));

  for (const { province, locality } of resolvedPairs) {
    await seedPair(
      { db, serviceOfferings, serviceScheduleRules, timeSlots },
      hostOrgId,
      province,
      locality,
      now,
      effFrom,
      effUntil,
    );
  }

  console.log("  Done. Verify with a real search from the app or the web (/turnos/buscar).\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
