// Which session may set an institutional account's first password.
//
// Security review 2026-09: a credential reset re-arms `password_setup_pending`
// and THEN revokes sessions. If the revocation fails, a session the reset was
// meant to end still carries the armed flag and is walked to /primer-acceso,
// where it could choose the new password. The arming is now stamped, and only a
// session AUTHENTICATED after the stamp (amr timestamp — never iat, which moves
// on every refresh) is accepted.
//
// Every instant below is written out literally, not derived from the code under
// test, so a change to the comparison cannot drag its own fixtures along.

import { describe, expect, it } from "vitest";

import { tokenWithClaims } from "@/__tests__/helpers/amr-token";
import { verifiedSessionStart } from "@/lib/infra/operator-shift";
import {
  armedPasswordSetupMetadata,
  isPasswordSetupPending,
  isSessionAfterArming,
  passwordSetupArmedAt,
} from "@/src/modules/auth/domain/first-access";

// 2026-09-18T12:00:00.400Z — armed 400 ms into a second.
const ARMED_ISO = "2026-09-18T12:00:00.400Z";
const ARMED_SECOND = 1789732800; // 2026-09-18T12:00:00Z in unix seconds

function sessionAt(amrSeconds: number, iatSeconds = amrSeconds): Date | null {
  return verifiedSessionStart(
    tokenWithClaims({
      sub: "user-001",
      iat: iatSeconds,
      amr: [{ method: "otp", timestamp: amrSeconds }],
    }),
  );
}

const armedUser = {
  app_metadata: { password_setup_pending: true, password_setup_armed_at: ARMED_ISO },
};

describe("armedPasswordSetupMetadata", () => {
  it("arms the flag and stamps the instant as ISO", () => {
    expect(armedPasswordSetupMetadata(new Date(ARMED_ISO))).toEqual({
      password_setup_pending: true,
      password_setup_armed_at: "2026-09-18T12:00:00.400Z",
    });
    expect(isPasswordSetupPending({ app_metadata: armedPasswordSetupMetadata(new Date()) })).toBe(
      true,
    );
  });
});

describe("passwordSetupArmedAt", () => {
  it("reads the stamp back", () => {
    expect(passwordSetupArmedAt(armedUser)?.toISOString()).toBe(ARMED_ISO);
  });

  it("is null when absent, not a string, or unparseable", () => {
    expect(passwordSetupArmedAt({ app_metadata: { password_setup_pending: true } })).toBeNull();
    expect(
      passwordSetupArmedAt({ app_metadata: { password_setup_armed_at: 1789732800 } }),
    ).toBeNull();
    expect(passwordSetupArmedAt({ app_metadata: { password_setup_armed_at: "ayer" } })).toBeNull();
    expect(passwordSetupArmedAt(null)).toBeNull();
  });
});

describe("isSessionAfterArming", () => {
  const armedAt = passwordSetupArmedAt(armedUser);

  it("refuses a session authenticated before the arming", () => {
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND - 60), armedAt)).toBe(false);
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND - 1), armedAt)).toBe(false);
  });

  it("refuses an OLD session even after it refreshed its access token (fresh iat)", () => {
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND - 60, ARMED_SECOND + 3600), armedAt)).toBe(
      false,
    );
  });

  it("accepts a session authenticated after the arming", () => {
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND + 30), armedAt)).toBe(true);
  });

  it("accepts a session authenticated in the same whole second as the arming", () => {
    // amr carries whole seconds; the link cannot be refused for 400 ms it cannot express.
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND), armedAt)).toBe(true);
  });

  it("fails closed when either side is unknown", () => {
    const noAmr = verifiedSessionStart(
      tokenWithClaims({ sub: "user-001", iat: ARMED_SECOND + 30 }),
    );
    expect(noAmr).toBeNull();
    expect(isSessionAfterArming(noAmr, armedAt)).toBe(false);
    expect(isSessionAfterArming(sessionAt(ARMED_SECOND + 30), null)).toBe(false);
  });
});
