// No pipelining on any app pool (2026-10, engram infra/postgres-pipelining-supavisor-hang).
//
// postgres.js pipelines a query onto a busy connection by default, and through
// Supavisor's transaction pooler a pipelined query that returns zero rows never
// gets its answer: the promise hangs and the connection is poisoned. Both pools
// in db/index.ts set `max_pipeline: 0`. This file pins that, for the two
// production profiles (which a test run never constructs: in tests the
// analytics export shares the OLTP pool) and for the live pool.
//
// It also pins the analytics pool's refusal to run transactions, which is how
// a write that drifts onto the read-only pool fails loudly instead of quietly.
//
// DB-free: postgres() parses its options at construction and connects lazily,
// so nothing here opens a socket. The transaction-under-max_pipeline-0 proof
// against a real database is __tests__/db-transaction-no-pipeline.test.ts.

import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  ANALYTICS_NO_TRANSACTIONS,
  analyticsDb,
  analyticsPoolOptions,
  db,
  oltpPoolOptions,
} from "@/db";
import {
  builderReadClientOptions,
  builderWriteClientOptions,
} from "@/src/modules/panorama/infrastructure/cube-builder";

/** drizzle sets $client at runtime; the exported handle type omits it. */
function rawClient(handle: unknown): postgres.Sql {
  return (handle as { $client: postgres.Sql }).$client;
}

function maxPipeline(options: object): unknown {
  return (options as { max_pipeline?: unknown }).max_pipeline;
}

describe("app pools never pipeline", () => {
  it("the OLTP pool profile sets max_pipeline 0, in production and in tests", () => {
    expect(maxPipeline(oltpPoolOptions(false))).toBe(0);
    expect(maxPipeline(oltpPoolOptions(true))).toBe(0);
  });

  it("the analytics pool profile sets max_pipeline 0", () => {
    expect(maxPipeline(analyticsPoolOptions(15_000))).toBe(0);
  });

  it("the cube builder's read and write clients set max_pipeline 0", () => {
    // The write client runs the cube's replace-all transaction; with
    // patches/postgres.patch that works without pipelining.
    expect(maxPipeline(builderReadClientOptions(120_000))).toBe(0);
    expect(maxPipeline(builderWriteClientOptions(120_000))).toBe(0);
  });

  it("the live pool behind db parsed max_pipeline 0", () => {
    // postgres.js exposes its parsed options on the client; drizzle exposes the
    // client as $client. A parsed 0 is what reaches connection.js.
    expect(maxPipeline(rawClient(db).options)).toBe(0);
  });
});

describe("analyticsDb refuses transactions", () => {
  it("throws on .transaction() and names the pool to use instead", () => {
    expect(() => analyticsDb.transaction(async () => undefined)).toThrow(ANALYTICS_NO_TRANSACTIONS);
  });

  it("throws on .begin() reached through $client", () => {
    expect(() => rawClient(analyticsDb).begin(async () => undefined)).toThrow(
      ANALYTICS_NO_TRANSACTIONS,
    );
  });

  it("keeps the rest of the handle working", () => {
    expect(typeof analyticsDb.select).toBe("function");
    expect(typeof rawClient(analyticsDb).unsafe).toBe("function");
  });
});
