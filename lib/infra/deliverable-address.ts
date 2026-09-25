// `isDeliverableAddress` — may we hand this address to the mail provider at all?
//
// WHY. Seed and fixture accounts live on reserved top-level domains
// (`@dim.test`, `@example.com`-style `.example`). On staging those accounts are
// real rows, so every mail our code sends them — the daily operator digest
// first among them — is accepted by Resend, bounces, and counts against the
// sending domain's reputation. The mail was never going to reach anybody.
//
// WHAT IS REFUSED: exactly the four TLDs the IETF reserves as never resolvable
// — `.test`, `.example`, `.invalid` (RFC 2606) and `.localhost` (RFC 6761) —
// the three second-level names RFC 2606 §3 reserves for documentation
// (`example.com`, `example.net`, `example.org`, and their subdomains), and
// anything that is not shaped like `local@domain` at all. NOTHING ELSE.
// A real mailbox must never be dropped by this function, so it deliberately
// does not try to validate addresses beyond that; the provider does that job.
//
// SCOPE. There is no single mail-sending chokepoint in this codebase: each
// sender builds its own Resend client. Every sender that mails a stored or
// typed address calls this before `emails.send`. Supabase Auth's own mails
// (confirmations, recovery OTPs) do not go through our code and are out of scope.

const RESERVED_TLDS: ReadonlySet<string> = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];

export function isDeliverableAddress(address: string | null | undefined): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  // A trailing dot is the fully-qualified spelling of the same domain.
  const domain = trimmed
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.+$/, "");
  if (domain === "") return false;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(tld)) return false;
  return !RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}
