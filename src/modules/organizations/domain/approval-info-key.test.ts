import { describe, expect, it } from "vitest";

import { approvalInfoDedupeKey, approvalRequestIdFromDedupeKey } from "./approval-info-key";

describe("approval-info dedupe key", () => {
  const REQUEST_ID = "3f2b1c9e-7d84-4a10-9f55-0e1c2d3a4b56";

  it("round-trips the request id — the property both sides depend on", () => {
    // This is the whole point of the module. The producer
    // (requestInfoForAuthority) mints the key; the consumer
    // (/cuenta/solicitudes) recovers the request id from it. If these two ever
    // disagree the applicant silently stops being told that a reviewer asked
    // them for something, and the request expires after 60 days for an
    // "inactividad" they were never given a way to end.
    const key = approvalInfoDedupeKey(REQUEST_ID, "a1b2c3");
    expect(approvalRequestIdFromDedupeKey(key)).toBe(REQUEST_ID);
  });

  it("keeps two different messages on one request as distinct keys", () => {
    const first = approvalInfoDedupeKey(REQUEST_ID, "a1b2c3");
    const second = approvalInfoDedupeKey(REQUEST_ID, "d4e5f6");
    expect(first).not.toBe(second);
    expect(approvalRequestIdFromDedupeKey(first)).toBe(approvalRequestIdFromDedupeKey(second));
  });

  it("is stable for the same message, so a retry dedupes", () => {
    expect(approvalInfoDedupeKey(REQUEST_ID, "a1b2c3")).toBe(
      approvalInfoDedupeKey(REQUEST_ID, "a1b2c3"),
    );
  });

  it("reads anything it did not mint as 'no ask', never as another request's id", () => {
    // notifications.dedupe_key is shared by every notification type. Returning a
    // borrowed id here would attach a reviewer's message to the wrong request on
    // the applicant's screen.
    for (const foreign of [
      null,
      undefined,
      "",
      "lost-pet:3f2b1c9e-7d84-4a10-9f55-0e1c2d3a4b56:x",
      "approval-info",
      "approval-info:",
      "approval-info::hash",
      `approval-info:${REQUEST_ID}`,
      `approval-info:${REQUEST_ID}:hash:extra`,
    ]) {
      expect(approvalRequestIdFromDedupeKey(foreign)).toBeNull();
    }
  });
});
