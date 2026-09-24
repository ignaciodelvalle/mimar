// Tests for the client error-report redaction layer (task #56b).
//
// These are the tests that decide whether it is safe to point this seam at a
// third party at all. Each one carries a real PII shape from this product's
// domain, not a synthetic placeholder.

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_PATH_SEGMENTS,
  CREDENTIAL_TOKEN_PREFIXES,
  redactContextValue,
  redactText,
} from "@/lib/observability/redact";

describe("redactText — the four shapes the privacy checklist names", () => {
  it("removes an Argentine DNI (8 digits) from an error message", () => {
    const out = redactText("no se encontró el titular con documento 30123456");

    expect(out).not.toContain("30123456");
    expect(out).toContain("[redacted:digits]");
  });

  it("removes a 7-digit DNI too (the short end of the Argentine space)", () => {
    const out = redactText("dni=4123456 rejected");

    expect(out).not.toContain("4123456");
  });

  it("removes a DIM pet public token", () => {
    const out = redactText("failed to load credential DIM-BOBB-0022");

    expect(out).not.toContain("DIM-BOBB-0022");
    expect(out).toContain("[redacted:credential]");
  });

  it("removes CAS- and DEN- product codes as well", () => {
    const out = redactText("caso CAS-A1B2-C3D4 y denuncia DEN-9Z8Y-7X6W");

    expect(out).not.toContain("CAS-A1B2-C3D4");
    expect(out).not.toContain("DEN-9Z8Y-7X6W");
  });

  it.each(CREDENTIAL_TOKEN_PREFIXES)(
    "redacts a %s token wherever it appears, not only inside a URL path",
    (prefix) => {
      // The hole this closes: the rule used to cover three prefixes out of the
      // twelve this repo mints, so nine classes of citizen token rode to a
      // third party in cleartext. Bare free text, deliberately — a token
      // interpolated into an error message has no path around it to save it.
      const token = `${prefix}A1B2-C3D4`;
      const out = redactText(`no se pudo resolver ${token} en el padrón`);

      expect(out).not.toContain(token);
      expect(out).toContain("[redacted:credential]");
    },
  );

  it("redacts a care-grant token, which no PREFIX-XXXX-XXXX rule matches", () => {
    // `CG-` + 32 hex (caretakers-repository.ts). Different shape from every
    // other token in the product; the page it opens shows a pet's name, photo
    // and the titular's display name to whoever holds the link.
    const grant = "CG-3f2a91b7c04d48e5a6b1d90f27e35c81";
    const out = redactText(`grant ${grant} expirado`);

    expect(out).not.toContain(grant);
    expect(out).toContain("[redacted:grant]");
  });

  it("removes an email address", () => {
    const out = redactText("owner persona.ejemplo+dim@example.com could not be notified");

    expect(out).not.toContain("persona.ejemplo+dim@example.com");
    expect(out).not.toContain("example.com");
    expect(out).toContain("[redacted:email]");
  });

  it("removes an Argentine phone number in international form", () => {
    const out = redactText("contacto de emergencia +54 9 11 1234-5678 no responde");

    expect(out).not.toContain("1234-5678");
    expect(out).toContain("[redacted:phone]");
  });

  it("removes a bare 10-digit local phone number", () => {
    const out = redactText("tel 1123456789 invalido");

    expect(out).not.toContain("1123456789");
  });

  it.each([["12.345.678"], ["1.234.567"]])("removes a DNI written with dots: %s", (dni) => {
    // Three runs of 1-3 digits: under the catch-all's 7-digit floor, so this
    // needs its own rule — and it is how a DNI is written on every paper form.
    expect(redactText(`DNI ${dni} no coincide`)).toBe("DNI [redacted:dni] no coincide");
  });

  it.each([
    ["11-1234-5678"],
    ["11 1234 5678"],
    ["011 4567-8901"],
    ["(011) 4567-8901"],
    ["0351 456-7890"],
    ["2966 42-1234"],
    ["11 15 1234-5678"],
  ])("removes a local phone written with separators: %s", (phone) => {
    // No `+`, so the international rule misses it, and no run of 7+ digits is
    // left for the catch-all. A bite victim's number is typed exactly so.
    expect(redactText(`contacto ${phone} no atiende`)).toBe("contacto [redacted:phone] no atiende");
  });
});

