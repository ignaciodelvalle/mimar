"use server";

// Pilot-request action for /municipios (WU6). A thin shim: every rule lives in
// lib/outreach/pilot-request.ts, which takes its side effects as arguments;
// this file only wires the real ones. Only one export, and it is an async
// function — a "use server" module may export nothing else
// (scripts/check-server-action-exports.ts).
//
// The Resend send moved to lib/outreach/send-outreach-mail.ts (2026-09-29) so
// the organization access request can share it.

import { headers } from "next/headers";

import { isCanonicalLocality } from "@/lib/infra/ar-localidades";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { type PilotRequestState, submitPilotRequest } from "@/lib/outreach/pilot-request";
import { sendOutreachMail } from "@/lib/outreach/send-outreach-mail";

const LOG_CONTEXT = "[municipios/pilot-request]";

async function requestIp(): Promise<string> {
  try {
    return callerIp(await headers());
  } catch {
    return "unknown";
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
    sendMail: (mail) => sendOutreachMail(mail, LOG_CONTEXT),
    log: (outcome, organismType) =>
      console.info(`${LOG_CONTEXT} ${outcome}`, organismType ?? "unknown-type"),
  });
}
