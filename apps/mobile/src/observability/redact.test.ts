// `redact` — the crash reporter's scrubber.
//
// What is being pinned is not "the regexes are the web's" (a copy test proves a
// copy) but the two properties this module exists for:
//
//   · EVERY CHANNEL an app-authored string reaches Sentry through is covered —
//     the event message, the exception values, the `extra` bag, and the
//     breadcrumb trail. A rule set applied to three of the four is a rule set
//     that does nothing, because a leak takes the fourth.
//   · THE SIGNAL SURVIVES. A crash report scrubbed into unreadability is a
//     crash report nobody uses, so the numbers that make one legible — an
//     Android versionCode, a build number, a year, an HTTP status — must come
//     out the other side intact. That is the half a fail-closed rule gets wrong
//     when nobody measures it.

import { describe, expect, it } from "@jest/globals";

import { redactBreadcrumb, redactEvent, redactText } from "./redact";

describe("the shapes this product must never forward", () => {
  it("redacts a DNI, written the way a person types it and the way a form stores it", () => {
    // Invariant #5: migration 0106 dropped `profiles.dni_number` so the DNI
    // cannot be read from the database at all. A DNI interpolated into an error
    // message would reintroduce, in a vendor's index, exactly the cleartext the
    // schema refuses to hold.
    expect(redactText("DNI 12345678 no coincide")).toBe("DNI [redacted:digits] no coincide");
    // Dotted form: the dots are separators, so what is left are three runs of
    // 2, 3 and 3 digits — under the 7-digit floor, which the catch-all alone
    // does NOT cover. This used to be recorded here as a known limit; it has
    // its own rule now, and the way a person writes a DNI on a paper form is
    // the way they type it into a phone.
    expect(redactText("DNI 12.345.678")).toBe("DNI [redacted:dni]");
    expect(redactText("dni:1.234.567 rechazado")).toBe("dni:[redacted:dni] rechazado");
  });

  it.each([
    ["11-1234-5678"],
    ["11 1234 5678"],
    ["011 4567-8901"],
    ["(011) 4567-8901"],
    ["0351 456-7890"],
    ["2966 42-1234"],
    ["11 15 1234-5678"],
  ])("redacts a local phone written with separators: %s", (phone) => {
    // A bite victim's number on a denuncia is typed the way people write it,
    // with dashes and spaces — and then no run of 7+ digits is left for the
    // catch-all to find. Without a `+` in front, the international rule misses
    // it too.
    expect(redactText(`contacto ${phone} no atiende`)).toBe("contacto [redacted:phone] no atiende");
  });

  it("still labels the international form as a phone", () => {
    expect(redactText("tel +54 9 11 1234-5678.")).toBe("tel [redacted:phone].");
  });

  it("redacts an e-mail address", () => {
    expect(redactText("no existe la cuenta ana.gomez@example.com")).toBe(
      "no existe la cuenta [redacted:email]",
    );
  });

  it("redacts a phone number AS A PHONE, not as a run of digits", () => {
    // The ordering assertion. If the digit catch-all ran first it would eat the
    // digits inside the number and leave `[redacted:digits]` fragments where
    // `[redacted:phone]` belongs — destroying the one bit of signal a reader
    // needs, which is what KIND of value was there.
    expect(redactText("llamar a +54 9 11 1234-5678 urgente")).toBe(
      "llamar a [redacted:phone] urgente",
    );
    // A bare local number has no `+`, so it falls to the catch-all. Still gone.
    expect(redactText("tel 1123456789")).toBe("tel [redacted:digits]");
  });

  it("redacts an access token echoed by a failed request", () => {
    // This app HOLDS a Supabase session and sends it on every /api/v1 call, so
    // a fetch error that quotes its own headers is the likeliest way a live
    // credential leaves a phone.
    //
    // MEASURED, NOT ASSUMED: the JWT rule runs BEFORE the `Authorization` one
    // (same order as the web's), so a Supabase token comes back labelled
    // `[redacted:jwt]` and the header NAME survives — which is a header name,
    // not a secret, and is what tells a reader which request failed. The first
    // draft of this test expected `[redacted:authorization]` and was wrong
    // about its own module.
    expect(
      redactText("401 for Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl"),
    ).toBe("401 for Authorization: Bearer [redacted:jwt]");
    // The `Authorization` rule is therefore the backstop for a bearer that is
    // NOT a JWT — an opaque token, a legacy key — which no other rule matches.
    // The rule matches the SCHEME plus the credential (`Bearer …`), not the
    // header name, so `Authorization: ` survives here too.
    expect(redactText("401 for Authorization: Bearer sb_secret_N7UND0UgjKTVK")).toBe(
      "401 for Authorization: [redacted:authorization]",
    );
  });

  it("redacts a credential token by SHAPE, including a prefix nobody has minted", () => {
    // The deliberate divergence from the web module, which enumerates twelve
    // namespace prefixes and keeps a fence pointed at the list. A second copy
    // of that list, in a package the fence does not scan, would be the stale
    // list without the alarm — so this bans the shape instead.
    expect(redactText("no se pudo abrir DIM-PAMP-0001")).toBe(
      "no se pudo abrir [redacted:credential]",
    );
    expect(redactText("caso CAS-NBGE-CS3C cerrado")).toBe("caso [redacted:credential] cerrado");
    // A namespace that does not exist yet — the case a transcribed list misses.
    expect(redactText("ZZZ-A1B2-C3D4")).toBe("[redacted:credential]");
  });
});

