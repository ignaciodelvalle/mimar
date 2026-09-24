import "server-only";

// Daily operator digest (T2-N1) — recipient resolution + send.
//
// SCOPE, STATED PLAINLY. "Pending items" here means the SAME queues an
// operator already sees badged on their own landing:
//   - govt/national: countVisiblePendingRequests (lib/infra/approval-scope.ts)
//     — the /gob "Aprobaciones" queue (vet role-upgrade + org-verification
//     requests visible in the govt's own jurisdiction). This is deliberately
//     NARROWER than the full /gob home briefing (which also bundles denuncias
//     de maltrato, casos abiertos, etc.) — a scope call for this S–M item: one
//     well-scoped, already-tested counter beats re-deriving five more.
//   - org members (incl. vet_individual, who hold membership in their own
//     solo-clinic org): applicableOrgQueues + fetchOrgQueueCounts
//     (lib/analytics/org-dashboard.ts) — the SAME catalog and counters the org
//     panel and its nav badges use. Only queues with a `navPath` (the ones the
//     panel actually BADGES as needing a decision) count toward the digest —
//     `activeFosters` has none on purpose (informational, not actionable) and
//     must not inflate a "you have pending work" mail with a non-actionable
//     count.
//
// ONE MAIL PER PERSON (security review 2026-09-18, L3). A govt operator who is
// also an org member used to get two mails the same morning, each claiming the
// same idempotency slot — so the second one was silently dropped as "already
// sent today". Recipients are now merged by userId before anything is sent:
// one mail, one section per panel.
//
// Admin is OUT OF SCOPE. Admin has universal, not jurisdiction-scoped, read —
// there is no single "this admin's queue" the way there is for a govt or an
// org member, and building one is a different, larger question than this
// item's S–M size. Noted for the PO, not silently dropped.
//
// RECIPIENT FILTER, every branch: profiles.deactivatedAt IS NULL AND
// profiles.deletedAt IS NULL AND profiles.dailyDigestOptOut = false. A
// deactivated or erased account never receives mail regardless of its queue
// counts — matches requireLiveUser's own precedence (erasure/deactivation
// refuse before anything else runs).
//
// THE BUDGET (security review 2026-09-18, M2). This job runs inside the daily
// dispatcher's shared 55 s (60 s hard kill) and used to ignore it: an N+1
// resolution pass, a full `listUsers` paging of auth.users and sequential
// Resend calls, with no clock at all. Now:
//   - it honours DIGEST_MAX_DURATION_MS and, under the dispatcher, the share
//     handed down in x-cron-budget-ms (the route passes
//     effectiveDeadlineMs(...)); CRON_JOB_CEILINGS declares it;
//   - recipients are processed ONE AT A TIME — resolve that person's counts,
//     look up that person's email (auth.admin.getUserById, not a scan of every
//     auth user), compose, claim, send — and the deadline is checked before a
//     recipient is started and again right before the claim. Out of time means
//     STOP: every recipient not reached is reported in `deferredByDeadline` and
//     goes out on the next run;
//   - recipients are ordered by dailyDigestLastSentOn, oldest (and never) first,
//     so a run that keeps getting cut short still rotates through everyone
//     instead of mailing the same head of the list every day.
//
// IDEMPOTENCY — CLAIM RIGHT BEFORE THE SEND, RELEASE ON FAILURE. The claim is a
// compare-and-swap on profiles.dailyDigestLastSentOn (see migration 0230's
// header for why the row lock makes a conditional UPDATE safe under a retried
// or duplicate dispatcher pass). It is taken immediately before the Resend call
// — after the counts, the email lookup and the composition — so no recipient
// is ever left claimed-but-unsent by a deadline or a lookup failure. If the
// send itself fails (Resend returns an error or throws), the claim is released
// back to its previous value so a retry the same day can send again. The one
// window left is a process kill between claim and send, which the deadline
// makes a budget question rather than a routine one.
//
// NEVER CRASHES THE CRON. Every recipient is processed in its own try/catch;
// one bad row (a DB error building an org's counts, a Resend throw) is logged
// and the run continues to the next candidate — the withCronRun caller
// reports partial failure via the returned counts, never via an uncaught
// throw. Unconfigured mail (`deriveOutboundChannels` not "configured") short-
// circuits the WHOLE run before any candidate is touched or claimed, so a
// misconfigured environment never claims a send it cannot make.

