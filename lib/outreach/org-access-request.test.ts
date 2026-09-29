// The organization access request (critique 2026-09-29, M8): validation,
// honeypot, rate limit, catalogue check and the mail it becomes. Every side
// effect is a fake, so this file never reaches the database or Resend.

import { describe, expect, it } from "vitest";

import {
  ORG_ACCESS_FIELDS,
  ORG_ACCESS_LIMITS,
  ORG_ACCESS_RATE_LIMITED_MESSAGE,
  ORG_ACCESS_UNAVAILABLE_MESSAGE,
  type OrgAccessDeps,
  type OrgAccessMail,
  buildOrgAccessMail,
  parseOrgAccessRequest,
  submitOrgAccessRequest,
} from "@/lib/outreach/org-access-request";
import { CONTACT_EMAILS } from "@/lib/ui/contact";

class FakeRateLimitError extends Error {}

const VALID: Record<string, string> = {
  [ORG_ACCESS_FIELDS.orgType]: "refugio",
  [ORG_ACCESS_FIELDS.orgName]: "Refugio Patitas del Barrio",
  [ORG_ACCESS_FIELDS.province]: "AR-B",
  [ORG_ACCESS_FIELDS.locality]: "La Plata",
  [ORG_ACCESS_FIELDS.fullName]: "Ana Pérez",
  [ORG_ACCESS_FIELDS.email]: "Ana.Perez@Refugio.Example",
  [ORG_ACCESS_FIELDS.phone]: "+54 221 555-0101",
  [ORG_ACCESS_FIELDS.message]: "Tenemos 40 perros en tránsito.",
  [ORG_ACCESS_FIELDS.consent]: "on",
};

function form(overrides: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value !== null) fd.set(key, value);
  }
  return fd;
}

function deps(overrides: Partial<OrgAccessDeps> = {}) {
  const sent: OrgAccessMail[] = [];
  const logs: Array<[string, string | null]> = [];
  const rateLimitCalls: Array<[string, string]> = [];
  const base: OrgAccessDeps = {
    enforceRateLimit: async (endpoint, identifier) => {
      rateLimitCalls.push([endpoint, identifier]);
    },
    isRateLimitError: (err) => err instanceof FakeRateLimitError,
    isKnownLocality: async () => true,
    sendMail: async (mail) => {
      sent.push(mail);
      return true;
    },
    log: (outcome, orgType) => logs.push([outcome, orgType]),
  };
  return { deps: { ...base, ...overrides }, sent, logs, rateLimitCalls };
}

describe("parseOrgAccessRequest — validation", () => {
  it("accepts a complete request and normalises the email", () => {
    const parsed = parseOrgAccessRequest(form());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.email).toBe("ana.perez@refugio.example");
  });

  it("names each missing required field, and needs the consent", () => {
    const parsed = parseOrgAccessRequest(
      form({
        [ORG_ACCESS_FIELDS.orgType]: "",
        [ORG_ACCESS_FIELDS.orgName]: "",
        [ORG_ACCESS_FIELDS.locality]: "",
        [ORG_ACCESS_FIELDS.email]: "no-es-un-correo",
        [ORG_ACCESS_FIELDS.consent]: null,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.state.fieldErrors).sort()).toEqual([
      "consent",
      "email",
      "locality",
      "orgName",
      "orgType",
    ]);
  });

  it("refuses a message over the limit and a phone with letters", () => {
    const parsed = parseOrgAccessRequest(
      form({
        [ORG_ACCESS_FIELDS.message]: "x".repeat(ORG_ACCESS_LIMITS.message + 1),
        [ORG_ACCESS_FIELDS.phone]: "llamame",
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.state.fieldErrors.message).toBeDefined();
    expect(parsed.state.fieldErrors.phone).toBeDefined();
  });
});

describe("buildOrgAccessMail", () => {
  it("goes to our general mailbox with Reply-To the requester, HTML escaped", () => {
    const parsed = parseOrgAccessRequest(
      form({ [ORG_ACCESS_FIELDS.orgName]: 'Refugio <b>"Sol"</b>' }),
    );
    if (!parsed.ok) throw new Error("fixture must parse");
    const mail = buildOrgAccessMail(parsed.value);
    expect(mail.to).toBe(CONTACT_EMAILS.general);
    expect(mail.replyTo).toBe("ana.perez@refugio.example");
    expect(mail.subject).toContain("Pedido de acceso");
    expect(mail.text).toContain("Refugio o protectora");
    expect(mail.text).toContain("La Plata, Buenos Aires");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("&lt;b&gt;");
  });
});

describe("submitOrgAccessRequest — the use case", () => {
  it("sends one mail on a valid request, spending both buckets", async () => {
    const { deps: d, sent, rateLimitCalls } = deps();
    const state = await submitOrgAccessRequest(form(), "203.0.113.7", d);
    expect(state).toEqual({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(rateLimitCalls).toEqual([
      ["org_access_request_ip", "203.0.113.7"],
      ["org_access_request_all", "any"],
    ]);
  });

  it("answers a filled honeypot with the same success and sends nothing", async () => {
    const { deps: d, sent, rateLimitCalls } = deps();
    const state = await submitOrgAccessRequest(
      form({ [ORG_ACCESS_FIELDS.honeypot]: "bot" }),
      "ip",
      d,
    );
    expect(state).toEqual({ status: "sent" });
    expect(sent).toHaveLength(0);
    expect(rateLimitCalls).toHaveLength(0);
  });

  it("does not spend a bucket on an invalid form", async () => {
    const { deps: d, rateLimitCalls } = deps();
    const state = await submitOrgAccessRequest(form({ [ORG_ACCESS_FIELDS.email]: "" }), "ip", d);
    expect(state.status).toBe("invalid");
    expect(rateLimitCalls).toHaveLength(0);
  });

  it("reports the rate limit, and rethrows anything else", async () => {
    const limited = deps({
      enforceRateLimit: async () => {
        throw new FakeRateLimitError();
      },
    });
    expect(await submitOrgAccessRequest(form(), "ip", limited.deps)).toEqual({
      status: "rate_limited",
      message: ORG_ACCESS_RATE_LIMITED_MESSAGE,
    });
    const broken = deps({
      enforceRateLimit: async () => {
        throw new Error("db down");
      },
    });
    await expect(submitOrgAccessRequest(form(), "ip", broken.deps)).rejects.toThrow("db down");
  });

  it("refuses a locality outside the catalogue and sends nothing", async () => {
    const { deps: d, sent } = deps({ isKnownLocality: async () => false });
    const state = await submitOrgAccessRequest(form(), "ip", d);
    expect(state.status).toBe("invalid");
    if (state.status !== "invalid") return;
    expect(state.fieldErrors.locality).toBeDefined();
    expect(sent).toHaveLength(0);
  });

  it("says it could not send when the provider refuses, naming the mailbox", async () => {
    const { deps: d } = deps({ sendMail: async () => false });
    expect(await submitOrgAccessRequest(form(), "ip", d)).toEqual({
      status: "unavailable",
      message: ORG_ACCESS_UNAVAILABLE_MESSAGE,
    });
    expect(ORG_ACCESS_UNAVAILABLE_MESSAGE).toContain(CONTACT_EMAILS.general);
  });

  it("never logs personal data: only the outcome and the organization type", async () => {
    const { deps: d, logs } = deps();
    await submitOrgAccessRequest(form(), "ip", d);
    expect(logs).toEqual([["sent", "refugio"]]);
  });
});