describe("the signal a crash report is read for survives", () => {
  it("leaves a versionCode, a build number, a year and a status code alone", () => {
    // The half a fail-closed rule gets wrong when nobody measures it. All of
    // these are under the 7-digit floor on purpose.
    expect(redactText("versionCode 10 build 42 en 2026, HTTP 503")).toBe(
      "versionCode 10 build 42 en 2026, HTTP 503",
    );
  });

  it.each([
    ["a date", "vence el 2026-09-23 a las 12:34:56"],
    ["a dotted date", "turno 23.09.2026"],
    ["a version", "expo 54.0.12, runtime 1.2.3"],
    ["an IP address", "host 10.100.200.1 sin respuesta"],
    ["an amount under a million", "cuota $ 12.345 y saldo $ 123.456,78"],
    ["a stack position", "at render (app.bundle:1234:5678)"],
    ["two small numbers", "reintento 3 de 5, 1500 ms"],
    ["a range of years", "entre 2024 y 2026 hubo 1200 casos"],
    ["a four-and-four pair", "pedido 1234-5678"],
  ])("does not mistake %s for a DNI or a phone", (_label, text) => {
    // The separated-number rules are the ones that could eat the signal a
    // reader needs; every negative here is a shape a real crash report
    // carries, and each must come out byte-for-byte.
    expect(redactText(text)).toBe(text);
  });

  it("labels a credential token as a credential, never as a phone", () => {
    expect(redactText("DIM-PAMP-0001")).toBe("[redacted:credential]");
  });

  it("leaves an ordinary sentence untouched", () => {
    expect(redactText("No pudimos guardar el turno.")).toBe("No pudimos guardar el turno.");
  });
});

