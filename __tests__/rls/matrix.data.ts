// Matrix specification: role × table × operation → expected outcome.
//
// Source of truth for the RLS contract. Edited by hand when a new role,
// table, or operation joins the contract; consumed by `matrix.test.ts`
// as the assertion oracle.
//
// **Why TS and not YAML** (the §4.4 doctrine asked for YAML): a plain TS
// const buys us type-safety, autocomplete, and avoids adding `js-yaml` as
// a runtime dep just for one file. Conversion to `db/rls-matrix.yaml`
// later is mechanical if a non-developer needs to edit it.
//
// **Expected outcomes:**
//   - `allow`  — the operation surfaces rows / mutates state successfully.
//   - `deny`   — RLS blocks the operation (zero rows returned for SELECT,
//                zero rows inserted/updated/deleted for the others, OR
//                PostgREST returns a 42501-style error).
//   - `n/a`    — the combination is structurally impossible (e.g. INSERT
//                into a system-managed table where no policy permits any
//                authenticated write — currently marked deny instead).
//
// **Roles (resolved at test-time):**
//   - `anon`        — no signed-in session. The public surface.
//   - `owner`       — `owner@dim.test` (the seed's pet owner).
//   - `other_user`  — `vet@dim.test` (a different signed-in account that
//                     does NOT own the fixture pet). NOT an unrelated account:
//                     the seed makes it a member of "Refugio Test", so it
//                     legitimately reads cases that org opened (see the
//                     `cases` cell and the org-member block in matrix.test.ts).
//   - `admin`       — `admin@dim.test` (universal-scope role).
//
// **Fixture resource (the target of every cross-role probe):**
//   - The first pet owned by `owner@dim.test`, plus any pet_events /
//     ownerships / notifications tied to it.

export type RlsRole = "anon" | "owner" | "other_user" | "admin";
export type RlsOperation = "select" | "insert" | "update" | "delete";
export type RlsOutcome = "allow" | "deny";

export interface RlsCell {
  outcome: RlsOutcome;
  /** Free-form note explaining WHY this cell has its expected outcome. */
  reason?: string;
}

export type RlsTableMatrix = {
  [Role in RlsRole]: {
    [Op in RlsOperation]: RlsCell;
  };
};

export type RlsMatrix = Record<string, RlsTableMatrix>;

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const deny = (reason: string): RlsCell => ({ outcome: "deny", reason });
const allow = (reason: string): RlsCell => ({ outcome: "allow", reason });

