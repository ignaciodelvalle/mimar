"use server";

// Organization access request (critique 2026-09-29, M8). A thin shim: every
// rule lives in lib/outreach/org-access-request.ts, which takes its side
// effects as arguments; this file only wires the real ones. One export, an
// async function (scripts/check-server-action-exports.ts).

import { headers } from "next/headers";

import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { type OrgAccessState, submitOrgAccessRequest } from "@/lib/outreach/org-access-request";
import { sendOutreachMail } from "@/lib/outreach/send-outreach-mail";
import { resolveName } from "@/lib/place/resolve-place";

const LOG_CONTEXT = "[organizaciones/solicitar-acceso]";

async function requestIp(): Promise<string> {
  try {
    return callerIp(await headers());
  } catch {
    return "unknown";
  }
}

/** A catalogue name of that province: one row, or homonyms of the same name. */
async function isKnownLocality(provinceCode: string, localityName: string): Promise<boolean> {
  const place = await resolveName(provinceCode, localityName);
  return place.status !== "unresolved";
}

// @no-auth-required: public access-request form for organizations that have no account yet; abuse-controlled by a honeypot plus per-IP and global rate limits (enforceRateLimit), and it only ever mails our own general mailbox. Nothing is stored.
export async function requestOrgAccessAction(
  _previous: OrgAccessState,
  formData: FormData,
): Promise<OrgAccessState> {
  return submitOrgAccessRequest(formData, await requestIp(), {
    enforceRateLimit,
    isRateLimitError: (err) => err instanceof RateLimitError,
    isKnownLocality,
    sendMail: (mail) => sendOutreachMail(mail, LOG_CONTEXT),
    log: (outcome, orgType) => console.info(`${LOG_CONTEXT} ${outcome}`, orgType ?? "unknown-type"),
  });
}
