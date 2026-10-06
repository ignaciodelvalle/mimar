// The web doors of a notification (notificaciones-destinos review, 2026-10):
// the `/notificaciones/{id}/abrir` redirect and the `/notificaciones/{id}`
// explanation page.
//
//   · S1 — every redirect stays on the request's origin; `/\t/evil.com`,
//     `/\evil.com` and `https://evil.com` land on the explanation instead.
//   · R1 — a session that still owes its first password or its second factor
//     goes there, not to a login that would bounce it straight back.
//   · R2 — the explanation page lives outside `(app)`, whose layout bounces
//     admin and govt accounts to their portals; both roles can read it.
//   · Both spend their own per-IP limiter BEFORE the session read — they sit
//     in `(public)` with an identifier in the URL (route census in
//     public-token-throttle-coverage.test.ts) — and a throttled caller reaches
//     no session read and no resolve.

import { readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedNotificationTarget } from "@/src/modules/notifications/application/read/resolve-notification-target";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  target: null as null | (() => unknown),
  role: "admin" as string,
  throttled: false,
  limiterFault: false,
  sessionReads: 0,
  limiterCalls: [] as Array<{ bucket: string; key?: string }>,
}));

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (bucket: string, key: string) => {
      control.limiterCalls.push({ bucket, key });
      if (control.limiterFault) throw new Error("rate_limit_buckets is unavailable");
      if (control.throttled) throw new actual.RateLimitError(new Date(), "test");
    },
  };
});
vi.mock("@/lib/infra/public-token-throttle", () => ({
  isPublicTokenReadThrottled: async (bucket: string) => {
    control.limiterCalls.push({ bucket });
    return control.throttled;
  },
}));
vi.mock("@/lib/infra/report-error", () => ({ reportError: () => undefined }));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => {
      control.sessionReads += 1;
      return control.live
        ? control.live()
        : { ok: true, user: { id: "u-1" }, profile: { id: "u-1", role: control.role } };
    },
  };
});
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: async () => {
    control.sessionReads += 1;
    return { supabase: {}, user: { id: "u-1" } };
  },
}));
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: async () => ({ id: "u-1", role: control.role }),
}));
vi.mock("@/lib/infra/case-read", () => ({
  caseViewerFromProfile: async (p: { id: string; role: string }) => ({
    userId: p.id,
    role: p.role,
    jurisdictions: [],
  }),
}));
vi.mock("@/app/_composition/notification-target-ports", () => ({
  notificationTargetPorts: { hasOrgCapability: async () => false },
}));
vi.mock("@/src/modules/notifications/infrastructure/notification-target-probes", () => ({
  resolveOwnNotificationTarget: async () => (control.target ? control.target() : null),
}));

import { GET as openNotification } from "@/app/(public)/notificaciones/[notificationId]/abrir/route";
import NotificationExplanationPage from "@/app/(public)/notificaciones/[notificationId]/page";
import { sameOriginPath } from "@/lib/infra/same-origin-redirect";

const ID = "77777777-7777-4777-8777-777777777777";
const BASE = "https://www.mimar.com.ar";

function target(over: Partial<ResolvedNotificationTarget> = {}): ResolvedNotificationTarget {
  return {
    notificationId: ID,
    notificationType: "outbreak_signal_detected",
    outcome: "section",
    primaryDestination: "section",
    webHref: "/gob/cola",
    appRoute: `/aviso/${ID}`,
    webOnly: true,
    reason: "web_only",
    reasonCopy: "Esto se gestiona desde la web.",
    actorCopy: "Te toca a vos: revisalo y decidí cómo seguir.",
    pendingActor: "recipient",
    externalUrl: null,
    externalLabel: null,
    title: "Señal de brote",
    body: "Tres casos en La Plata.",
    ...over,
  };
}

async function open(): Promise<Response> {
  return openNotification(
    new Request(`${BASE}/notificaciones/${ID}/abrir`, { headers: { "x-real-ip": "203.0.113.9" } }),
    {
      params: Promise.resolve({ notificationId: ID }),
    },
  );
}

beforeEach(() => {
  control.live = null;
  control.target = null;
  control.role = "admin";
  control.throttled = false;
  control.limiterFault = false;
  control.sessionReads = 0;
  control.limiterCalls = [];
});