describe("every channel an event carries text through", () => {
  it("scrubs the message, the exception chain, extra, and the attached breadcrumbs", () => {
    const event = {
      message: "fallo para ana.gomez@example.com",
      exception: {
        values: [{ type: "Error", value: "DNI 12345678 duplicado" }],
      },
      extra: { url: "/api/v1/pets?token=sb_secret_abcdef", intento: 2, ok: false },
      breadcrumbs: [
        {
          message: "POST /auth/login ana.gomez@example.com",
          data: { phone: "+54 9 11 1234-5678" },
        },
      ],
      // A field this module does not name, to prove the event is scrubbed IN
      // PLACE rather than rebuilt — a fresh object would silently drop it.
      release: "mimar@1.0.0",
    };

    const out = redactEvent(event);

    expect(out).toBe(event);
    expect(out.message).toBe("fallo para [redacted:email]");
    expect(out.exception.values).toEqual([
      { type: "Error", value: "DNI [redacted:digits] duplicado" },
    ]);
    expect(out.extra.url).toBe("/api/v1/pets?token=[redacted]");
    expect(out.breadcrumbs).toEqual([
      { message: "POST /auth/login [redacted:email]", data: { phone: "[redacted:phone]" } },
    ]);
    expect(out.release).toBe("mimar@1.0.0");
  });

  it("keeps primitives in `extra` and DROPS anything it cannot scrub", () => {
    // An object cannot be scrubbed with confidence — its keys are unknown, it
    // may be a whole session or a `Response` — so the reporter refuses to guess.
    // The key goes with the value: a kept key with no value would read as "this
    // field was empty" rather than "this field was refused".
    const event = {
      extra: {
        intento: 3,
        ok: true,
        texto: "cuenta ana.gomez@example.com",
        sesion: { accessToken: "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln" },
      },
    };

    const out = redactEvent(event);

    expect(out.extra).toEqual({ intento: 3, ok: true, texto: "cuenta [redacted:email]" });
    expect("sesion" in out.extra).toBe(false);
  });

  it("scrubs a breadcrumb on its own, keeping the fields that make it readable", () => {
    // `beforeBreadcrumb` takes the RETURN VALUE as the breadcrumb, so a fresh
    // object would drop `category`, `level` and `timestamp` — which are what a
    // breadcrumb trail is for.
    const crumb = {
      category: "fetch",
      level: "info",
      message: "GET /p/DIM-PAMP-0001 falló para ana.gomez@example.com",
      data: { status: 500, dni: "12345678" },
    };

    const out = redactBreadcrumb(crumb);

    expect(out).toBe(crumb);
    expect(out.message).toBe("GET /p/[redacted:credential] falló para [redacted:email]");
    expect(out.data.status).toBe(500);
    expect(out.data.dni).toBe("[redacted:digits]");
    expect(out.category).toBe("fetch");
    expect(out.level).toBe("info");
  });

  it("scrubs the URL of a captured failed request — the channel `enableCaptureFailedRequests` opened", () => {
    // FINDING C2 (review 2026-09-07). `initSentry` turns
    // `enableCaptureFailedRequests` on; `@sentry/react-native` answers that flag
    // with `httpClientIntegration()` and no options, so `@sentry/browser`'s
    // defaults apply — every 5xx, every target — and its `_createEvent` writes
    // `request: { url }` with the FULL url. `sendDefaultPii: false` suppresses
    // the headers and the cookies on that block and says nothing about the url,
    // so one 502 from a libreta read filed a pet's public token verbatim.
    const event = {
      message: "HTTP Client Error with status code: 502",
      request: {
        url: "https://www.mimar.com.ar/api/v1/pets/DIM-PAMP-0001/libreta",
        method: "GET",
      },
    };

    const out = redactEvent(event);

    expect(out).toBe(event);
    expect(out.request.url).toBe(
      "https://www.mimar.com.ar/api/v1/pets/[redacted:credential]/libreta",
    );
    expect(JSON.stringify(out)).not.toContain("DIM-PAMP-0001");
    // The method survives: it is what tells a reader which request failed.
    expect(out.request.method).toBe("GET");
  });

  it("scrubs a signed-storage token out of the request URL and out of a bare query string", () => {
    // The other value on this channel. A signed upload PUT carries its grant in
    // the query, and a 5xx from the storage host would have filed it whole.
    const event = {
      request: {
        url: "https://storage.example.com/object?token=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln&x=1",
        query_string: "token=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln&x=1",
      },
    };

    const out = redactEvent(event);

    expect(out.request.url).toBe("https://storage.example.com/object?token=[redacted]&x=1");
    // A bare query string has no leading `?` for the parameter rule to key on.
    // The scrubber lends it one and takes it back off, so the SAME rule covers
    // both shapes — and the non-sensitive parameter still comes out readable.
    expect(out.request.query_string).toBe("token=[redacted]&x=1");
  });

  it("DROPS a query_string the SDK handed over as an object rather than guessing at it", () => {
    // Sentry types `query_string` as a string, a record OR a list of pairs. The
    // last two hold parameter values with no `?key=` for the rule to key on, so
    // they are refused for `redactContextValue`'s reason: an unscrubabble value
    // is dropped, never forwarded.
    const event = { request: { url: "/api/v1/me", query_string: { token: "sb_secret_abcdef" } } };

    const out = redactEvent(event);

    expect(out.request.query_string).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("sb_secret_abcdef");
  });

  it("handles an event with none of the fields it scrubs", () => {
    // The SDK sends plenty of these. A redactor that threw here would turn a
    // crash reporter into a second crash.
    const event = {};
    expect(redactEvent(event)).toEqual({});
  });
});
