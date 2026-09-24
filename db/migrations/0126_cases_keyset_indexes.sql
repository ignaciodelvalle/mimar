-- 0126 — composite keyset indexes for the case queue lists
-- (pre-province perf pass 2026-07-05, extends perf/scale review 2026-07-04
-- "case/event lists" + "jurisdiction-scoped govt reads").
--
-- WHY
-- ---
-- Both case-queue surfaces already paginate with keyset (PERF-5) —
-- ORDER BY (opened_at DESC, id DESC) with a (opened_at, id) < cursor
-- predicate (lib/infra/case-queries.ts) — but NO index backs that sort:
--
--   * listCasesForGovt  (/gob/casos): WHERE (jurisdiction_province,
--     jurisdiction_locality) IN (<assigned pairs>) [+ closed_at status]
--     ORDER BY opened_at DESC, id DESC. The only jurisdiction index on
--     cases is cases_open_by_jurisdiction_kind_idx — (jurisdiction_locality,
--     case_kind) PARTIAL on status IN ('open','escalated'). It leads with
--     locality (not province), is partial (the queue shows all statuses),
--     and does not order by opened_at. So the govt queue filters then
--     sorts, which at province scale is a scan + top-N sort per render.
--
--   * listCasesForAdmin (/admin/casos): unscoped, same keyset sort. With no
--     leading opened_at index the planner sequential-scans cases and sorts
--     the whole table for every page — the exact pattern migration 0110
--     fixed for audit_log's default (performed_at DESC, id DESC) sort.
--
-- FIX
-- ---
-- Two btree composites matching the keyset column pair (DESC to line up with
-- the ORDER BY so the scan needs no separate sort step):
--
--   1. (jurisdiction_province, jurisdiction_locality, opened_at DESC, id DESC)
--      — the govt queue seeks to its jurisdiction group then range-scans the
--        keyset window. A single-jurisdiction pilot is one equality group;
--        a multi-locality province operator becomes a BitmapOr of tight
--        ranges instead of a full sort.
--
--   2. (opened_at DESC, id DESC)
--      — the admin queue's unscoped keyset scan becomes a bounded index range.
--
-- These are additive, forward-only, and idempotent. No index is dropped
-- (dropping cases_open_by_jurisdiction_kind_idx is a separate, Ignacio-gated
-- call — it still uniquely serves the open/escalated-by-locality+kind path).
--
-- IDEMPOTENCY
-- -----------
-- CREATE INDEX IF NOT EXISTS is safe to replay (same pattern as 0122/0118).
-- Plain (non-CONCURRENTLY) CREATE INDEX runs inside the runner's per-file
-- transaction — no -- dim:no-transaction marker needed.

CREATE INDEX IF NOT EXISTS cases_juris_opened_at_idx
  ON public.cases (jurisdiction_province, jurisdiction_locality, opened_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS cases_opened_at_id_idx
  ON public.cases (opened_at DESC, id DESC);
