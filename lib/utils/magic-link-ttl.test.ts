import { describe, expect, it } from "vitest";

import { MAGIC_LINK_TTL_SECONDS, formatTtl } from "./magic-link-ttl";

describe("MAGIC_LINK_TTL_SECONDS", () => {
  it("defaults to 3600 when env override is absent", () => {
    // In the test environment MAGIC_LINK_TTL_SECONDS env var is not set,
    // so the module should export 3600 (mirrors supabase/config.toml otp_expiry).
    expect(MAGIC_LINK_TTL_SECONDS).toBe(3600);
  });
});

describe("formatTtl", () => {
  it("formats 3600 as '1 hora'", () => {
    expect(formatTtl(3600)).toBe("1 hora");
  });

  it("formats 7200 as '2 horas'", () => {
    expect(formatTtl(7200)).toBe("2 horas");
  });

  it("formats 1800 as '30 minutos'", () => {
    expect(formatTtl(1800)).toBe("30 minutos");
  });

  it("formats 86400 as '24 horas'", () => {
    expect(formatTtl(86400)).toBe("24 horas");
  });
});