describe("redactText — tokens that ARE the authorization", () => {
  it("removes a libreta share token in its REAL shape", () => {
    // This test used to pass `s7Kd93ptQxLm`, which is not a shape this product
    // ever mints. A libreta share token is `LBR-XXXX-XXXX`
    // (`generateLibretaShareToken`). The fake shape was load-bearing in the
    // wrong direction: it proved the PATH rule fired, so nobody noticed that
    // LBR was absent from the credential-prefix rule, and a share token quoted
    // in an error message with no path around it went out in cleartext.
    const out = redactText("GET /libreta/compartir/LBR-7K2M-9QXD failed with 500");

    expect(out).not.toContain("LBR-7K2M-9QXD");
  });

  it("removes an unrecognised token under a capability path segment", () => {
    // The path rule's own job, kept pinned independently of the credential
    // rule: a value whose shape nothing enumerated is still redacted because
    // of WHERE it sits. Without this, dropping a segment from the list would
    // go unnoticed for every token that some other rule happens to catch.
    const out = redactText("GET /libreta/compartir/s7Kd93ptQxLm failed with 500");

    expect(out).not.toContain("s7Kd93ptQxLm");
    expect(out).toContain("[redacted:token]");
  });

  it("removes an org portal token from a homeHref-shaped path", () => {
    const out = redactText("/org/9f3kd82hsn2p");

    expect(out).not.toContain("9f3kd82hsn2p");
  });

  it.each(CAPABILITY_PATH_SEGMENTS)("redacts an unknown-shaped token under /%s/", (segment) => {
    // Deliberately a shape no credential rule recognises. Testing these with
    // a real `DEN-`/`INV-` code proves nothing about the PATH rule — the
    // credential rule catches those first, so dropping the segment leaves
    // the suite green. That is the same blind spot that let the libreta
    // share-token test pass while LBR was missing from the prefix list.
    //
    // Removing a segment shrinks this `it.each` rather than failing it;
    // what makes removal loud is the router-derived fence in
    // `redact-prefix-coverage.test.ts`. The two are a pair.
    const out = redactText(`GET /${segment}/s7Kd93ptQxLm failed`);

    expect(out).not.toContain("s7Kd93ptQxLm");
    expect(out).toContain(`/${segment}/[redacted:token]`);
  });

  it("redacts the anonymous denuncia code, a reporter's only key", () => {
    // `/denuncias/codigo/[code]` — an anonymous reporter has no account and no
    // other way back to their case. Belt and braces: the credential rule gets
    // this one, the path rule would too.
    const out = redactText("GET /denuncias/codigo/DEN-773H-6FXT 404");

    expect(out).not.toContain("DEN-773H-6FXT");
  });

  it("redacts an org invitation token, where holding the link grants membership", () => {
    const out = redactText("GET /r/invite/INV-8HQP-2WKM expired");

    expect(out).not.toContain("INV-8HQP-2WKM");
  });

  it("removes a Supabase JWT, signature included", () => {
    const signature = "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.${signature}`;
    const out = redactText(`fetch failed: ${jwt}`);

    expect(out).not.toContain(jwt);
    // The signature specifically. Matching only `header.payload` would leave
    // the half that makes the token forgeable trailing in cleartext, while
    // `not.toContain(jwt)` still passed.
    expect(out).not.toContain(signature);
    expect(out).toContain("[redacted:jwt]");
  });

  it("removes an Authorization header echoed into a message", () => {
    const out = redactText("401 with header Bearer sk_live_9aB7cD2eF4gH6jK8");

    expect(out).not.toContain("sk_live_9aB7cD2eF4gH6jK8");
    expect(out).toContain("[redacted:authorization]");
  });

  it("keeps a sensitive query key but drops its value", () => {
    const out = redactText("navigation to /verificar?access_token=abc123XYZdef&page=2 threw");

    expect(out).not.toContain("abc123XYZdef");
    expect(out).toContain("access_token=[redacted]");
    // Non-sensitive params stay — the shape of the failing request is signal.
    expect(out).toContain("page=2");
  });
});

