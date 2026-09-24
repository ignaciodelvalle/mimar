// Unit tests for lib/keyset-pagination.ts
//
// Covers:
//   - encodeCursor / decodeCursor roundtrip
//   - decodeCursor returns null for tampered / malformed / empty input
//   - keysetWhere returns undefined for null cursor (page 1)
//   - keysetWhere returns a SQL fragment for a real cursor (shape check)
//   - olderHref / newerHref URL construction and filter preservation

import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  keysetWhere,
  newerHref,
  olderHref,
} from "@/lib/utils/keyset-pagination";

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor roundtrip
// ---------------------------------------------------------------------------

describe("encodeCursor / decodeCursor", () => {
  it("roundtrips a Date + uuid", () => {
    const ts = new Date("2025-03-15T12:00:00.000Z");
    const id = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
    const cursor = encodeCursor(ts, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.ts).toBe("2025-03-15T12:00:00.000Z");
    expect(decoded!.id).toBe(id);
  });

  it("roundtrips an ISO string + uuid", () => {
    const iso = "2024-01-01T00:00:00.000Z";
    const id = "00000000-0000-0000-0000-000000000001";
    const cursor = encodeCursor(iso, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.ts).toBe(iso);
    expect(decoded!.id).toBe(id);
  });

  it("produces a base64url string (no +, /, = padding)", () => {
    const cursor = encodeCursor(new Date("2025-06-10T00:00:00.000Z"), "some-id-here");
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("different rows produce different cursors", () => {
    const a = encodeCursor("2025-01-01T00:00:00.000Z", "id-a");
    const b = encodeCursor("2025-01-01T00:00:00.000Z", "id-b");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// decodeCursor — tamper / malform rejection
// ---------------------------------------------------------------------------

describe("decodeCursor — rejection cases", () => {
  it("returns null for undefined", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for random garbage", () => {
    expect(decodeCursor("not-a-cursor-at-all")).toBeNull();
  });

  it("returns null for base64url with no pipe separator", () => {
    const noPipe = Buffer.from("2025-01-01T00:00:00.000Znoid", "utf8").toString("base64url");
    expect(decodeCursor(noPipe)).toBeNull();
  });

  it("returns null when timestamp part is invalid", () => {
    const bad = Buffer.from("not-a-date|some-uuid", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null when id part is empty", () => {
    const bad = Buffer.from("2025-01-01T00:00:00.000Z|", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for a tampered cursor (random suffix appended)", () => {
    const real = encodeCursor("2025-01-01T00:00:00.000Z", "some-id");
    // Appending random chars corrupts base64url decoding; the resulting payload
    // will either fail ISO-8601 or UUID validation — both produce null.
    const tampered = `${real}XXXX`;
    expect(decodeCursor(tampered)).toBeNull();
  });

  // Strict UUID validation — id must be a well-formed RFC 4122 UUID.
  it("returns null when id is valid ISO but not a UUID (plain string)", () => {
    const bad = Buffer.from("2025-01-01T00:00:00.000Z|not-a-uuid", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null when id is a truncated/malformed UUID", () => {
    const bad = Buffer.from("2025-01-01T00:00:00.000Z|a1b2c3d4-e5f6-7890-abcd", "utf8").toString(
      "base64url",
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  // Strict ISO-8601 validation — Date.parse-lenient values must be rejected.
  it("returns null for a year-only string parseable by Date.parse", () => {
    const bad = Buffer.from("2026|a1b2c3d4-e5f6-7890-abcd-ef0123456789", "utf8").toString(
      "base64url",
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for a human-readable date parseable by Date.parse", () => {
    const bad = Buffer.from("Jan 1 2026|a1b2c3d4-e5f6-7890-abcd-ef0123456789", "utf8").toString(
      "base64url",
    );
    expect(decodeCursor(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// keysetWhere
// ---------------------------------------------------------------------------

describe("keysetWhere", () => {
  // Minimal Drizzle column mock — just needs to be an object that drizzle
  // sql`` can embed (it uses the reference as a table.column placeholder).
  // We only check the return value shape, not the full SQL text.
  const fakeTsCol = { fieldAliasMapKey: "created_at" } as unknown as Parameters<
    typeof keysetWhere
  >[0];
  const fakeIdCol = { fieldAliasMapKey: "id" } as unknown as Parameters<typeof keysetWhere>[1];

  it("returns undefined for null cursor (page 1 — no predicate)", () => {
    expect(keysetWhere(fakeTsCol, fakeIdCol, null)).toBeUndefined();
  });

  it("returns a SQL object for a valid cursor", () => {
    const result = keysetWhere(fakeTsCol, fakeIdCol, {
      ts: "2025-01-01T00:00:00.000Z",
      id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    });
    // Must be a defined object (Drizzle SQL fragment).
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("embeds the cursor iso string in the SQL fragment", () => {
    const iso = "2025-06-10T14:30:00.000Z";
    const result = keysetWhere(fakeTsCol, fakeIdCol, { ts: iso, id: "abc-123" });
    // Drizzle sql`` stores values in queryChunks.
    // We verify the iso appears somewhere in the fragment's internal chunks.
    const asJson = JSON.stringify(result);
    expect(asJson).toContain(iso);
  });

  it("embeds the cursor id in the SQL fragment", () => {
    const id = "deadbeef-dead-dead-dead-deadbeefcafe";
    const result = keysetWhere(fakeTsCol, fakeIdCol, { ts: "2025-01-01T00:00:00.000Z", id });
    const asJson = JSON.stringify(result);
    expect(asJson).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// olderHref / newerHref
// ---------------------------------------------------------------------------

describe("olderHref", () => {
  it("adds a cursor param with no existing filters", () => {
    const href = olderHref("/notificaciones", {}, { ts: "2025-01-01T00:00:00.000Z", id: "id-1" });
    expect(href).toContain("/notificaciones?");
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("cursor")).toBeTruthy();
  });

  it("preserves existing filter params", () => {
    const href = olderHref(
      "/notificaciones",
      { cat: "health" },
      {
        ts: "2025-01-01T00:00:00.000Z",
        id: "id-1",
      },
    );
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("cat")).toBe("health");
    expect(url.searchParams.get("cursor")).toBeTruthy();
  });

  it("replaces an existing cursor param", () => {
    const sp = new URLSearchParams({ cursor: "old-cursor", status: "pending" });
    const href = olderHref("/admin/outbox", sp, {
      ts: "2025-06-01T00:00:00.000Z",
      id: "new-id",
    });
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("cursor")).not.toBe("old-cursor");
    expect(url.searchParams.get("status")).toBe("pending");
  });

  it("the cursor roundtrips: encode in olderHref, decode back", () => {
    const ts = new Date("2025-03-20T08:00:00.000Z");
    const id = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
    const href = olderHref("/notificaciones", {}, { ts, id });
    const url = new URL(href, "http://localhost");
    const cursorParam = url.searchParams.get("cursor")!;
    const decoded = decodeCursor(cursorParam);
    expect(decoded).not.toBeNull();
    expect(decoded!.ts).toBe(ts.toISOString());
    expect(decoded!.id).toBe(id);
  });
});

describe("newerHref", () => {
  it("removes cursor param", () => {
    const sp = new URLSearchParams({ cursor: "some-cursor", cat: "health" });
    const href = newerHref("/notificaciones", sp);
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it("preserves other filters", () => {
    const sp = new URLSearchParams({ cursor: "c", status: "pending", province: "CABA" });
    const href = newerHref("/admin/outbox", sp);
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("province")).toBe("CABA");
  });

  it("returns bare pathname when no other params exist", () => {
    const href = newerHref("/notificaciones", {});
    expect(href).toBe("/notificaciones");
  });
});
