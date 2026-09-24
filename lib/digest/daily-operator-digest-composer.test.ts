// Pure composer tests — no DB, no network. Pins the PII boundary (T2-N1
// rule: label + count + a fixed portal link, nothing else) and the subject
// line's singular/plural agreement.

import { describe, expect, it } from "vitest";

import {
  type DigestQueueItem,
  composeDigestEmail,
  digestSubject,
  totalPendingCount,
} from "./daily-operator-digest-composer";

const ITEMS: DigestQueueItem[] = [
  { label: "Aprobaciones pendientes", count: 3, href: "https://mimar.com.ar/gob/cola" },
  {
    label: "Denuncias de maltrato derivadas",
    count: 1,
    href: "https://mimar.com.ar/org/abc123/maltrato/recibidos",
  },
];

describe("totalPendingCount", () => {
  it("sums every item's count", () => {
    expect(totalPendingCount(ITEMS)).toBe(4);
  });

  it("is 0 for an empty list", () => {
    expect(totalPendingCount([])).toBe(0);
  });
});

describe("digestSubject", () => {
  it("uses singular for exactly one pending item", () => {
    expect(digestSubject([{ label: "x", count: 1, href: "https://mimar.com.ar/x" }])).toBe(
      "1 pendiente te espera en miMAR",
    );
  });

  it("uses plural for more than one", () => {
    expect(digestSubject(ITEMS)).toBe("4 pendientes te esperan en miMAR");
  });
});

describe("composeDigestEmail", () => {
  const input = {
    sections: [{ recipientLabel: "gobierno" as const, items: ITEMS }],
    unsubscribeUrl: "https://mimar.com.ar/api/digest/unsubscribe?u=abc&t=xyz",
    accountUrl: "https://mimar.com.ar/cuenta",
  };
  const withItems = (items: DigestQueueItem[]) => ({
    ...input,
    sections: [{ recipientLabel: "gobierno" as const, items }],
  });

  it("carries the subject from digestSubject", () => {
    const { subject } = composeDigestEmail(input);
    expect(subject).toBe(digestSubject(ITEMS));
  });

  it("renders every item's label, count and href in both html and text", () => {
    const { html, text } = composeDigestEmail(input);
    for (const item of ITEMS) {
      expect(html).toContain(item.label);
      expect(html).toContain(String(item.count));
      expect(html).toContain(item.href);
      expect(text).toContain(item.label);
      expect(text).toContain(String(item.count));
      expect(text).toContain(item.href);
    }
  });

  it("carries the unsubscribe and account links in both html and text", () => {
    const { html, text } = composeDigestEmail(input);
    expect(html).toContain(input.unsubscribeUrl);
    expect(html).toContain(input.accountUrl);
    expect(text).toContain(input.unsubscribeUrl);
    expect(text).toContain(input.accountUrl);
  });

  it("PII BOUNDARY: the rendered output never carries anything beyond the {label, count, href} shape", () => {
    // Every word that appears in html/text must trace back to one of: a
    // queue label, a count, a URL, or the fixed template copy — never a
    // person's name, a pet's name, or free text. We assert this negatively:
    // no digit sequence appears that isn't one of the item counts (a stand-in
    // for "no DNI/phone leaked in") and no @ sign appears (no email address
    // embedded in the body itself — only in the SMTP envelope, which this
    // composer never sees).
    const { html, text } = composeDigestEmail(input);
    expect(html).not.toMatch(/@/);
    expect(text).not.toMatch(/@/);
  });

  it("es-AR greeting uses the recipient label", () => {
    const govt = composeDigestEmail(input);
    const org = composeDigestEmail({
      ...input,
      sections: [{ recipientLabel: "organización", items: ITEMS }],
    });
    expect(govt.html).toContain("Tu panel de gobierno");
    expect(org.html).toContain("Tu panel de organización");
  });

  it("L3: a govt operator who is also an org member gets BOTH panels in one mail", () => {
    const orgItems: DigestQueueItem[] = [
      { label: "Casos abiertos", count: 2, href: "https://mimar.com.ar/org/abc123/casos" },
    ];
    const { subject, html, text } = composeDigestEmail({
      ...input,
      sections: [
        { recipientLabel: "gobierno", items: ITEMS },
        { recipientLabel: "organización", items: orgItems },
      ],
    });
    for (const out of [html, text]) {
      expect(out).toContain("Tu panel de gobierno");
      expect(out).toContain("Tu panel de organización");
      expect(out).toContain("Casos abiertos");
      expect(out).toContain("Aprobaciones pendientes");
    }
    // The subject counts across both panels: 4 + 2.
    expect(subject).toBe("6 pendientes te esperan en miMAR");
    // Government first, in the order given.
    expect(html.indexOf("Tu panel de gobierno")).toBeLessThan(
      html.indexOf("Tu panel de organización"),
    );
  });

  it("escapes HTML-significant characters in a label (defense in depth)", () => {
    const { html } = composeDigestEmail(
      withItems([{ label: "<script>x</script>", count: 1, href: "https://mimar.com.ar/x" }]),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
