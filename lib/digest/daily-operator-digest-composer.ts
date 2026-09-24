// Pure composer for the daily operator digest email — no DB, no network, no
// Resend import. lib/infra/daily-operator-digest.ts resolves recipients and
// counts, then hands each one to `composeDigestEmail` here and sends the
// result. Kept pure and separate so the subject/body/PII-shape can be unit
// tested without a database.
//
// PII BOUNDARY (T2-N1 rule): the body may name a QUEUE LABEL (fixed catalog
// strings, e.g. "Aprobaciones pendientes") and a COUNT. It may never carry a
// person's name, a pet's name, a denuncia's free text, an address, a phone,
// or a DNI digit — those all live behind the portal link, which requires a
// session. `__tests__/daily-operator-digest-composer.test.ts` fences this by
// asserting the rendered HTML/text never contains a value outside the
// {label, count} shape.

import { pluralizeEs } from "@/lib/utils/format";

/** One row in the digest: a queue this operator can act on right now. */
export type DigestQueueItem = {
  /** es-AR label, taken verbatim from the queue catalog (never re-typed). */
  label: string;
  /** Always > 0 — a zero-count queue is filtered out before reaching here. */
  count: number;
  /** Absolute portal URL (already resolved via resolveSiteUrl / orgToken). */
  href: string;
};

/**
 * One panel's worth of queues. A user who is BOTH a govt operator and an org
 * member gets ONE mail with one section per panel (security review
 * 2026-09-18, L3) — never two mails the same morning.
 */
export type DigestSection = {
  /** es-AR display name for the panel — drives the section's lead line. */
  recipientLabel: "gobierno" | "organización";
  items: readonly DigestQueueItem[];
};

export type ComposeDigestInput = {
  /** Non-empty; rendered in the order given. */
  sections: readonly DigestSection[];
  /** Absolute unsubscribe URL — works without login (signed token). */
  unsubscribeUrl: string;
  /** Absolute /cuenta URL — the alternative the mail also offers. */
  accountUrl: string;
};

export type ComposedDigestEmail = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Total pending items across every queue row — the number the subject leads with. */
export function totalPendingCount(items: readonly DigestQueueItem[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

export function digestSubject(items: readonly DigestQueueItem[]): string {
  const total = totalPendingCount(items);
  return `${total} ${pluralizeEs(total, "pendiente")} te ${pluralizeEs(total, "espera", "esperan")} en miMAR`;
}

function sectionHtml(section: DigestSection): string {
  const rowsHtml = section.items
    .map(
      (item) => `
            <tr>
              <td style="padding:6px 0;color:#1a1a1a;">${escapeHtml(item.label)}</td>
              <td style="padding:6px 0;text-align:right;font-weight:600;">${item.count}</td>
              <td style="padding:6px 0 6px 12px;"><a href="${escapeHtml(item.href)}">Ver</a></td>
            </tr>`,
    )
    .join("");
  return `
    <p>Tu panel de ${section.recipientLabel} en miMAR tiene pendientes:</p>
    <table style="border-collapse:collapse;width:100%;max-width:480px;">
      ${rowsHtml}
    </table>`;
}

function sectionText(section: DigestSection): string {
  const rows = section.items.map((item) => `- ${item.label}: ${item.count} — ${item.href}`);
  return [`Tu panel de ${section.recipientLabel} en miMAR tiene pendientes:`, "", ...rows].join(
    "\n",
  );
}

/**
 * Composes the digest subject/html/text for one recipient. `sections` must be
 * non-empty and every count > 0 — the caller (daily-operator-digest.ts) never
 * sends a zero-total digest, and this function does not defend against it
 * beyond producing an honest (if useless) empty list.
 */
export function composeDigestEmail(input: ComposeDigestInput): ComposedDigestEmail {
  const { sections, unsubscribeUrl, accountUrl } = input;
  const subject = digestSubject(sections.flatMap((s) => s.items));

  const html = `
    <p>Hola,</p>
    ${sections.map(sectionHtml).join("\n")}
    <p style="margin-top:16px;">
      <a href="${accountUrl}">Ir a miMAR</a>
    </p>
    <p style="margin-top:24px;font-size:12px;color:#666;">
      Recibís este correo porque tu cuenta institucional tiene pendientes en miMAR.
      <a href="${unsubscribeUrl}">Dejar de recibir este resumen diario</a>
      o gestionalo desde <a href="${accountUrl}">tu cuenta</a>.
    </p>
  `.trim();

  const text = [
    "Hola,",
    "",
    sections.map(sectionText).join("\n\n"),
    "",
    `Ir a miMAR: ${accountUrl}`,
    "",
    "Recibís este correo porque tu cuenta institucional tiene pendientes en miMAR.",
    `Dejar de recibir este resumen diario: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
}