export const RLS_MATRIX: RlsMatrix = {
  pets: {
    anon: {
      select: deny("anon has no session — no read policy matches"),
      insert: deny("anon cannot insert pets"),
      update: deny("anon cannot mutate"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      select: allow("owner can read own pets via ownerships join"),
      insert: deny("owner inserts pets only via server action (Drizzle bypasses RLS)"),
      update: deny(
        "owner edits go through server actions (Drizzle) — PostgREST UPDATE dropped and revoked in 0236 (the policy scoped rows, not columns: status, rabies observation, custody flag and the public token were all owner-writable)",
      ),
      delete: deny("pets are never deleted from PostgREST"),
    },
    other_user: {
      select: deny("non-owner without org membership sees zero rows"),
      insert: deny("only the server action path can insert pets"),
      update: deny("non-owner cannot mutate other-user pets"),
      delete: deny("non-owner cannot delete"),
    },
    admin: {
      // PostgREST policies do NOT grant admin universal read on pets.
      // Admin access is exercised via /admin routes that use Drizzle
      // (service role), which bypasses RLS. So through supabase-js, admin
      // looks like any authenticated user without ownership.
      select: deny("admin universal scope is enforced in app code, not RLS"),
      insert: deny("admin uses server actions, not PostgREST direct insert"),
      update: deny("admin uses server actions, not PostgREST direct update"),
      delete: deny("admin uses server actions, not PostgREST direct delete"),
    },
  },

  pet_events: {
    anon: {
      select: deny("event log is private"),
      insert: deny("anon cannot append events"),
      update: deny("events are append-only — no UPDATE for anyone"),
      delete: deny("events are append-only — no DELETE for anyone"),
    },
    owner: {
      select: allow("owner sees events for own pets"),
      // This cell said "only via server action" while a PostgREST INSERT policy
      // (0086, narrowed by 0190) was live — the intent was right and the
      // database disagreed, and nothing compared the two because
      // OPERATIONS_UNDER_TEST was ["select"] (A02-5). Migration 0212 made the
      // database agree: no INSERT policy at all.
      insert: deny(
        "owners insert events only via server action — PostgREST INSERT dropped in 0212 (author_role/author_verified were forgeable, permanently, in the append-only spine)",
      ),
      update: deny("append-only invariant: even own events are immutable via PostgREST"),
      delete: deny("append-only invariant: even own events cannot be deleted"),
    },
    other_user: {
      select: deny("non-owner cannot read pet events"),
      insert: deny("only server actions append events"),
      update: deny("append-only"),
      delete: deny("append-only"),
    },
    admin: {
      select: deny("admin universal scope enforced in app code, not RLS"),
      insert: deny("admin uses server actions"),
      update: deny("append-only — admin too"),
      delete: deny("append-only — admin too"),
    },
  },

  ownerships: {
    anon: {
      select: deny("ownerships are private"),
      insert: deny("anon cannot seize a pet"),
      update: deny("anon cannot transfer custody"),
      delete: deny("anon cannot end ownership"),
    },
    owner: {
      select: allow("owner reads own ownership rows"),
      insert: deny("ownership transfers go through server actions"),
      update: deny("ownership mutations go through server actions"),
      delete: deny("ownership rows are never DELETEd — endedAt is set instead"),
    },
    other_user: {
      select: deny("non-owner cannot read other-user ownerships"),
      insert: deny("non-owner cannot create ownership over another user's pet"),
      update: deny("non-owner cannot mutate"),
      delete: deny("non-owner cannot delete"),
    },
    admin: {
      select: deny("admin via server actions; PostgREST sees no policy match"),
      insert: deny("admin via server actions"),
      update: deny("admin via server actions"),
      delete: deny("admin via server actions"),
    },
  },

  notifications: {
    anon: {
      select: deny("notifications are per-user private"),
      insert: deny("anon cannot seed notifications"),
      update: deny("anon cannot mutate"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      select: allow("user reads own notifications"),
      insert: deny("notifications are server-side fanout only"),
      update: allow("user can mark own notifications as read/archive"),
      delete: deny("notifications are retained, not deleted"),
    },
    other_user: {
      select: deny("cannot read another user's notifications"),
      insert: deny("cannot create notifications for another user"),
      update: deny("cannot mutate another user's notifications"),
      delete: deny("cannot delete"),
    },
    admin: {
      select: deny("admin uses server actions, not PostgREST"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("admin uses server actions"),
    },
  },

  profiles: {
    anon: {
      select: deny("profiles are private"),
      insert: deny("profiles are created via the handle_new_user trigger"),
      update: deny("anon cannot edit profiles"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      select: allow("user can read own profile"),
      insert: deny("profile created by trigger, not PostgREST"),
      update: deny(
        "profile writes go through Drizzle server actions only — PostgREST UPDATE dropped in 0211 (self-escalation of role/account_type)",
      ),
      delete: deny("profiles are retained (deactivated_at instead)"),
    },
    other_user: {
      select: deny("users cannot read other users' profiles"),
      insert: deny("no insert allowed"),
      update: deny("cannot edit other users' profiles"),
      delete: deny("cannot delete"),
    },
    admin: {
      select: deny("admin uses server actions to access profiles"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("admin uses server actions"),
    },
  },

  event_notification_outbox: {
    anon: {
      select: deny("outbox is system-only — no anon access"),
      insert: deny("outbox rows are inserted by server actions via service role"),
      update: deny("outbox mutations are drainer-only via service role"),
      delete: deny("outbox rows are retained for audit"),
    },
    owner: {
      select: deny("outbox is admin/system-only, not owner-accessible"),
      insert: deny("owners never insert outbox rows directly"),
      update: deny("owners never update outbox rows"),
      delete: deny("owners never delete outbox rows"),
    },
    other_user: {
      select: deny("outbox is not accessible to general users"),
      insert: deny("general users cannot insert outbox rows"),
      update: deny("general users cannot update outbox rows"),
      delete: deny("general users cannot delete outbox rows"),
    },
    admin: {
      // Admin reads outbox via service-role Drizzle (C.2 admin UI).
      // No PostgREST RLS policy grants admin access in v1.
      select: deny("admin reads outbox via service role, not PostgREST"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("admin uses server actions"),
    },
  },

  cases: {
    anon: {
      select: deny("cases are private"),
      insert: deny("anon cannot open cases"),
      update: deny("anon cannot mutate"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      // Owner CAN read cases for own pets (except welfare_denuncia, which
      // hides from the subject). Every `cases` cell probes the harness's own
      // bite_incident fixture on the owner's pet, by id.
      select: allow("subject-pet owner sees own cases via can_read_case"),
      insert: deny("cases are opened via server actions, not PostgREST"),
      update: deny("case mutations go through server actions"),
      delete: deny("cases are not deleted"),
    },
    other_user: {
      select: deny(
        "a bite_incident case on another owner's pet has no party but the owner, govt in scope and admin — the vet's Refugio Test membership reaches only adoption_listing/foster_placement cases that org opened",
      ),
      insert: deny("non-owner cannot open cases"),
      update: deny("non-owner cannot mutate"),
      delete: deny("non-owner cannot delete"),
    },
    admin: {
      // can_read_case() grants admin universal read. This is the ONE
      // table in the matrix where the admin role gets a true allow
      // through RLS (not via server-action bypass).
      select: allow("can_read_case() short-circuits to true for admin role"),
      insert: deny("admin opens cases via server actions"),
      update: deny("admin uses server actions"),
      delete: deny("cases are not deleted"),
    },
  },

  pet_achievement_views: {
    // Owner UX pulse rows. RLS: owner reads and writes own rows; the app's
    // writes go through markAchievementSeenAction via Drizzle (bypasses RLS).
    anon: {
      select: deny("anon has no session — no read policy matches"),
      insert: deny("anon cannot seed achievement views"),
      update: deny("anon cannot mutate"),
      delete: deny("no DELETE policy — write-once history"),
    },
    owner: {
      select: allow("owner reads own pulse rows via user_id = auth.uid() + ownerships join"),
      // These two cells said `deny` from the day they were written, and the
      // live catalog has said `allow` since 0046 created "achievement_views
      // insert by owner" / "... update by owner" on purpose (its header: the
      // defence-in-depth gate for any future direct write path). Nothing
      // compared the two until the write probes landed (A02-5, T3-F1). The
      // policy is the design and the row is the caller's own UX state, so the
      // CELL was wrong, not the database.
      insert: allow(
        "0046 'achievement_views insert by owner': own user_id on a pet with an active ownership",
      ),
      update: allow(
        "0046 'achievement_views update by owner': same predicate in USING and WITH CHECK",
      ),
      delete: deny("no DELETE policy — write-once history"),
    },
    other_user: {
      select: deny("owner-only isolation guarantee — other_user sees zero rows"),
      insert: deny("cannot seed another user's achievement views"),
      update: deny("cannot mutate another user's views"),
      delete: deny("no DELETE policy"),
    },
    admin: {
      select: deny("admin universal scope is enforced in app code, not RLS"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("no DELETE policy"),
    },
  },

  // ---------------------------------------------------------------------------
  // pet_identifications — microchip / ISO / tattoo PII (Ley 25.326).
  // SELECT: owner reads via ownerships join; admin reads all.
  // All writes go through server actions (BYPASSRLS) — no PostgREST writes.
  // Migration 0105 adds the permissive SELECT policies.
  // ---------------------------------------------------------------------------
  pet_identifications: {
    anon: {
      select: deny("anon has no session — no read policy matches"),
      insert: deny("anon cannot insert identifications"),
      update: deny("anon cannot mutate"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      select: allow("owner reads identifications for own pets via ownerships join"),
      insert: deny("inserts go through server actions (BYPASSRLS)"),
      update: deny("updates go through server actions (BYPASSRLS)"),
      delete: deny("deletes go through server actions (BYPASSRLS)"),
    },
    other_user: {
      select: deny("non-owner without org membership sees zero rows"),
      insert: deny("non-owner cannot write identifications"),
      update: deny("non-owner cannot mutate"),
      delete: deny("non-owner cannot delete"),
    },
    admin: {
      select: allow("admin reads all identifications via profiles.role = admin policy"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("admin uses server actions"),
    },
  },

  // ---------------------------------------------------------------------------
  // pet_transfers — transfer offers: sender email, owner ids, optional note (PII).
  // SELECT: sender (from_owner_id) and receiver (to_owner_id) read own rows;
  //         admin reads all.
  // All writes go through server actions (BYPASSRLS) — no PostgREST writes.
  // Migration 0105 adds the permissive SELECT policies.
  // ---------------------------------------------------------------------------
  pet_transfers: {
    anon: {
      select: deny("anon has no session — no read policy matches"),
      insert: deny("anon cannot initiate transfers"),
      update: deny("anon cannot mutate"),
      delete: deny("anon cannot delete"),
    },
    owner: {
      // These two cells used to say `deny`, with reasons that described an
      // EMPTY TABLE ("no fixture transfers seeded", "no fixture row") rather
      // than a policy. They passed only because pet_transfers happened to hold
      // zero rows; the moment seed-owner-demo's pending transfer existed the
      // harness reported `allow` and the matrix contradicted the policy its own
      // header comment documents. A cell that asserts an accident is not a
      // fitness check — corrected to match migration 0105.
      select: allow("sender reads own transfers — 'pet_transfers read by sender' (0105)"),
      insert: deny("inserts go through server actions (BYPASSRLS)"),
      update: deny("updates go through server actions (BYPASSRLS)"),
      delete: deny("deletes go through server actions (BYPASSRLS)"),
    },
    other_user: {
      // Genuinely deny, and not for lack of rows: no policy matches a user who
      // is neither from_owner_id nor to_owner_id. This is the isolation
      // assertion the table exists to make.
      select: deny("non-owner is neither sender nor receiver — no SELECT policy matches"),
      insert: deny("non-owner cannot initiate transfers for another user"),
      update: deny("non-owner cannot mutate"),
      delete: deny("non-owner cannot delete"),
    },
    admin: {
      select: allow("admin reads all transfers — 'pet_transfers read by admin' (0105)"),
      insert: deny("admin uses server actions"),
      update: deny("admin uses server actions"),
      delete: deny("admin uses server actions"),
    },
  },
};