import { Resend } from "resend";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, govtAssignments, organizationMemberships, organizations, profiles } from "@/db";
import {
  type OrgQueueKey,
  applicableOrgQueues,
  fetchOrgQueueCounts,
} from "@/lib/analytics/org-dashboard";
import {
  type ComposeDigestInput,
  type DigestQueueItem,
  type DigestSection,
  composeDigestEmail,
} from "@/lib/digest/daily-operator-digest-composer";
import type { GobReadRole } from "@/lib/domain/jurisdiction-canonical";
import { countVisiblePendingRequests } from "@/lib/infra/approval-scope";
import { generateDigestUnsubscribeToken } from "@/lib/infra/digest-unsubscribe-token";
import { deriveOutboundChannels, resolveMailSender } from "@/lib/infra/outbound-channels";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
// Type-only: the module itself is imported lazily inside the run (see there).
import type * as AuthzResolver from "@/src/modules/organizations/infrastructure/authz-resolver";

/**
 * The job's own wall-clock ceiling. Under the dispatcher the route narrows it
 * to the share handed down (effectiveDeadlineMs); standalone it is all there
 * is. Declared in CRON_JOB_CEILINGS (lib/infra/cron-dispatcher.ts).
 */
export const DIGEST_MAX_DURATION_MS = 30_000;

/** Argentina calendar day (fixed -03:00, no DST) — the idempotency day, never UTC. */
export function arCalendarDay(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
}

export type DailyOperatorDigestResult = {
  candidates: number;
  sent: number;
  alreadySentToday: number;
  skippedNoEmail: number;
  /** Recipients not reached because the deadline hit — they go out next run. */
  deferredByDeadline: number;
  errors: number;
  mailChannel: "configured" | "restricted" | "unconfigured" | "not-built";
};

export type DailyOperatorDigestOptions = {
  /** Wall-clock budget for the whole run, ms. Default DIGEST_MAX_DURATION_MS. */
  budgetMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
};

type Membership = {
  membershipId: string;
  membershipRole: (typeof organizationMemberships.$inferSelect)["role"];
  orgId: string;
  orgType: string;
  orgPublicToken: string;
};

type Recipient = {
  userId: string;
  lastSentOn: string | null;
  isGovt: boolean;
  memberships: Membership[];
};

/**
 * Everyone who MAY get a digest today, merged by userId and ordered oldest-
 * sent first. Two queries plus one for jurisdictions — no per-recipient work
 * happens here, so this part does not grow with the queue sizes.
 */
