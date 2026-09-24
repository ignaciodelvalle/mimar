// Validates the `next` parameter from DNI verification (and other auth
// redirects) to prevent open-redirect attacks. Review 2026-05-19 §2.4.
//
// Parses the raw value against a fixed local base and returns only
// `pathname + search + hash`. Anything that would change the origin
// (`//attacker.com`, `https://attacker.com`, `/\\attacker.com`,
// `/%2F%2Fattacker.com`, etc.) is discarded because the resulting URL's
// origin won't match the base. On any mismatch or parse failure, falls
// back to `/cuenta`.
//
// Exported (instead of file-local) so __tests__/dni-next.test.ts can
// exercise the function directly. The caller in app/actions/dni-verification.ts
// is the only production consumer today; if more redirect surfaces need
// this guard, import from here.

export function sanitizeNext(raw: string | null): string {
  if (!raw) return "/cuenta";
  const trimmed = raw.trim();
  if (!trimmed) return "/cuenta";
  // Reject encoded-slash bypasses (`%2F%2Fattacker.com`, `%5C%5Cattacker.com`).
  // Some browsers / HTTP clients decode `%2F` → `/` before evaluating the
  // redirect, which turns the input into a protocol-relative URL pointing
  // at a different origin. `URL` parsing alone does NOT collapse those —
  // pathname keeps them encoded — so a literal check on the raw input is
  // necessary.
  const lower = trimmed.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c")) return "/cuenta";
  // `URL` resolves `trimmed` against the base. Any value that escapes the
  // origin (protocol-relative URLs, absolute URLs, etc.) yields a URL whose
  // origin is NOT https://local.invalid, so we reject it.
  const BASE = "https://local.invalid";
  let parsed: URL;
  try {
    parsed = new URL(trimmed, BASE);
  } catch {
    return "/cuenta";
  }
  if (parsed.origin !== BASE) return "/cuenta";
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // Final belt-and-suspenders: require leading slash on the resolved path.
  return path.startsWith("/") ? path : "/cuenta";
}
