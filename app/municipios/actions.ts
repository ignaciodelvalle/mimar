"use server";

// Pilot-request action for /municipios (WU6). A thin shim: every rule lives in
// lib/outreach/pilot-request.ts, which takes its side effects as arguments;
// this file only wires the real ones. Only one export, and it is an async
// function — a "use server" module may export nothing else
// (scripts/check-server-action-exports.ts).

import { headers } from "next/headers";

import { isCanonicalLocality } from "@/lib/infra/ar-localidades";
import { resolveMailSender, senderIsProviderFallback } from "@/lib/infra/outbound-channels";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import {
  type PilotMail,
  type PilotRequestState,
  submitPilotRequest,
} from "@/lib/outreach/pilot-request";

const LOG_CONTEXT = "[municipios/pilot-request]";

async function requestIp(): Promise<string> {
  try {
    return callerIp(await headers());
  } catch {
    return "unknown";
  }
}

/**
 * Sends through Resend, the same path as every other outbound mail. Refuses
 * up front when the sender is the provider's shared test address: that sender
 * can only reach the account owner, so a send to our pilots mailbox would be
 * refused anyway, and the person should see the fallback contact now.
 */
async function sendPilotMail(mail: PilotMail): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = resolveMailSender(process.env);
  if (!apiKey || senderIsProviderFallback(from)) {
    console.warn(`${LOG_CONTEXT} mail channel not configured; request not sent`);
    return false;
  }
  try {
    const { Resend } = await import("resend");
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (error) {
      // The provider's error names the failure, never the requester.
      console.error(`${LOG_CONTEXT} provider refused the send`, error.name);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`${LOG_CONTEXT} send threw`, e instanceof Error ? e.name : "unknown");
    return false;
  }
}

// @no-auth-required: public pilot-request form on /municipios for officials who have no account yet; abuse-controlled by a honeypot plus per-IP and global rate limits (enforceRateLimit), and it only ever mails our own pilots mailbox.
export async function requestPilotAction(
  _previous: PilotRequestState,
  formData: FormData,
): Promise<PilotRequestState> {
  return submitPilotRequest(formData, await requestIp(), {
    enforceRateLimit,
    isRateLimitError: (err) => err instanceof RateLimitError,
    isCanonicalLocality,
    sendMail: sendPilotMail,
    log: (outcome, organismType) =>
      console.info(`${LOG_CONTEXT} ${outcome}`, organismType ?? "unknown-type"),
  });
}
