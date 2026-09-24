// Escape a value for safe interpolation into an HTML string (e.g. MapLibre
// popup `setHTML`). Prevents stored/reflected XSS when DB free-text — org names,
// pet names, locality labels, etc. — is rendered into map popups. Escapes the
// five HTML-significant characters; `&` first so the others don't double-encode.
//
// Prefer this over interpolating raw values into `setHTML`. For non-HTML sinks
// (text nodes) the browser already escapes; this is specifically for innerHTML.
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
