#!/usr/bin/env tsx
/**
 * Rollback of rehome-by-titular — the DATA step that runs BEFORE the app
 * commit is reverted (design ADR-7). Written and reviewed with the change, not
 * improvised during an incident.
 *
 * WHY THE ORDER IS PART OF THE ROLLBACK
 * -------------------------------------
 * Reverting the app leaves every sponsored pet satisfying `queryAdoptionListing`
 * with the UI to unpublish it gone — listed animals nobody can take down — and
 * `validateEventPayload` no longer knows `rehome_sponsorship_ended`, so the
 * closing fact cannot be written AFTER the revert. So: this script first,
 * through the still-deployed app's writers; then the revert; then a
 * forward-only migration removing both types from `titular_only_event_types()`.
 * Migration 0195's unique index can stay — it is correct on its own.
 *
 * WHAT IT DOES, PER LIVE SPONSORSHIP, IN ONE TRANSACTION
 * -----------------------------------------------------
 *   0. Takes the pet advisory lock — the same first lock every custody writer
 *      of the feature takes (accept, withdraw, finalize).
 *   1. Re-reads the sponsorship ON THE SPINE (an unmatched
 *      `rehome_sponsorship_started` naming a LIVE custody row) — never by the
 *      owner+shelter_custody shape, which also describes a decomiso or an
 *      intake. `payload.ownership_id` is in the spine for exactly this.
 *   2. Closes that custody row BY ID.
 *   3. Clears `adoption_listed_at` / `adoption_listing_paused_at` through the
 *      adoption writer — the catalog stops resolving the pet in this same
 *      transaction.
 *   4. Writes `rehome_sponsorship_ended{outcome:'withdrawn_by_platform'}`
 *      through the single writer, signed `system` with no acting user: nobody
 *      party to the arrangement chose this.
 *   5. Closes the open `adoption_listing` case as cancelled, with a note that
 *      says the platform did it, and closes every open `adoption_application`
 *      case on it the same way. The applications are NOT resolved on the
 *      spine: a resolution needs a reviewer to sign it, and the platform has
 *      none. The org's readers inner-join a live custody row and stop seeing
 *      them anyway.
 * Plus, across pets: every still-open `rehome_request` (a request nobody
 * answered) is closed as cancelled.
 *
 * WHAT IT REFUSES. An ORPHAN — a started event whose custody row already
 * closed without its event — is drift for lint:spine to name and a human to
 * heal (scripts/check-spine-integrity.ts says how). Ending it here would stamp
 * a platform withdrawal onto an arrangement that ended months earlier, onto
 * whoever holds the animal by then. Orphans are listed through the fence's
 * own query and SKIPPED, loudly.
 *
 * USAGE (the writers it reuses import `server-only`, so it runs through the
 * same stub the seeds use — `pnpm rollback:rehome` wraps it)
 *   pnpm rollback:rehome                                  # dry-run (default): one line per action it WOULD take
 *   pnpm rollback:rehome -- --apply                       # do it, one transaction per pet, one line per action
 *   pnpm rollback:rehome -- --pet DIM-XXXX-XXXX [--pet …] [--apply]   # only these pets
 *   --allow-remote    required unless DATABASE_URL is the local Supabase CLI stack: host
 *                     localhost / 127.0.0.1 / ::1 AND port 54322 (scripts/_db-target.ts,
 *                     `isLocalWriterTarget`). The read-only fences' broader LOCAL_HOSTS
 *                     (`db`, `0.0.0.0`, `host.docker.internal`) is NOT trusted here: this
 *                     script WRITES, and a host that is literally `db` is not a guess a
 *                     writer gets to make (WU6/7 review, L-2).
 *   (bare form: node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/rollback-rehome-sponsorships.ts)
 *
 * ENV: DATABASE_URL is REQUIRED and never defaulted — a writer names its
 * target (SESSION pooler for remote runs: per-pet transaction + advisory lock
 * need session semantics). Exit 0 when done (dry or applied), 1 when the
 * target is missing or remote-without-flag, 2 on any per-pet error.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";

import { caseEvents, cases, db, pets } from "@/db";
import {
  closeCaseOwned,
  findOpenAdoptionApplicationCase,
  findOpenAdoptionListingCase,
} from "@/lib/infra/case-helpers";
import {
  endRehomeSponsorship,
  findOpenSponsorship,
} from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";

import { DEFAULT_LOCAL_URL, describeTarget, isLocalWriterTarget } from "./_db-target";
import { type OrphanSponsorshipRow, queryOrphanedSponsorships } from "./check-spine-integrity";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LiveSponsorship = {
  petId: string;
  petPublicToken: string;
  petName: string;
  ownershipId: string;
  organizationId: string;
};

export type OpenRequest = { caseId: string; publicCode: string; petPublicToken: string | null };

export type EndedSponsorship = {
  petPublicToken: string;
  ownershipId: string;
  listingCasePublicCode: string | null;
  applicationsClosed: number;
};

export type RollbackReport = {
  mode: "dry-run" | "apply";
  target: string;
  /** Sponsorships running on the spine over a LIVE custody row — the work. */
  live: LiveSponsorship[];
  /** Started events whose row already closed without an ended event — listed, never touched. */
  orphans: OrphanSponsorshipRow[];
  /** Requests nobody answered — closed as cancelled. */
  openRequests: OpenRequest[];
  ended: EndedSponsorship[];
  closedRequests: OpenRequest[];
  errors: string[];
};

