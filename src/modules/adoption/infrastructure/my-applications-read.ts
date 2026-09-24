// "Mis postulaciones" — the applicant's own applications, for BOTH doors.
//
// WHY THIS IS A MODULE AND NOT A SECOND QUERY
// ---------------------------------------------------------------------------
// It was inlined in `app/(app)/mis-mascotas/postulaciones/page.tsx` — 100 lines
// of SQL with four CTEs, three LATERALs and a seven-branch CASE that DERIVES an
// application's status from later events. A bearer door that re-derived that
// status would be a second definition of what "aprobada" means, and the two
// would disagree the first time somebody added an outcome. This is the shape
// WU-R's `eraseSubjectDataFor` established: carve the reader out of the surface
// that had it, so the cookie door and the bearer door run the same steps.
//
// The extraction is deliberately LITERAL. The SQL is the page's SQL, the
// mapping is the page's mapping, the 100-row cap is the page's cap. Nothing was
// "improved" on the way out — an extraction that also changes behaviour is an
// extraction nobody can review.
//
// TWO THINGS IN HERE ARE RULES, NOT PLUMBING, AND MUST SURVIVE ANY REWRITE:
//
//   · `p.deleted_at IS NULL`. Art. 16 (Ley 25.326): a soft-deleted pet reads as
//     never registered. The applicant's `my_submissions` row and the
//     shelter_custody LATERAL both SURVIVE a rehome-R4 titular's erasure, so
//     without this the erased pet's name and a live `/adoptar` link would still
//     render to a third-party applicant. This is the fifth surface of that
//     class and the four before it each had to be found.
//   · D17. There is no column here for how many other people applied, who they
//     are, or where this application sits in a queue. The applicant sees THEIR
//     OWN row and the animal's public state, and nothing about the competition.
//
// THE `stillListed` FLAG IS THE LISTING PREDICATE, SPELLED A THIRD TIME, and
// that is a known duplication rather than an oversight: `queryAdoptionListing`
// builds it as Drizzle conditions, the ficha page builds it as a boolean over a
// row, and this query builds it in SQL over columns it already selected for the
// purpose. Design R5 names the predicate as duplicated in four places and asks
// that it not DRIFT; the mapping below is where this copy lives, next to the
// columns it reads, so a change is visible in one diff.

import { sql } from "drizzle-orm";

import { db } from "@/db";

/** The seven states, derived from the spine. `@dim/contract/api` mirrors this list. */
export type MyApplicationStatus =
  | "pending"
  | "info_requested"
  | "approved"
  | "finalized_to_me"
  | "auto_rejected"
  | "rejected"
  | "withdrawn";

export type MyApplicationRow = {
  applicationId: string;
  petPublicToken: string;
  petName: string;
  petCurrentStatus: string;
  orgDisplayName: string;
  orgPublicToken: string;
  submittedAt: Date;
  status: MyApplicationStatus;
  decisionAt: Date | null;
  stillListed: boolean;
};

/**
 * The page's own cap, kept as a named constant so the API can tell a client
 * whether it was reached. A hundred applications is far past any real person;
 * what the cap actually bounds is a runaway script's read.
 */
export const MY_APPLICATIONS_LIMIT = 100;

type RawRow = {
  application_id: string;
  pet_public_token: string;
  pet_name: string;
  pet_status: string;
  pet_listed_at: string | null;
  pet_listing_paused_at: string | null;
  pet_eligible: boolean | null;
  pet_in_dispute: boolean | null;
  pet_rabies_status: string;
  org_display_name: string;
  org_public_token: string;
  org_verified: boolean;
  org_type: string;
  submitted_at: string;
  status: MyApplicationStatus;
  decision_at: string | null;
};

/**
 * Every adoption application this user submitted, newest first, capped.
 *
 * A row whose animal has NO current shelter custodian is dropped — the org
 * LATERAL is a LEFT JOIN so the row survives the query, and the page has always
 * filtered it out afterwards. Keeping the filter here rather than turning the
 * LATERAL into an INNER JOIN preserves the extraction's literalness: an inner
 * join would also drop rows for a different reason (a race between the read and
 * a custody change) and this function is not the place to decide that.
 */
