/**
 * The Resend inbound webhook: mail written to a published mailbox reaches a
 * person, and nothing else does.
 *
 * What is pinned here is not "returns 200". It is the trust model: the body is
 * read for `type` and `data.email_id` only, the decision is made on the
 * re-fetched email, the allowlist is CONTACT_EMAILS, and the logs never carry
 * who wrote or what about.
 */

import { createHmac } from "node:crypto";

import type { NextRequest } from "next/server";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const receivingGet = vi.fn();
const emailsSend = vi.fn();
/** Which API key each network call was made with: `${operation}:${key}`. */
const keyUsed = vi.fn<(call: string) => void>();

// Only the network calls are faked. `webhooks.verify` is the REAL Svix check,
// so the signature test proves the wiring and not a mock's opinion of it.
vi.mock("resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("resend")>();
  class FakeResend {
    readonly webhooks: InstanceType<typeof actual.Resend>["webhooks"];
    readonly emails: {
      receiving: { get: (...args: unknown[]) => unknown };
      send: (...args: unknown[]) => unknown;
    };
    constructor(key: string) {
      this.webhooks = new actual.Resend(key).webhooks;
      this.emails = {
        receiving: {
          get: (...args: unknown[]) => {
            keyUsed(`get:${key}`);
            return receivingGet(...args);
          },
        },
        send: (...args: unknown[]) => {
          keyUsed(`send:${key}`);
          return emailsSend(...args);
        },
      };
    }
  }
  return { ...actual, Resend: FakeResend };
});

const reportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { POST } from "@/app/api/webhooks/resend-inbound/route";
import {
  FORWARD_SENDER,
  __resetInboundMailStateForTests,
  isOnInboundDomain,
  matchPublishedMailbox,
} from "@/lib/infra/inbound-mail";
import { CONTACT_EMAILS, PRIMARY_MAIL_DOMAIN } from "@/lib/ui/contact";

const SENDER = "Vecina Preocupada <vecina.secreta@example.org>";
const SUBJECT = "Quiero borrar mis datos de la mascota Firulais";
const FORWARD_TO = "operador@example.net";
const SECRET_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${SECRET_KEY.toString("base64")}`;

function event(emailId = "em_1", type = "email.received") {
  return JSON.stringify({ type, created_at: "2026-09-24T00:00:00Z", data: { email_id: emailId } });
}

function post(raw: string, headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost:3000/api/webhooks/resend-inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  }) as unknown as NextRequest;
}

function signed(raw: string, key: Buffer = SECRET_KEY): Record<string, string> {
  const id = "msg_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` };
}

function fetchedEmail(to: string[], extra: Record<string, unknown> = {}) {
  return {
    data: {
      object: "email",
      id: "em_1",
      to,
      from: SENDER,
      created_at: "2026-09-24T00:00:00Z",
      subject: SUBJECT,
      bcc: null,
      cc: null,
      reply_to: null,
      html: null,
      text: "Hola, soy la duena de Firulais.",
      headers: null,
      message_id: "<m@example.org>",
      raw: null,
      attachments: [],
      ...extra,
    },
    error: null,
    headers: null,
  };
}

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
  __resetInboundMailStateForTests();
  receivingGet.mockReset();
  emailsSend.mockReset();
  keyUsed.mockReset();
  vi.stubEnv("RESEND_INBOUND_API_KEY", "re_inbound_key");
  reportError.mockReset();
  emailsSend.mockResolvedValue({ data: { id: "sent_1" }, error: null, headers: null });
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
  vi.stubEnv("MAIL_FORWARD_TO", FORWARD_TO);
  vi.stubEnv("VERCEL_ENV", "");
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function everythingLogged(): string {
  return JSON.stringify([
    info.mock.calls,
    warn.mock.calls,
    error.mock.calls,
    reportError.mock.calls.map((c) => [c[0], String(c[1]), c[2]]),
  ]);
}

