// `?face=` — the one query parameter the pet document reads.
//
// WHY IT IS ITS OWN FILE. The parameter is written in `src/ui/routes.ts` and
// read in `app/mascotas/[publicToken].tsx`, and the thing that has to hold is
// that the two agree: a route builder emitting `?face=libreta` against a guard
// that only recognises `libreta` is a contract between two files with nothing
// between them. `PetDocumentScreen.test.tsx` proves the SCREEN honours a face it
// is handed; this proves the URL can name one.
//
// The expected strings are spelled out rather than composed from the functions
// under test. A test that re-derives its expectation from the same builder
// agrees with a broken builder and with nothing else.

import { describe, expect, it } from "@jest/globals";

import { DOCUMENT_FACE_PARAM, credentialRoute } from "../ui/routes";
import { isDocumentFace } from "./DocumentChromeNative";

const TOKEN = "DIM-PAMP-0001";

describe("credentialRoute", () => {
  it("names the document with no query when no face is asked for", () => {
    // The default is the omission, not a `?face=credencial` written every time:
    // the document already opens on the credential, and a parameter restating
    // the default is one more thing to keep in step with it.
    expect(credentialRoute(TOKEN)).toBe("/mascotas/DIM-PAMP-0001");
  });

  it("carries the libreta face when the caller asks for it (D3)", () => {
    expect(credentialRoute(TOKEN, { face: "libreta" })).toBe(
      "/mascotas/DIM-PAMP-0001?face=libreta",
    );
  });

  it("carries the credential face explicitly when asked, without duplicating the token", () => {
    expect(credentialRoute(TOKEN, { face: "credencial" })).toBe(
      "/mascotas/DIM-PAMP-0001?face=credencial",
    );
  });

  it("still encodes the token, and puts the query AFTER it", () => {
    // The token is a path segment and the face is a query — an encoder applied
    // to the wrong half would produce `%3Fface%3D`, a literal segment expo-router
    // has no screen for.
    expect(credentialRoute("a/b", { face: "libreta" })).toBe("/mascotas/a%2Fb?face=libreta");
  });

  it("uses the parameter name the route file reads", () => {
    expect(DOCUMENT_FACE_PARAM).toBe("face");
    expect(credentialRoute(TOKEN, { face: "libreta" })).toContain(`?${DOCUMENT_FACE_PARAM}=`);
  });
});

describe("isDocumentFace", () => {
  it("accepts exactly the two faces the document has", () => {
    expect(isDocumentFace("credencial")).toBe(true);
    expect(isDocumentFace("libreta")).toBe(true);
  });

  it("rejects anything else, so the route falls back to the default", () => {
    // Every one of these is a real shape a URL can arrive in: a third face this
    // build does not have, the empty string a missing parameter trims to, and
    // casing nobody wrote by hand.
    expect(isDocumentFace("publica")).toBe(false);
    expect(isDocumentFace("")).toBe(false);
    expect(isDocumentFace("Libreta")).toBe(false);
    expect(isDocumentFace("libreta ")).toBe(false);
  });
});