export async function readMyAdoptionApplications(userId: string): Promise<MyApplicationRow[]> {
  const rows = await db.execute<RawRow>(sql`
    WITH my_submissions AS (
      SELECT
        e.id,
        e.pet_id,
        e.recorded_at AS submitted_at
      FROM pet_events e
      WHERE e.event_type = 'adoption_application_submitted'
        AND e.payload->>'applicant_user_id' = ${userId}
    ),
    decisions AS (
      SELECT
        s.id AS application_id,
        d.payload->>'outcome' AS outcome,
        d.payload->>'auto_generated' AS auto_generated,
        d.recorded_at AS decision_at
      FROM my_submissions s
      JOIN pet_events d
        ON d.pet_id = s.pet_id
       AND d.event_type = 'adoption_application_resolved'
       AND d.payload->>'application_event_id' = s.id::text
    ),
    finalizations AS (
      SELECT
        s.id AS application_id,
        f.recorded_at AS finalized_at
      FROM my_submissions s
      JOIN pet_events f
        ON f.pet_id = s.pet_id
       AND f.event_type = 'adoption_finalized'
       AND f.payload->>'adopter_user_id' = ${userId}
    ),
    info_requests AS (
      -- Latest "more info requested" marker per application (UI-6). A
      -- note_added with kind=adoption_info_requested, emitted AFTER the
      -- application was submitted, signals the shelter probed for info.
      SELECT
        s.id AS application_id,
        MAX(n.recorded_at) AS requested_at
      FROM my_submissions s
      JOIN pet_events n
        ON n.pet_id = s.pet_id
       AND n.event_type = 'note_added'
       AND n.payload->>'kind' = 'adoption_info_requested'
       AND n.payload->>'application_event_id' = s.id::text
       AND n.recorded_at >= s.submitted_at
      GROUP BY s.id
    )
    SELECT
      s.id::text AS application_id,
      p.public_token AS pet_public_token,
      p.name AS pet_name,
      p.status AS pet_status,
      p.adoption_listed_at AS pet_listed_at,
      p.adoption_listing_paused_at AS pet_listing_paused_at,
      p.adoption_eligible AS pet_eligible,
      p.in_custody_dispute AS pet_in_dispute,
      p.rabies_observation_status AS pet_rabies_status,
      o.display_name AS org_display_name,
      o.public_token AS org_public_token,
      o.verified AS org_verified,
      o.org_type AS org_type,
      s.submitted_at::text AS submitted_at,
      CASE
        WHEN f.finalized_at IS NOT NULL THEN 'finalized_to_me'
        WHEN d.outcome = 'approved' THEN 'approved'
        WHEN d.outcome = 'withdrawn' THEN 'withdrawn'
        WHEN d.outcome = 'rejected'
          AND COALESCE(d.auto_generated, 'false') = 'true' THEN 'auto_rejected'
        WHEN d.outcome = 'rejected' THEN 'rejected'
        WHEN ir.requested_at IS NOT NULL THEN 'info_requested'
        ELSE 'pending'
      END AS status,
      COALESCE(f.finalized_at, d.decision_at)::text AS decision_at
    FROM my_submissions s
    JOIN pets p ON p.id = s.pet_id
      -- Art. 16 (Ley 25.326): a soft-deleted pet reads as never registered.
      -- See this module's header — the applicant's row survives the titular's
      -- erasure, so the guard has to be here rather than upstream.
      AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT o2.*
      FROM ownerships ow
      JOIN organizations o2 ON o2.id = ow.owner_organization_id
      WHERE ow.pet_id = s.pet_id
        AND ow.role = 'shelter_custody'
        AND ow.ended_at IS NULL
      ORDER BY ow.started_at DESC
      LIMIT 1
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM decisions
      WHERE application_id = s.id
      ORDER BY decision_at DESC
      LIMIT 1
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM finalizations
      WHERE application_id = s.id
      LIMIT 1
    ) f ON TRUE
    LEFT JOIN info_requests ir ON ir.application_id = s.id
    ORDER BY s.submitted_at DESC
    LIMIT ${MY_APPLICATIONS_LIMIT}
  `);

  return rows
    .filter((r) => r.org_display_name !== null)
    .map((r) => ({
      applicationId: r.application_id,
      petPublicToken: r.pet_public_token,
      petName: r.pet_name,
      petCurrentStatus: r.pet_status,
      orgDisplayName: r.org_display_name,
      orgPublicToken: r.org_public_token,
      submittedAt: new Date(r.submitted_at),
      decisionAt: r.decision_at ? new Date(r.decision_at) : null,
      status: r.status,
      stillListed:
        r.pet_listed_at !== null &&
        r.pet_listing_paused_at === null &&
        r.pet_status !== "lost" &&
        r.pet_status !== "deceased" &&
        r.pet_eligible === true &&
        r.pet_in_dispute !== true &&
        r.pet_rabies_status !== "in_progress" &&
        r.org_verified === true &&
        (r.org_type === "shelter" || r.org_type === "rescue_network"),
    }));
}