describe("signature", () => {
  it("rejects a bad signature with 401 when the secret is set, without fetching", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const raw = event();
    const res = await POST(post(raw, signed(raw, Buffer.from("not-the-secret-not-the-secret!!"))));
    expect(res.status).toBe(401);
    expect(receivingGet).not.toHaveBeenCalled();
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("rejects a request with no signature headers when the secret is set", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const res = await POST(post(event()));
    expect(res.status).toBe(401);
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("accepts a valid signature and forwards", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    const raw = event();
    const res = await POST(post(raw, signed(raw)));
    expect(res.status).toBe(200);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("warns once, not per request, when no secret is configured", async () => {
    receivingGet.mockResolvedValue(fetchedEmail(["nadie@example.org"]));
    await POST(post(event("em_a")));
    await POST(post(event("em_b")));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("event filtering", () => {
  it("ignores non-email.received types without fetching", async () => {
    const res = await POST(post(event("em_1", "email.delivered")));
    expect(res.status).toBe(200);
    expect(receivingGet).not.toHaveBeenCalled();
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("answers 200 to a body that is not JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(200);
    expect(receivingGet).not.toHaveBeenCalled();
  });
});

describe("allowlist", () => {
  it.each([
    ["privacidad@", [CONTACT_EMAILS.privacy], "privacidad"],
    ["hola@", [CONTACT_EMAILS.general], "hola"],
    ["contacto@", [CONTACT_EMAILS.pilots], "contacto"],
    [
      "a +tag with different casing",
      [`Privacidad+Baja@${PRIMARY_MAIL_DOMAIN.toUpperCase()}`],
      "privacidad",
    ],
    ["a display-name recipient", [`"miMAR" <HOLA@${PRIMARY_MAIL_DOMAIN}>`], "hola"],
  ])("forwards mail addressed to %s", async (_label, to, tag) => {
    receivingGet.mockResolvedValue(fetchedEmail(to));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(receivingGet).toHaveBeenCalledWith("em_1");
    expect(emailsSend).toHaveBeenCalledTimes(1);
    const [payload, options] = emailsSend.mock.calls[0];
    expect(payload.to).toEqual([FORWARD_TO]);
    expect(payload.from).toMatch(new RegExp(`@${PRIMARY_MAIL_DOMAIN.replaceAll(".", "\\.")}>$`));
    expect(payload.subject).toBe(`[${tag}] ${SUBJECT}`);
    // The original sender stays answerable.
    expect(payload.replyTo).toEqual([SENDER]);
    expect(payload.text).toContain("Hola, soy la duena de Firulais.");
    expect(options).toEqual({ idempotencyKey: "inbound-forward/em_1" });
  });

  it("matches a published mailbox found only in cc", async () => {
    receivingGet.mockResolvedValue(
      fetchedEmail(["otro@example.org"], { cc: [CONTACT_EMAILS.privacy] }),
    );
    await POST(post(event()));
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("drops spam to an invented address on our domain without forwarding", async () => {
    receivingGet.mockResolvedValue(fetchedEmail([`miguel@${PRIMARY_MAIL_DOMAIN}`]));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("dropped-unlisted");
  });

  it("does not treat a lookalike domain as ours", () => {
    expect(matchPublishedMailbox([`privacidad@${PRIMARY_MAIL_DOMAIN}.evil.test`])).toBeNull();
    expect(matchPublishedMailbox([`privacidad@evil-${PRIMARY_MAIL_DOMAIN}`])).toBeNull();
  });

  it("the allowlist is exactly CONTACT_EMAILS", () => {
    expect(Object.keys(CONTACT_EMAILS).sort()).toEqual(["general", "pilots", "privacy"]);
    for (const address of Object.values(CONTACT_EMAILS)) {
      expect(matchPublishedMailbox([address])).not.toBeNull();
    }
  });
});

describe("failure modes", () => {
  it("an unknown id (get returns 404) forwards nothing and answers 2xx", async () => {
    receivingGet.mockResolvedValue({
      data: null,
      error: { name: "not_found", message: "Email not found", statusCode: 404 },
      headers: null,
    });
    const res = await POST(post(event("em_forged")));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("a transient error on the re-fetch answers 5xx so Resend retries", async () => {
    receivingGet.mockResolvedValue({
      data: null,
      error: { name: "internal_server_error", message: "boom", statusCode: 500 },
      headers: null,
    });
    const res = await POST(post(event()));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("MAIL_FORWARD_TO unset: no forward, error reported, 200", async () => {
    vi.stubEnv("MAIL_FORWARD_TO", "");
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0][1])).toContain("MAIL_FORWARD_TO");
  });

  it("refuses to forward into the inbound domain itself (a loop)", async () => {
    vi.stubEnv("MAIL_FORWARD_TO", CONTACT_EMAILS.general);
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a duplicate email_id forwards once", async () => {
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    const first = await POST(post(event("em_dup")));
    const second = await POST(post(event("em_dup")));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("a transient forward error answers 5xx, and the retry can still forward", async () => {
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    emailsSend.mockResolvedValueOnce({
      data: null,
      error: { name: "rate_limit_exceeded", message: "slow down", statusCode: 429 },
      headers: null,
    });
    const res = await POST(post(event("em_retry")));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const retry = await POST(post(event("em_retry")));
    expect(retry.status).toBe(200);
    expect(emailsSend).toHaveBeenCalledTimes(2);
  });

  it("a permanent (4xx) forward rejection is reported and answered 200", async () => {
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    emailsSend.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", message: "too big", statusCode: 422 },
      headers: null,
    });
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("attaches the original message as .eml when Resend offers the raw download", async () => {
    const rawFetch = vi.fn(async () => new Response("From: x\r\n\r\nbody"));
    vi.stubGlobal("fetch", rawFetch);
    receivingGet.mockResolvedValue(
      fetchedEmail([CONTACT_EMAILS.privacy], {
        raw: { download_url: "https://raw.example/em_1", expires_at: "2026-09-25T00:00:00Z" },
      }),
    );
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    const [payload] = emailsSend.mock.calls[0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].contentType).toBe("message/rfc822");
  });
});

const RAW = { download_url: "https://raw.example/em_1", expires_at: "2026-09-25T00:00:00Z" };

describe("hardening (security review of 086e293ab)", () => {
  it("fails closed in production with no webhook secret, before any Resend call", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await POST(post(event()));
    expect(res.status).toBe(401);
    expect(receivingGet).not.toHaveBeenCalled();
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("still proceeds unsigned outside production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared body over the cap with 413 before reading it", async () => {
    const res = await POST(post(event(), { "content-length": String(10 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("refuses an actual body over the cap with 413 even without a declared length", async () => {
    const huge = JSON.stringify({
      type: "email.received",
      data: { email_id: "x".repeat(300_000) },
    });
    const res = await POST(post(huge));
    expect(res.status).toBe(413);
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("the forward is plain text we wrote: no html, a banner naming the original From", async () => {
    receivingGet.mockResolvedValue(
      fetchedEmail([CONTACT_EMAILS.privacy], {
        html: '<a href="https://phish.example">Tribunal</a>',
      }),
    );
    await POST(post(event()));
    const [payload] = emailsSend.mock.calls[0];
    expect(payload).not.toHaveProperty("html");
    expect(payload.text.split("\n")[0]).toBe(
      `Correo externo recibido en ${CONTACT_EMAILS.privacy}. Remitente original: ${SENDER}. Verificá antes de hacer clic.`,
    );
    expect(payload.text).not.toContain("phish.example");
  });

  it("truncates a very long original text part", async () => {
    receivingGet.mockResolvedValue(
      fetchedEmail([CONTACT_EMAILS.privacy], { text: "a".repeat(100_000) }),
    );
    await POST(post(event()));
    const [payload] = emailsSend.mock.calls[0];
    expect(payload.text.length).toBeLessThan(21_000);
    expect(payload.text).toContain("texto recortado");
  });

  it("strips CR/LF and control characters from the subject before tagging", async () => {
    receivingGet.mockResolvedValue(
      fetchedEmail([CONTACT_EMAILS.privacy], { subject: "Hola\r\nBcc: x@evil.test\u0000 fin" }),
    );
    await POST(post(event()));
    const [payload] = emailsSend.mock.calls[0];
    expect(payload.subject).toBe("[privacidad] Hola Bcc: x@evil.test fin");
  });

  it("an .eml declared over 15 MB is left out, and the text says where the original is", async () => {
    const rawFetch = vi.fn(
      async () => new Response("x", { headers: { "content-length": String(16 * 1024 * 1024) } }),
    );
    vi.stubGlobal("fetch", rawFetch);
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy], { raw: RAW }));
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    const [payload] = emailsSend.mock.calls[0];
    expect(payload).not.toHaveProperty("attachments");
    expect(payload.text).toContain("Resend → Emails → Receiving");
  });

  it("an .eml that overruns the cap while streaming (no declared length) is left out", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy], { raw: RAW }));
    await POST(post(event()));
    const [payload] = emailsSend.mock.calls[0];
    expect(payload).not.toHaveProperty("attachments");
    expect(payload.text).toContain("Resend → Emails → Receiving");
  });

  it("a 4xx on a send with the .eml is reported and retried once without it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("From: x\r\n\r\nbody")),
    );
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy], { raw: RAW }));
    emailsSend.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", message: "attachment", statusCode: 422 },
      headers: null,
    });
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(emailsSend).toHaveBeenCalledTimes(2);
    const [retry, retryOptions] = emailsSend.mock.calls[1];
    expect(retry).not.toHaveProperty("attachments");
    expect(retry.text).toContain("Resend → Emails → Receiving");
    expect(retryOptions).toEqual({ idempotencyKey: "inbound-forward/em_1/sin-adjunto" });
  });

  it("drops our own forward coming back (From is the forward sender)", async () => {
    receivingGet.mockResolvedValue(
      fetchedEmail([CONTACT_EMAILS.privacy], { from: FORWARD_SENDER }),
    );
    const res = await POST(post(event()));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("refuses MAIL_FORWARD_TO on a subdomain of the inbound domain", async () => {
    vi.stubEnv("MAIL_FORWARD_TO", `buzon@sub.${PRIMARY_MAIL_DOMAIN}`);
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    await POST(post(event()));
    expect(emailsSend).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("isOnInboundDomain matches the domain and its subdomains, not lookalikes", () => {
    expect(isOnInboundDomain(`a@${PRIMARY_MAIL_DOMAIN}`)).toBe(true);
    expect(isOnInboundDomain(`a@mail.${PRIMARY_MAIL_DOMAIN}`)).toBe(true);
    expect(isOnInboundDomain(`a@evil${PRIMARY_MAIL_DOMAIN}`)).toBe(false);
    expect(isOnInboundDomain("a@example.net")).toBe(false);
  });
});

describe("two keys: full-access for receiving, sending-only for the forward", () => {
  it("reads with RESEND_INBOUND_API_KEY and sends with RESEND_API_KEY", async () => {
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.general]));
    await POST(post(event()));
    expect(keyUsed.mock.calls.map((c) => c[0])).toEqual(["get:re_inbound_key", "send:re_test_key"]);
  });

  it("unset inbound key in production: no Resend call, error reported, 200", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("RESEND_INBOUND_API_KEY", "");
    const raw = event();
    const res = await POST(post(raw, signed(raw)));
    expect(res.status).toBe(200);
    expect(keyUsed).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0][1])).toContain("RESEND_INBOUND_API_KEY");
  });

  it("a 403 from the receiving API is reported as a config error, not logged as not-found", async () => {
    receivingGet.mockResolvedValue({
      data: null,
      error: { name: "restricted_api_key", message: "sending access only", statusCode: 403 },
      headers: null,
    });
    const res = await POST(post(event("em_real")));
    expect(res.status).toBe(200);
    expect(emailsSend).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0][1])).toContain("RESEND_INBOUND_API_KEY");
    const logged = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("not-found");
    expect(logged).toContain("misconfigured");
  });

  it("a genuine 404 is still not-found and is not reported", async () => {
    receivingGet.mockResolvedValue({
      data: null,
      error: { name: "not_found", message: "Email not found", statusCode: 404 },
      headers: null,
    });
    await POST(post(event("em_forged")));
    expect(reportError).not.toHaveBeenCalled();
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("not-found");
  });
});

describe("log privacy", () => {
  it("nothing logged across every path contains the sender or the subject", async () => {
    // forwarded
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.privacy]));
    await POST(post(event("em_log_1")));
    // dropped
    receivingGet.mockResolvedValue(fetchedEmail([`framirez@${PRIMARY_MAIL_DOMAIN}`]));
    await POST(post(event("em_log_2")));
    // misconfigured
    vi.stubEnv("MAIL_FORWARD_TO", "");
    receivingGet.mockResolvedValue(fetchedEmail([CONTACT_EMAILS.general]));
    await POST(post(event("em_log_3")));

    const logged = everythingLogged();
    expect(info).toHaveBeenCalled();
    expect(logged).toContain("em_log_1");
    for (const secret of [
      "vecina.secreta",
      "Vecina Preocupada",
      "Firulais",
      "framirez",
      "privacidad@",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