describe("redactText — rule ORDER is load-bearing, not stylistic", () => {
  it("labels an unseparated phone as a phone, not as a run of digits", () => {
    // The header claims specific rules are consumed before the broad digit
    // catch-all can fragment them, and nothing pinned it: every phone case in
    // this file was hyphenated (`+54 9 11 1234-5678`), which has no run of 7+
    // digits, so moving the catch-all to the front of SCRUB_RULES changed
    // nothing and the suite stayed green.
    //
    // Written out, this number does have such a run. Catch-all first yields
    // `+54 9 11 [redacted:digits]`; correct order yields `[redacted:phone]`.
    // Both hide the number — what the order buys is the reader knowing WHAT
    // was hidden, which is the whole reason the labels are distinct.
    const out = redactText("contacto de emergencia +54 9 11 12345678 no responde");

    expect(out).not.toContain("12345678");
    expect(out).toContain("[redacted:phone]");
    expect(out).not.toContain("[redacted:digits]");
  });
});

describe("redactText — does not destroy the debugging signal", () => {
  it("leaves a plain route path intact", () => {
    expect(redactText("/mis-mascotas")).toBe("/mis-mascotas");
    expect(redactText("/gob/panorama")).toBe("/gob/panorama");
  });

  it("leaves ordinary prose and small numbers intact", () => {
    const message = "loadWithTimeout timed out after 10000 ms (attempt 3)";

    expect(redactText(message)).toBe(message);
  });

  it.each([
    ["a date", "vence el 2026-09-23 a las 12:34:56"],
    ["a dotted date", "turno 23.09.2026"],
    ["a version", "next 15.5.4, schema 1.2.3"],
    ["an IP address", "host 10.100.200.1 sin respuesta"],
    ["an amount under a million", "cuota $ 12.345 y saldo $ 123.456,78"],
    ["a stack position", "at render (chunk.js:1234:5678)"],
    ["two small numbers", "reintento 3 de 5, 1500 ms"],
    ["a range of years", "entre 2024 y 2026 hubo 1200 casos"],
    ["a four-and-four pair", "pedido 1234-5678"],
  ])("does not mistake %s for a DNI or a phone", (_label, text) => {
    // The separated-number rules are the ones that could eat what a reader
    // needs; each negative must come out byte-for-byte.
    expect(redactText(text)).toBe(text);
  });

  it("scrubs a stack frame's query string without eating the frame", () => {
    const stack = "at Page (/app/(public)/p/page.tsx:42:11)";

    expect(redactText(stack)).toContain("page.tsx:42:11");
  });
});

describe("redactContextValue — only primitives survive", () => {
  it("scrubs a string value", () => {
    expect(redactContextValue("/org/9f3kd82hsn2p")).toBe("/org/[redacted:token]");
  });

  it("passes finite numbers and booleans through", () => {
    expect(redactContextValue(42)).toBe(42);
    expect(redactContextValue(true)).toBe(true);
    expect(redactContextValue(false)).toBe(false);
  });

  it("drops a non-finite number", () => {
    expect(redactContextValue(Number.NaN)).toBeUndefined();
    expect(redactContextValue(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("drops an object outright rather than guessing at its keys", () => {
    // This is the case that matters: a caller attaching a whole profile row.
    expect(redactContextValue({ dniHash: "abc", email: "a@b.com" })).toBeUndefined();
    expect(redactContextValue(["30123456"])).toBeUndefined();
    expect(redactContextValue(() => "x")).toBeUndefined();
  });
});
