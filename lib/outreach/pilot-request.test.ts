// The /municipios pilot request: validation, honeypot, rate limit and the mail
// it becomes. Every side effect is a fake, so this file never reaches the
// database or Resend.

import { describe, expect, it, vi } from "vitest";

import {
  PILOT_FIELDS,
  PILOT_LIMITS,
  PILOT_RATE_LIMITED_MESSAGE,
  PILOT_UNAVAILABLE_MESSAGE,
  type PilotMail,
  type PilotRequestDeps,
  buildPilotMail,
  parsePilotRequest,
  submitPilotRequest,
} from "@/lib/outreach/pilot-request";
import { CONTACT_EMAILS } from "@/lib/ui/contact";

class FakeRateLimitError extends Error {}

const VALID: Record<string, string> = {
  [PILOT_FIELDS.organismType]: "municipio",
  [PILOT_FIELDS.organismName]: "Dirección de Zoonosis",
  [PILOT_FIELDS.province]: "AR-B",
  [PILOT_FIELDS.locality]: "La Plata",
  [PILOT_FIELDS.fullName]: "Ana Pérez",
  [PILOT_FIELDS.role]: "Directora",
  [PILOT_FIELDS.email]: "Ana.Perez@Municipio.Example",
  [PILOT_FIELDS.phone]: "+54 221 555-0101",
  [PILOT_FIELDS.message]: "Queremos ver la cobertura antirrábica por barrio.",
  [PILOT_FIELDS.consent]: "on",
};

function form(overrides: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value !== null) fd.set(key, value);
  }
  return fd;
}

function deps(overrides: Partial<PilotRequestDeps> = {}) {
  const sent: PilotMail[] = [];
  const logs: Array<[string, string | null]> = [];
  const rateLimitCalls: Array<[string, string, object]> = [];
  const base: PilotRequestDeps = {
    enforceRateLimit: async (endpoint, identifier, config) => {
      rateLimitCalls.push([endpoint, identifier, config]);
    },
    isRateLimitError: (err) => err instanceof FakeRateLimitError,
    isCanonicalLocality: async () => true,
    sendMail: async (mail) => {
      sent.push(mail);
      return true;
    },
    log: (outcome, organismType) => logs.push([outcome, organismType]),
  };
  return { deps: { ...base, ...overrides }, sent, logs, rateLimitCalls };
}

