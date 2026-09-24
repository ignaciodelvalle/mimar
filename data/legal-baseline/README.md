# Legal baseline (jurisdiction-compliance WU2)

Versioned reference dataset of per-jurisdiction obligation tiers + legal
citations, applied to `govt_business_rules` by `scripts/seed-legal-baseline.ts`.

**⚠️ Row content is a legal-research deliverable.** Citations, authorities and
effective dates must be sourced and reviewed — never authored by an
implementer. See the header of `ar-v1.ts` for the open TODOs.

## Files

| File | What it is |
| --- | --- |
| `schema.ts` | Zod schema for one baseline row / the dataset. |
| `ar-v1.ts` | The typed dataset (scaffold; content pending sign-off). |
| `ar-v1.manifest.json` | Generated: `{version, sha256, rowCount}`. Regenerate with `pnpm seed:legal-baseline --write-manifest` after ANY dataset edit. |
| `ar-v1.signoff.json` | **Does not exist until the PO approves.** See below. |

The checksum covers the canonical dataset content
(`sha256(JSON.stringify(dataset))`), so any row change invalidates the
manifest and re-closes the gate.

## Sign-off flow (spec BD4/BD5 — the seed is fail-closed)

1. Legal research lands in `ar-v1.ts`; the manifest is regenerated and both
   are committed.
2. The PO reviews the dataset and records the approval as the engram decision
   `sdd/jurisdiction-compliance/baseline-signoff`, quoting the manifest
   `sha256`.
3. **Only after** that decision exists, the sign-off record is written (and
   committed) as `ar-v1.signoff.json`:

   ```json
   {
     "version": "ar-v1",
     "sha256": "<manifest sha256>",
     "engramDecision": "sdd/jurisdiction-compliance/baseline-signoff",
     "approvedBy": "<PO name>",
     "approvedAt": "YYYY-MM-DD"
   }
   ```

4. The seed then runs with BOTH proofs:

   ```
   pnpm seed:legal-baseline -- \
     --approved-checksum <manifest sha256> \
     --signoff-file data/legal-baseline/ar-v1.signoff.json
   ```

The seed refuses (exit 1, zero writes) on any mismatch between dataset,
manifest, `--approved-checksum` and the sign-off record. Applying it to
staging/production is additionally Ignacio-gated regardless of sign-off
status; the script refuses non-local `DATABASE_URL` hosts without
`--allow-remote`.

## Write guarantees

- Idempotent upsert on `govt_business_rules_type_jurisdiction_unique`
  (rule_type, country, province, locality — NULLS NOT DISTINCT).
- Admin-authored rows (`baseline_version IS NULL`) are never touched.
- Seeded rows carry `baseline_version` (origin badge vs admin overrides).
- Every insert/update writes the same `audit_log` row shape the console
  writers produce, so `/admin/inteligencia` B4 diffs and panorama rule-change
  markers capture baseline seeding; unchanged re-runs are audit-silent.