describe("sameOriginPath (S1)", () => {
  it.each(["/\t/evil.com", "/\\evil.com", "https://evil.com", "//evil.com"])(
    "refuses %j",
    (path) => {
      expect(sameOriginPath(`${BASE}/x`, path, "/fallback")).toBe("/fallback");
    },
  );

  it("keeps a same-origin path", () => {
    expect(sameOriginPath(`${BASE}/x`, "/casos/CAS-AAAA-BBBB", "/fallback")).toBe(
      "/casos/CAS-AAAA-BBBB",
    );
  });
});

describe("/notificaciones/{id}/abrir", () => {
  it.each(["/\t/evil.com", "/\\evil.com", "https://evil.com"])(
    "never redirects off-origin, even if the resolver handed back %j",
    async (webHref) => {
      control.target = () => target({ outcome: "section", webHref });
      const response = await open();
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe(BASE);
      expect(location.pathname).toBe(`/notificaciones/${ID}`);
    },
  );

  it("shows an external link on the explanation page instead of redirecting to it", async () => {
    control.target = () =>
      target({ outcome: "external", externalUrl: "https://www.argentina.gob.ar/salud" });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.origin).toBe(BASE);
    expect(location.pathname).toBe(`/notificaciones/${ID}`);
  });

  it("redirects to the resolved destination", async () => {
    control.target = () => target({ outcome: "case", webHref: "/casos/CAS-AAAA-BBBB" });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.pathname).toBe("/casos/CAS-AAAA-BBBB");
  });

  // R1 — the same order requireUserOrRedirect uses.
  it("sends a session that owes its first password to primer acceso", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION", passwordSetupPending: true });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.pathname).toBe("/primer-acceso");
  });

  it("sends a session that owes its second factor to the MFA step, keeping the way back", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION", mfaPending: "challenge" });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.pathname).toBe("/mfa");
    expect(location.searchParams.get("returnTo")).toBe(`/notificaciones/${ID}/abrir`);
  });

  it("sends a plain missing session to the login with the way back", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.pathname).toBe("/iniciar-sesion");
    expect(location.searchParams.get("returnTo")).toBe(`/notificaciones/${ID}/abrir`);
  });
});

describe("/notificaciones/{id}/abrir — the limiter runs first", () => {
  it("spends its own bucket, keyed on the caller's address", async () => {
    control.target = () => target({ outcome: "case", webHref: "/casos/CAS-AAAA-BBBB" });
    await open();
    expect(control.limiterCalls).toEqual([{ bucket: "notification_open", key: "203.0.113.9" }]);
  });

  it("answers a throttled caller 429 before any session read", async () => {
    control.throttled = true;
    const response = await open();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("location")).toBeNull();
    expect(control.sessionReads).toBe(0);
  });

  it("fails OPEN when the limiter itself is broken", async () => {
    control.limiterFault = true;
    control.target = () => target({ outcome: "case", webHref: "/casos/CAS-AAAA-BBBB" });
    const location = new URL((await open()).headers.get("location") ?? "");
    expect(location.pathname).toBe("/casos/CAS-AAAA-BBBB");
  });
});

describe("/notificaciones/{id} — the explanation page (R2)", () => {
  it("spends its own bucket, and a throttled caller gets the notice and no session read", async () => {
    control.throttled = true;
    control.target = () => target();
    const element = await NotificationExplanationPage({
      params: Promise.resolve({ notificationId: ID }),
    });
    const html = renderToStaticMarkup(element);
    expect(control.limiterCalls).toEqual([{ bucket: "notification_explanation" }]);
    expect(control.sessionReads).toBe(0);
    expect(html).toContain("Esperá un minuto");
    expect(html).not.toContain("Señal de brote");
  });

  it("does not live under (app), whose layout bounces admin and govt", () => {
    const appGroup = readdirSync("app/(app)/notificaciones");
    expect(appGroup).not.toContain("[notificationId]");
    expect(readdirSync("app/(public)/notificaciones")).toContain("[notificationId]");
  });

  it.each(["admin", "govt"])("renders for a %s account", async (role) => {
    control.role = role;
    control.target = () => target();
    const element = await NotificationExplanationPage({
      params: Promise.resolve({ notificationId: ID }),
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Señal de brote");
    expect(html).toContain("Te toca a vos: revisalo y decidí cómo seguir.");
    expect(html).toContain('href="/gob/cola"');
  });

  it("renders no link for an off-origin path (S1)", async () => {
    control.target = () => target({ webHref: "/\\evil.com" });
    const element = await NotificationExplanationPage({
      params: Promise.resolve({ notificationId: ID }),
    });
    expect(renderToStaticMarkup(element)).not.toContain("evil.com");
  });
});
