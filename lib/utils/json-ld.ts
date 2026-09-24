// Serialize a JSON-LD object for safe embedding inside a
// <script type="application/ld+json"> tag.
//
// JSON.stringify alone is unsafe: user-controlled free-text (pet names, adoption
// stories, org names/descriptions) can contain "</script>" or the JS line
// separators U+2028/U+2029, breaking out of the inline script (stored XSS).
// HTML-entity escaping is wrong here — the payload is parsed as JSON, not HTML —
// so we emit JSON-safe unicode escapes for the HTML-significant characters. The
// output still parses back to the original object (< is a valid JSON escape).
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}
