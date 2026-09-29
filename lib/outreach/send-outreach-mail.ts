// Sends one outreach mail — a public form's message to one of our own
// mailboxes — through Resend, the same path as every other outbound mail.
//
// Shared by the /municipios pilot request and the organization access request
// (app/municipios/actions.ts, app/(public)/organizaciones/solicitar-acceso/
// actions.ts); it used to live inside the first one.
//
// Refuses up front when the sender is the provider's shared test address: that
// sender can only reach the account owner, so a send to our own mailbox would
// be refused anyway, and the person should see the fallback contact now.
// Logs name the failure, never the requester.

import { resolveMailSender, senderIsProviderFallback } from "@/lib/infra/outbound-channels";

export type OutreachMail = {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendOutreachMail(mail: OutreachMail, logContext: string): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = resolveMailSender(process.env);
  if (!apiKey || senderIsProviderFallback(from)) {
    console.warn(`${logContext} mail channel not configured; request not sent`);
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
      console.error(`${logContext} provider refused the send`, error.name);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`${logContext} send threw`, e instanceof Error ? e.name : "unknown");
    return false;
  }
}