export type RollbackOptions = {
  apply: boolean;
  /** Restrict to these pet public tokens (tests; a targeted incident). */
  petTokens?: readonly string[];
  log?: (line: string) => void;
  /** A postgres-js client for the orphan query; one is opened and closed when absent. */
  sqlClient?: postgres.Sql;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function queryLiveSponsorships(petTokens?: readonly string[]): Promise<LiveSponsorship[]> {
  const tokenFilter =
    petTokens && petTokens.length > 0
      ? sql`AND p.public_token IN (${sql.join(
          petTokens.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql``;
  const rows = await db.execute<{
    pet_id: string;
    public_token: string;
    name: string;
    ownership_id: string;
    organization_id: string;
  }>(sql`
    SELECT DISTINCT ON (started.pet_id)
           p.id AS pet_id,
           p.public_token,
           p.name,
           o.id AS ownership_id,
           started.payload->>'sponsoring_organization_id' AS organization_id
    FROM pet_events started
    JOIN pets p ON p.id = started.pet_id
    JOIN ownerships o ON o.id::text = started.payload->>'ownership_id' AND o.ended_at IS NULL
    WHERE started.event_type = 'rehome_sponsorship_started'
      AND NOT EXISTS (
        SELECT 1 FROM pet_events ended
        WHERE ended.pet_id = started.pet_id
          AND ended.event_type = 'rehome_sponsorship_ended'
          AND ended.payload->>'ownership_id' = started.payload->>'ownership_id'
      )
      ${tokenFilter}
    ORDER BY started.pet_id, started.occurred_at DESC
  `);
  return rows.map((r) => ({
    petId: r.pet_id,
    petPublicToken: r.public_token,
    petName: r.name,
    ownershipId: r.ownership_id,
    organizationId: r.organization_id,
  }));
}

async function queryOpenRequests(petTokens?: readonly string[]): Promise<OpenRequest[]> {
  const rows = await db
    .select({ caseId: cases.id, publicCode: cases.publicCode, petPublicToken: pets.publicToken })
    .from(cases)
    .leftJoin(pets, eq(pets.id, cases.primaryPetId))
    .where(
      and(
        eq(cases.caseKind, "rehome_request"),
        inArray(cases.status, ["open", "escalated"]),
        petTokens && petTokens.length > 0 ? inArray(pets.publicToken, [...petTokens]) : undefined,
      ),
    )
    .orderBy(cases.openedAt);
  return rows;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const PLATFORM_LISTING_NOTE =
  "La plataforma dio de baja el acompañamiento de adopción (rollback de la funcionalidad). El animal sigue con su familia; la publicación se retiró de la búsqueda de hogar.";
const PLATFORM_APPLICATION_NOTE =
  "La plataforma dio de baja el acompañamiento de adopción (rollback de la funcionalidad). Esta postulación quedó cerrada; no hace falta hacer nada.";
const PLATFORM_REQUEST_NOTE =
  "La plataforma cerró la solicitud de nuevo hogar (rollback de la funcionalidad). No se creó ninguna publicación.";

async function closeCancelledByPlatform(
  caseId: string,
  note: string,
  now: Date,
  tx: Tx,
): Promise<boolean> {
  const { won } = await closeCaseOwned({ caseId, reason: "cancelled", closedByUserId: null }, tx);
  if (!won) return false;
  await tx.insert(caseEvents).values({
    caseId,
    entryType: "case_closed",
    notes: note,
    recordedByUserId: null,
    occurredAt: now,
    payload: { cause: "platform_rollback" },
  });
  return true;
}

async function endOne(
  live: LiveSponsorship,
  now: Date,
): Promise<{ ended: EndedSponsorship | null; skipped: string | null }> {
  return db.transaction(async (tx) => {
    await RehomeRepository.acquirePetAdvisoryLock(live.petId, tx);

    // Re-read under the lock: the plan was a snapshot.
    const open = await findOpenSponsorship(live.petId, tx);
    if (!open || open.ownershipId !== live.ownershipId) {
      return { ended: null, skipped: "the sponsorship ended between plan and apply" };
    }
    const { ended } = await RehomeRepository.endCustodyRow(open.ownershipId, now, tx);
    if (!ended) {
      // Closed by someone else since the plan, without its event: an orphan
      // now, and orphans are not ours to end. The next run lists it.
      return {
        ended: null,
        skipped: "the custody row closed between plan and apply — now an orphan",
      };
    }

    await RehomeRepository.unpublishListing({ petId: live.petId, now }, tx);

    await endRehomeSponsorship(
      {
        petId: live.petId,
        outcome: "withdrawn_by_platform",
        recordedByUserId: null,
        authorRole: "system",
        authorOrganizationId: null,
        authorVerified: false,
        now,
      },
      tx,
    );

    const listing = await findOpenAdoptionListingCase(
      live.petId,
      open.sponsoringOrganizationId,
      tx,
    );
    if (listing) await closeCancelledByPlatform(listing.id, PLATFORM_LISTING_NOTE, now, tx);

    let applicationsClosed = 0;
    const stranded = await RehomeRepository.findApplicationsOnListing(live.petId, tx);
    for (const application of stranded) {
      const appCase = await findOpenAdoptionApplicationCase(
        live.petId,
        application.applicantUserId,
        tx,
      );
      if (
        appCase &&
        (await closeCancelledByPlatform(appCase.id, PLATFORM_APPLICATION_NOTE, now, tx))
      ) {
        applicationsClosed += 1;
      }
    }

    return {
      ended: {
        petPublicToken: live.petPublicToken,
        ownershipId: open.ownershipId,
        listingCasePublicCode: listing?.publicCode ?? null,
        applicationsClosed,
      },
      skipped: null,
    };
  });
}

async function closeRequest(request: OpenRequest, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, request.caseId))
      .for("update");
    if (!row || row.status === "closed" || row.status === "merged") return false;
    return closeCancelledByPlatform(request.caseId, PLATFORM_REQUEST_NOTE, now, tx);
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function describeOrphan(o: OrphanSponsorshipRow): string {
  return `SKIPPED (orphan) ${o.public_token}: rehome_sponsorship_started names custody row ${o.ownership_id} (${o.row_state}) and no rehome_sponsorship_ended matches it — heal it the way lint:spine says, never here.`;
}

async function processLive(
  report: RollbackReport,
  opts: RollbackOptions,
  log: (line: string) => void,
  now: () => Date,
): Promise<void> {
  for (const live of report.live) {
    if (!opts.apply) {
      log(
        `WOULD END ${live.petPublicToken} ("${live.petName}"): close custody ${live.ownershipId} (org ${live.organizationId}), clear the listing, write rehome_sponsorship_ended{withdrawn_by_platform}, close the adoption_listing case and its applications.`,
      );
      continue;
    }
    try {
      const { ended, skipped } = await endOne(live, now());
      if (ended) {
        report.ended.push(ended);
        log(
          `ENDED ${ended.petPublicToken}: custody ${ended.ownershipId} closed; rehome_sponsorship_ended{withdrawn_by_platform} written; listing case ${ended.listingCasePublicCode ?? "none"}; ${ended.applicationsClosed} application case(s) closed.`,
        );
      } else {
        log(`SKIPPED ${live.petPublicToken}: ${skipped}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${live.petPublicToken}: ${message}`);
      log(`ERROR ${live.petPublicToken}: ${message}`);
    }
  }
}

async function processRequests(
  report: RollbackReport,
  opts: RollbackOptions,
  log: (line: string) => void,
  now: () => Date,
): Promise<void> {
  for (const request of report.openRequests) {
    const where = request.petPublicToken ?? "no pet";
    if (!opts.apply) {
      log(`WOULD CLOSE REQUEST ${request.publicCode} (${where}) as cancelled.`);
      continue;
    }
    try {
      if (await closeRequest(request, now())) {
        report.closedRequests.push(request);
        log(`CLOSED REQUEST ${request.publicCode} (${where}) as cancelled.`);
      } else {
        log(`SKIPPED REQUEST ${request.publicCode}: already closed.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${request.publicCode}: ${message}`);
      log(`ERROR REQUEST ${request.publicCode}: ${message}`);
    }
  }
}

function summary(report: RollbackReport, apply: boolean): string {
  const endedPart = apply ? `, ${report.ended.length} ended` : "";
  const closedPart = apply ? `, ${report.closedRequests.length} closed` : "";
  return `Summary (${report.mode}): ${report.live.length} live sponsorship(s)${endedPart}; ${report.openRequests.length} open request(s)${closedPart}; ${report.orphans.length} orphan(s) skipped; ${report.errors.length} error(s).`;
}

/**
 * A WRITER names its database explicitly. The read-only fences fall back to
 * the local stack when DATABASE_URL is unset; this script does not — `db`
 * itself refuses without it, and a rollback must never run against a target
 * nobody typed.
 */
export function requireDatabaseUrl(): string {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      `DATABASE_URL is not set. This script WRITES to the database it names — set it explicitly (local stack: ${DEFAULT_LOCAL_URL}).`,
    );
  }
  return rawUrl;
}

export async function runRollback(opts: RollbackOptions): Promise<RollbackReport> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  const rawUrl = requireDatabaseUrl();
  const target = describeTarget(rawUrl);
  const report: RollbackReport = {
    mode: opts.apply ? "apply" : "dry-run",
    target: target.label,
    live: [],
    orphans: [],
    openRequests: [],
    ended: [],
    closedRequests: [],
    errors: [],
  };

  log(`rollback-rehome-sponsorships — ${report.mode} — database: ${target.label}`);

  // The plan: orphans through lint:spine's own query, the work through the
  // spine + live-row join, the unanswered requests through the cases table.
  const ownClient = opts.sqlClient ?? postgres(rawUrl, { max: 1, connect_timeout: 5 });
  try {
    const tokenSet = opts.petTokens ? new Set(opts.petTokens) : null;
    report.orphans = (await queryOrphanedSponsorships(ownClient)).filter(
      (o) => tokenSet === null || tokenSet.has(o.public_token),
    );
    report.live = await queryLiveSponsorships(opts.petTokens);
    report.openRequests = await queryOpenRequests(opts.petTokens);
  } finally {
    if (!opts.sqlClient) await ownClient.end({ timeout: 1 }).catch(() => {});
  }

  for (const o of report.orphans) log(describeOrphan(o));
  await processLive(report, opts, log, now);
  await processRequests(report, opts, log, now);

  log(summary(report, opts.apply));
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Args = { apply: boolean; petTokens: string[]; allowRemote: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, petTokens: [], allowRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--allow-remote") args.allowRemote = true;
    else if (a === "--pet") {
      const token = argv[++i];
      if (!token) throw new Error("--pet needs a public token");
      args.petTokens.push(token);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = describeTarget(requireDatabaseUrl());
  if (!isLocalWriterTarget(target) && !args.allowRemote) {
    console.error(
      `✗ DATABASE_URL does not point at the local Supabase CLI stack (${target.label}). This script WRITES: only localhost / 127.0.0.1 / ::1 on port 54322 runs without a flag. Re-run with --allow-remote if that is the database you mean.`,
    );
    process.exit(1);
  }
  const report = await runRollback({
    apply: args.apply,
    petTokens: args.petTokens.length > 0 ? args.petTokens : undefined,
  });
  process.exit(report.errors.length > 0 ? 2 : 0);
}

// Only run as a CLI when invoked directly; the db test imports runRollback.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("rollback-rehome-sponsorships.ts") ||
    process.argv[1].endsWith("rollback-rehome-sponsorships.js"));

if (isMain) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("DATABASE_URL is not set")) {
      console.error(`✗ ${message}`);
      process.exit(1);
    }
    console.error("rollback-rehome-sponsorships crashed:", err);
    process.exit(2);
  });
}