async function loadRecipients(): Promise<{
  recipients: Recipient[];
  jurisdictionsByGovt: Map<string, { province: string; locality: string }[]>;
}> {
  const liveAndSubscribed = [
    isNull(profiles.deactivatedAt),
    isNull(profiles.deletedAt),
    eq(profiles.dailyDigestOptOut, false),
  ];

  const govts = await db
    .select({ id: profiles.id, lastSentOn: profiles.dailyDigestLastSentOn })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "govt"),
        eq(profiles.accountType, "institutional"),
        ...liveAndSubscribed,
      ),
    );

  const memberships = await db
    .select({
      membershipId: organizationMemberships.id,
      membershipRole: organizationMemberships.role,
      userId: organizationMemberships.userId,
      lastSentOn: profiles.dailyDigestLastSentOn,
      orgId: organizations.id,
      orgType: organizations.orgType,
      orgPublicToken: organizations.publicToken,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .innerJoin(profiles, eq(profiles.id, organizationMemberships.userId))
    .where(
      and(
        isNull(organizationMemberships.leftAt),
        eq(organizations.status, "active"),
        ...liveAndSubscribed,
      ),
    );

  const byUser = new Map<string, Recipient>();
  const recipientFor = (userId: string, lastSentOn: string | null): Recipient => {
    let r = byUser.get(userId);
    if (!r) {
      r = { userId, lastSentOn, isGovt: false, memberships: [] };
      byUser.set(userId, r);
    }
    return r;
  };
  for (const g of govts) recipientFor(g.id, g.lastSentOn).isGovt = true;
  for (const m of memberships) {
    recipientFor(m.userId, m.lastSentOn).memberships.push({
      membershipId: m.membershipId,
      membershipRole: m.membershipRole,
      orgId: m.orgId,
      orgType: m.orgType,
      orgPublicToken: m.orgPublicToken,
    });
  }

  const jurisdictionsByGovt = new Map<string, { province: string; locality: string }[]>();
  const govtIds = govts.map((g) => g.id);
  if (govtIds.length > 0) {
    const rows = await db
      .select({
        userId: govtAssignments.userId,
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(inArray(govtAssignments.userId, govtIds), isNull(govtAssignments.revokedAt)));
    for (const row of rows) {
      const list = jurisdictionsByGovt.get(row.userId) ?? [];
      list.push({ province: row.province, locality: row.locality });
      jurisdictionsByGovt.set(row.userId, list);
    }
  }

  // Never-sent first, then oldest send, then a stable tiebreak.
  const recipients = [...byUser.values()].sort((a, b) => {
    const la = a.lastSentOn ?? "";
    const lb = b.lastSentOn ?? "";
    if (la !== lb) return la < lb ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return { recipients, jurisdictionsByGovt };
}

type GrantedCapabilitiesFn = typeof AuthzResolver.getGrantedCapabilities;

/** This one person's sections: government first, then every org they belong to. */
async function sectionsFor(
  recipient: Recipient,
  jurisdictions: { province: string; locality: string }[],
  siteUrl: string,
  getGrantedCapabilities: GrantedCapabilitiesFn,
  orgCountsCache: Map<string, Promise<Record<OrgQueueKey, number | null>>>,
): Promise<DigestSection[]> {
  const sections: DigestSection[] = [];

  if (recipient.isGovt) {
    const count = await countVisiblePendingRequests(
      { id: recipient.userId, role: "govt" as GobReadRole },
      jurisdictions,
    );
    if (count > 0) {
      sections.push({
        recipientLabel: "gobierno",
        items: [{ label: "Aprobaciones pendientes", count, href: `${siteUrl}/gob/cola` }],
      });
    }
  }

  const orgItems: DigestQueueItem[] = [];
  for (const m of recipient.memberships) {
    const granted = await getGrantedCapabilities({ id: m.membershipId, role: m.membershipRole });
    const queues = applicableOrgQueues(m.orgType, granted, m.membershipRole).filter(
      (q) => q.navPath !== undefined,
    );
    if (queues.length === 0) continue;

    const keys: OrgQueueKey[] = queues.map((q) => q.key);
    // Two members of one org with the same capabilities ask the same question:
    // count it once per run.
    const cacheKey = `${m.orgId}|${[...keys].sort().join(",")}`;
    let countsPromise = orgCountsCache.get(cacheKey);
    if (!countsPromise) {
      countsPromise = fetchOrgQueueCounts(m.orgId, keys);
      orgCountsCache.set(cacheKey, countsPromise);
    }
    const counts = await countsPromise;

    for (const q of queues) {
      const n = counts[q.key];
      if (!n || n <= 0) continue;
      orgItems.push({
        label: q.label,
        count: n,
        href: `${siteUrl}/org/${m.orgPublicToken}/${q.path}`,
      });
    }
  }
  if (orgItems.length > 0) sections.push({ recipientLabel: "organización", items: orgItems });

  return sections;
}

/** The recipient's login email, by id — one targeted lookup, never a scan. */
async function lookupEmail(userId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error) throw error;
  return data?.user?.email || null;
}

type Claim = { claimed: true; previous: string | null } | { claimed: false };

/**
 * Claims today's send for `userId` — a compare-and-swap on the watermark.
 * Returns the PREVIOUS value when this call won, so a failed send can put it
 * back; `claimed: false` when the user already got today's digest.
 */
async function claimDigestSend(userId: string, today: string): Promise<Claim> {
  const [row] = await db
    .select({ previous: profiles.dailyDigestLastSentOn })
    .from(profiles)
    .where(eq(profiles.id, userId));
  if (!row || row.previous === today) return { claimed: false };

  const updated = await db
    .update(profiles)
    .set({ dailyDigestLastSentOn: today })
    .where(
      and(
        eq(profiles.id, userId),
        row.previous === null
          ? isNull(profiles.dailyDigestLastSentOn)
          : eq(profiles.dailyDigestLastSentOn, row.previous),
        sql`${profiles.dailyDigestLastSentOn} IS DISTINCT FROM ${today}`,
      ),
    )
    .returning({ id: profiles.id });
  return updated.length > 0 ? { claimed: true, previous: row.previous } : { claimed: false };
}

/** Undo a claim whose send failed, so a retry today can send again. */
async function releaseDigestClaim(
  userId: string,
  today: string,
  previous: string | null,
): Promise<void> {
  try {
    await db
      .update(profiles)
      .set({ dailyDigestLastSentOn: previous })
      .where(and(eq(profiles.id, userId), eq(profiles.dailyDigestLastSentOn, today)));
  } catch (err) {
    // Logged, not rethrown: the worst case is the pre-fix behaviour (no retry
    // until tomorrow), never a crashed cron.
    console.error("[daily-operator-digest] failed releasing the claim for", userId, err);
  }
}

export async function runDailyOperatorDigest(
  options: DailyOperatorDigestOptions = {},
): Promise<DailyOperatorDigestResult> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DIGEST_MAX_DURATION_MS);
  const outOfTime = () => now() >= deadline;

  const env = process.env;
  const channels = deriveOutboundChannels(env);
  const emailChannel = channels.find((c) => c.key === "email");
  const mailChannel = emailChannel?.status ?? "unconfigured";

  const result: DailyOperatorDigestResult = {
    candidates: 0,
    sent: 0,
    alreadySentToday: 0,
    skippedNoEmail: 0,
    deferredByDeadline: 0,
    errors: 0,
    mailChannel,
  };

  // Fail closed to a logged skip, never a crash — the whole run short-
  // circuits before touching any recipient or claiming any send.
  if (mailChannel !== "configured") {
    console.warn(
      `[daily-operator-digest] mail channel is "${mailChannel}" — skipping this run entirely.`,
    );
    return result;
  }

  const siteUrl = resolveSiteUrl();
  const today = arCalendarDay();

  let loaded: Awaited<ReturnType<typeof loadRecipients>>;
  let getGrantedCapabilities: GrantedCapabilitiesFn;
  try {
    loaded = await loadRecipients();
    // Import lazily to avoid pulling the whole authz-resolver module graph into
    // every caller of this file (it is Drizzle-heavy and org-scoped).
    ({ getGrantedCapabilities } = await import(
      "@/src/modules/organizations/infrastructure/authz-resolver"
    ));
  } catch (err) {
    console.error("[daily-operator-digest] failed resolving recipients:", err);
    result.errors += 1;
    return result;
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const from = resolveMailSender(env);
  const orgCountsCache = new Map<string, Promise<Record<OrgQueueKey, number | null>>>();
  const { recipients, jurisdictionsByGovt } = loaded;

  for (const [index, recipient] of recipients.entries()) {
    if (outOfTime()) {
      result.deferredByDeadline += recipients.length - index;
      break;
    }

    let claim: Claim = { claimed: false };
    try {
      const sections = await sectionsFor(
        recipient,
        jurisdictionsByGovt.get(recipient.userId) ?? [],
        siteUrl,
        getGrantedCapabilities,
        orgCountsCache,
      );
      if (sections.length === 0) continue;
      result.candidates += 1;

      const email = await lookupEmail(recipient.userId);
      if (!email) {
        result.skippedNoEmail += 1;
        continue;
      }

      const unsubscribeUrl = `${siteUrl}/api/digest/unsubscribe?u=${recipient.userId}&t=${generateDigestUnsubscribeToken(recipient.userId)}`;
      const input: ComposeDigestInput = {
        sections,
        unsubscribeUrl,
        accountUrl: `${siteUrl}/cuenta`,
      };
      const { subject, html, text } = composeDigestEmail(input);

      // The last point where stopping costs nothing: nothing is claimed yet.
      if (outOfTime()) {
        result.deferredByDeadline += recipients.length - index;
        break;
      }

      claim = await claimDigestSend(recipient.userId, today);
      if (!claim.claimed) {
        result.alreadySentToday += 1;
        continue;
      }

      const { error } = await resend.emails.send({
        from,
        to: email,
        subject,
        html,
        text,
        // RFC 2369 + RFC 8058: the mail client's own "unsubscribe" button,
        // one-click. The POST lands on the same route, which flips directly.
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (error) {
        console.warn("[daily-operator-digest] Resend error for", recipient.userId, error);
        await releaseDigestClaim(recipient.userId, today, claim.previous);
        result.errors += 1;
        continue;
      }
      result.sent += 1;
    } catch (err) {
      console.error("[daily-operator-digest] failed sending to", recipient.userId, err);
      if (claim.claimed) await releaseDigestClaim(recipient.userId, today, claim.previous);
      result.errors += 1;
    }
  }

  return result;
}
