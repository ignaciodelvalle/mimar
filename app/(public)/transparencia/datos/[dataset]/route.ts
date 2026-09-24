// GET /transparencia/datos/[dataset]?format=csv|json — PUBLIC, unauthenticated
// open-data downloads (Epic B, item 2). Ley 27.275 active transparency.
//
// Only the five province-level AGGREGATE datasets, already k=5 suppressed in
// lib/open-data/datasets.ts. No auth, no PII, no per-pet rows — the response is
// province name + ISO code + an aggregate base + a percentage/count (or the
// suppression marker). See docs/datos-abiertos/diccionario.md.
//
// BOUNDED DB LOAD: the heavy national aggregate query is computed at most once
// per REVALIDATE_SECONDS per dataset behind unstable_cache; the request path only
// re-formats the cached snapshot (CSV vs JSON). generatedAt is frozen at
// snapshot time, so both formats of the same snapshot agree.

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import {
  DATASET_IDS,
  type DatasetId,
  type DatasetMeta,
  buildDataset,
  isDatasetId,
} from "@/lib/open-data/datasets";
import {
  type DatasetFormat,
  datasetToCsv,
  datasetToJson,
  parseFormat,
} from "@/lib/open-data/serialize";

/** The underlying figures change at most daily; refresh the snapshot every 24h
 *  (daily) — matches the cadence promised on the transparency page and in
 *  docs/datos-abiertos (audit fix, 2026-07). */
const REVALIDATE_SECONDS = 86_400;

/** Per-IP budget for the public download endpoint. Mirrors the closest public
 *  read-route pattern in the repo (denuncia_receipt, case_detail_public):
 *  30/min is generous for a real citizen/journalist download session, tight
 *  enough to blunt a scrape burst against the public, unauthenticated
 *  endpoint. */
const OPEN_DATA_RATE_LIMIT = { maxPerMinute: 30, maxPerHour: 200 } as const;

/** Cache the DB-backed dataset build per id. unstable_cache folds the argument
 *  into the cache key, so each dataset gets its own cached snapshot; the tags
 *  allow a manual revalidateTag("open-data") after a data correction. */
const getDatasetCached = unstable_cache(
  async (id: DatasetId) => buildDataset(id),
  ["open-data-dataset-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["open-data"] },
);

/** Shared metadata headers so the file is self-describing even without the body. */
function metadataHeaders(meta: DatasetMeta): Record<string, string> {
  return {
    "X-Dataset-Id": meta.id,
    "X-Dataset-Generated-At": meta.generatedAt,
    "X-License": meta.license.id,
    "X-License-Url": meta.license.url,
    "X-Methodology-Url": meta.methodologyUrl,
    Link: `<${meta.methodologyUrl}>; rel="describedby"`,
    // Public, cacheable, revalidated off the request path (CDN-friendly).
    "Cache-Control": `public, max-age=3600, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=86400`,
    "X-Content-Type-Options": "nosniff",
  };
}

// @no-auth-required: public open data under Ley 27.275 (active transparency) —
// requiring an account would defeat the legal obligation the endpoint exists to
// discharge. It serves only the five province-level AGGREGATE datasets, already
// k=5 suppressed in lib/open-data/datasets.ts: no PII, no per-pet rows, nothing
// subject-identifying. Abuse is bounded by the per-IP limit below (30/min,
// 200/hour) applied BEFORE slug validation, so unknown-id probing is not free.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ dataset: string }> },
): Promise<Response> {
  try {
    const { dataset } = await ctx.params;

    // Rate-limit BEFORE validating the slug: otherwise an unknown-id 404 returns
    // before the limiter runs and unknown-id probing (enumeration/scrape burst)
    // would be free. Legit typos still get the helpful 404 body below.
    try {
      await enforceRateLimit("open_data_dataset", callerIp(request.headers), OPEN_DATA_RATE_LIMIT);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return NextResponse.json(
          { error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      throw err;
    }

    if (!isDatasetId(dataset)) {
      return NextResponse.json(
        { error: "unknown_dataset", datasets: DATASET_IDS },
        { status: 404 },
      );
    }

    const format: DatasetFormat = parseFormat(new URL(request.url).searchParams.get("format"));
    const built = await getDatasetCached(dataset);
    const headers = metadataHeaders(built.meta);

    if (format === "csv") {
      return new Response(datasetToCsv(built), {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${dataset}.csv"`,
        },
      });
    }

    return new Response(datasetToJson(built), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch {
    // Any unexpected failure (DB down, buildDataset throw, rate-limit write
    // error, etc.) → a generic 500 with no internal detail leaked to an
    // anonymous public caller. Specific handled paths (404, 429) return above
    // and never reach here.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