describe("parsePilotRequest — validation", () => {
  it("accepts a complete municipio request and normalises it", () => {
    const parsed = parsePilotRequest(form());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.email).toBe("ana.perez@municipio.example");
    expect(parsed.value.localityName).toBe("La Plata");
  });

  it("accepts a province-level office without a locality, and optional fields left blank", () => {
    const parsed = parsePilotRequest(
      form({
        [PILOT_FIELDS.organismType]: "provincia",
        [PILOT_FIELDS.locality]: "",
        [PILOT_FIELDS.phone]: "",
        [PILOT_FIELDS.message]: "",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.localityName).toBeNull();
    expect(parsed.value.phone).toBeNull();
    expect(parsed.value.message).toBeNull();
  });

  it("requires a locality when the organism is a municipio", () => {
    const parsed = parsePilotRequest(form({ [PILOT_FIELDS.locality]: "  " }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.state.fieldErrors.locality).toMatch(/localidad/i);
  });

  it("names every broken field under its own key", () => {
    const parsed = parsePilotRequest(
      form({
        [PILOT_FIELDS.organismType]: "embajada",
        [PILOT_FIELDS.province]: "AR-ZZ",
        [PILOT_FIELDS.fullName]: "",
        [PILOT_FIELDS.role]: "",
        [PILOT_FIELDS.email]: "no-es-un-correo",
        [PILOT_FIELDS.phone]: "llamame",
        [PILOT_FIELDS.consent]: null,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.state.fieldErrors).sort()).toEqual(
      ["consent", "email", "fullName", "organismType", "phone", "province", "role"].sort(),
    );
    expect(parsed.state.message).toMatch(/Revisá/);
  });

  it("caps the free-text message", () => {
    const parsed = parsePilotRequest(
      form({ [PILOT_FIELDS.message]: "x".repeat(PILOT_LIMITS.message + 1) }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.state.fieldErrors.message).toBeDefined();
  });
});

describe("buildPilotMail — the mail goes to our own inbox, answered to the requester", () => {
  it("is addressed to the pilots mailbox with Reply-To set to the requester", () => {
    const parsed = parsePilotRequest(form());
    if (!parsed.ok) throw new Error("fixture must be valid");
    const mail = buildPilotMail(parsed.value);
    expect(mail.to).toBe(CONTACT_EMAILS.pilots);
    expect(mail.replyTo).toBe("ana.perez@municipio.example");
    expect(mail.subject).toBe("Pedido de piloto: Dirección de Zoonosis (La Plata, Buenos Aires)");
    expect(mail.text).toContain("Cargo: Directora");
  });

  it("escapes HTML and strips header-breaking characters from the subject", () => {
    const parsed = parsePilotRequest(
      form({ [PILOT_FIELDS.organismName]: "Zoonosis\r\nBcc: x@y.z <b>" }),
    );
    if (!parsed.ok) throw new Error("fixture must be valid");
    const mail = buildPilotMail(parsed.value);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("&lt;b&gt;");
  });
});

describe("submitPilotRequest", () => {
  it("sends one mail and reports success", async () => {
    const { deps: d, sent, rateLimitCalls } = deps();
    const state = await submitPilotRequest(form(), "203.0.113.7", d);
    expect(state).toEqual({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(CONTACT_EMAILS.pilots);
    expect(sent[0]?.replyTo).toBe("ana.perez@municipio.example");
    // Per-IP bucket first, then the IP-less ceiling on the whole form.
    expect(rateLimitCalls).toEqual([
      ["pilot_request_ip", "203.0.113.7", PILOT_LIMITS.perIp],
      ["pilot_request_all", "any", PILOT_LIMITS.global],
    ]);
  });

  it("honeypot: answers like a success, spends no bucket and sends nothing", async () => {
    const { deps: d, sent, rateLimitCalls, logs } = deps();
    const state = await submitPilotRequest(
      form({ [PILOT_FIELDS.honeypot]: "https://spam.example" }),
      "203.0.113.7",
      d,
    );
    expect(state).toEqual({ status: "sent" });
    expect(sent).toEqual([]);
    expect(rateLimitCalls).toEqual([]);
    expect(logs).toEqual([["honeypot", null]]);
  });

  it("validation runs before any bucket is spent", async () => {
    const { deps: d, rateLimitCalls, sent } = deps();
    const state = await submitPilotRequest(form({ [PILOT_FIELDS.email]: "" }), "ip", d);
    expect(state.status).toBe("invalid");
    expect(rateLimitCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("rate limit: refuses with the es-AR message and sends nothing", async () => {
    const { deps: d, sent } = deps({
      enforceRateLimit: async () => {
        throw new FakeRateLimitError("over");
      },
    });
    const state = await submitPilotRequest(form(), "ip", d);
    expect(state).toEqual({ status: "rate_limited", message: PILOT_RATE_LIMITED_MESSAGE });
    expect(sent).toEqual([]);
  });

  it("rate limit: an error that is not a rate limit is not swallowed", async () => {
    const { deps: d } = deps({
      enforceRateLimit: async () => {
        throw new Error("db down");
      },
    });
    await expect(submitPilotRequest(form(), "ip", d)).rejects.toThrow("db down");
  });

  it("refuses a locality that is not in the catalog", async () => {
    const isCanonicalLocality = vi.fn(async () => false);
    const { deps: d, sent } = deps({ isCanonicalLocality });
    const state = await submitPilotRequest(form(), "ip", d);
    expect(state.status).toBe("invalid");
    if (state.status !== "invalid") return;
    expect(state.fieldErrors.locality).toMatch(/lista/);
    expect(isCanonicalLocality).toHaveBeenCalledWith("AR-B", "La Plata");
    expect(sent).toEqual([]);
  });

  it("a refused send becomes the fallback-contact state", async () => {
    const { deps: d } = deps({ sendMail: async () => false });
    const state = await submitPilotRequest(form(), "ip", d);
    expect(state).toEqual({ status: "unavailable", message: PILOT_UNAVAILABLE_MESSAGE });
    expect(PILOT_UNAVAILABLE_MESSAGE).toContain(CONTACT_EMAILS.pilots);
  });

  it("logs the outcome and the organism type only — no personal data", async () => {
    const { deps: d, logs } = deps();
    await submitPilotRequest(form(), "ip", d);
    expect(logs).toEqual([["sent", "municipio"]]);
    const flat = JSON.stringify(logs);
    for (const pii of ["Ana", "municipio.example", "555", "Directora"]) {
      expect(flat).not.toContain(pii);
    }
  });
});
