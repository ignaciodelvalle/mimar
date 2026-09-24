// `pet-photo-view-model` — the gate a pick must pass, and the sentence each
// failure gets.
//
// WHAT THESE HAVE TO PROVE, beyond "it returns a string"
// ---------------------------------------------------------------------------
//   1. THE GATE IS MEMBERSHIP IN THE CONTRACT'S LIST, not a re-typed one. The
//      bucket accepts jpeg/png/webp (migration 0206) and the contract exports
//      exactly that array; every accepted type here must come from it.
//   2. HEIC IS REFUSED WITH ITS OWN SENTENCE. It is the iPhone default, the
//      bucket refuses it by design (the GPS leak), and the fix — export as
//      JPG — is different from "that is not an image".
//   3. CANCELLED IS SILENT. `message: null`, because closing a dialog is not
//      an error and a form that scolds for it is noise.
//   4. THE SIZE CAP MIRRORS THE SERVER'S 5 MiB, refusing BEFORE the upload the
//      person would otherwise pay for.
//   5. EVERY FAILURE ARM OF THE UPLOAD HAS A SENTENCE, and the two PUT arms
//      differ: an expired ticket promises a fresh permission on retry, a dead
//      connection names the connection.

import { describe, expect, it } from "@jest/globals";

import { PET_PHOTO_CONTENT_TYPES } from "@dim/contract/input";

import type { ImagePickResult } from "../native/image-picker-port";
import {
  PET_PHOTO_MAX_BYTES,
  acceptPickedImage,
  petPhotoFailureMessage,
  petPhotoStepLabel,
} from "./pet-photo-view-model";

function picked(over: Partial<Extract<ImagePickResult, { outcome: "picked" }>> = {}) {
  return {
    outcome: "picked" as const,
    bytes: new Uint8Array([1]),
    contentType: "image/jpeg",
    previewUri: "file:///cache/a.jpg",
    ...over,
  };
}

describe("acceptPickedImage — the gate", () => {
  it("accepts every type the CONTRACT lists, narrowed from membership", () => {
    // Iterating the contract's own array, not a copy: a type added there is
    // accepted here with no edit, which is the point of importing it.
    for (const contentType of PET_PHOTO_CONTENT_TYPES) {
      const outcome = acceptPickedImage(picked({ contentType }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.image.contentType).toBe(contentType);
    }
  });

  it("normalizes case before the membership check — adapters disagree on it", () => {
    const outcome = acceptPickedImage(picked({ contentType: "IMAGE/JPEG" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.image.contentType).toBe("image/jpeg");
  });

  it("refuses HEIC and HEIF with the sentence that names the export fix", () => {
    for (const contentType of ["image/heic", "image/heif"]) {
      const outcome = acceptPickedImage(picked({ contentType }));
      expect(outcome).toEqual({ ok: false, message: expect.stringContaining("HEIC") });
    }
  });

  it("refuses everything else as not-an-image, naming the three formats", () => {
    const outcome = acceptPickedImage(picked({ contentType: "application/pdf" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("JPG, PNG o WebP");
      // NOT the HEIC sentence: a PDF exported as JPG is not a thing.
      expect(outcome.message).not.toContain("HEIC");
    }
  });

  it("refuses a file over the bucket's own 5 MiB, before the upload is paid for", () => {
    const big = new Uint8Array(PET_PHOTO_MAX_BYTES + 1);
    const outcome = acceptPickedImage(picked({ bytes: big }));
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining("5 MB") });

    // The boundary itself passes: the cap is the server's `> MAX`, mirrored.
    const exact = new Uint8Array(PET_PHOTO_MAX_BYTES);
    expect(acceptPickedImage(picked({ bytes: exact })).ok).toBe(true);
  });

  it("refuses an empty file with its own sentence", () => {
    const outcome = acceptPickedImage(picked({ bytes: new Uint8Array(0) }));
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining("no se pudo leer") });
  });

  it("is silent about a cancelled pick — null, not a scolding", () => {
    expect(acceptPickedImage({ outcome: "cancelled" })).toEqual({ ok: false, message: null });
  });

  it("still answers a tap on a port that turned unavailable, in words", () => {
    const outcome = acceptPickedImage({ outcome: "unavailable" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).not.toBeNull();
  });

  it("gives a failed pick a sentence that invites the retry that is safe", () => {
    const outcome = acceptPickedImage({ outcome: "failed", detail: "boom" });
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining("Volvé a intentar") });
  });
});

describe("the upload copy — three failures, three different instructions", () => {
  it("labels the three steps in flight, each its own words", () => {
    const labels = (["ticket", "put", "confirm"] as const).map(petPhotoStepLabel);
    expect(new Set(labels).size).toBe(3);
    expect(labels[1]).toContain("Subiendo");
  });

  it("an expired ticket promises the FRESH permission a retry actually mints", () => {
    const message = petPhotoFailureMessage({
      stage: "put",
      kind: "expired",
      detail: "HTTP 400 KeyAlreadyExists The resource already exists",
    });
    expect(message).toContain("venció");
    expect(message).toContain("pedimos uno nuevo");
  });

  it("a REFUSED FILE never asks for a retry, because a retry cannot cure it", () => {
    // The defect this arm exists to close: until 2026-09-11 a photo the bucket
    // refused by type or size got the "expired" sentence, so the person was
    // told to try again — and every attempt was refused identically. The
    // assertion is on the ABSENCE of that promise, which is the part that was
    // doing the harm.
    const message = petPhotoFailureMessage({
      stage: "put",
      kind: "rejected",
      detail: "HTTP 400 InvalidMimeType mime type text/plain is not supported",
    });
    expect(message).not.toContain("venció");
    expect(message).not.toContain("Volvé a intentar");
    expect(message).toContain("Probá con otra");
    // The server's own words reach the screen: on a pilot device we cannot
    // attach a debugger to, a tester reading this aloud is the instrument.
    expect(message).toContain("InvalidMimeType");
  });

  it("gives the three PUT refusals three different sentences", () => {
    // Survives a collapse back into one message, in any direction.
    const messages = (["expired", "rejected", "failed"] as const).map((kind) =>
      petPhotoFailureMessage({ stage: "put", kind, detail: "HTTP 400 X y" }),
    );
    expect(new Set(messages).size).toBe(3);
  });

  it("a dead PUT names the connection, not the permission", () => {
    const message = petPhotoFailureMessage({ stage: "put", kind: "failed", detail: "HTTP 503" });
    expect(message).toContain("conexión");
    expect(message).not.toContain("venció");
  });

  it("a refused confirm speaks with the server's own sentence for the code", () => {
    // `photo_not_an_image` already says the FILE is the problem and that a
    // retry of the same file cannot work. This module must not fork that copy.
    const message = petPhotoFailureMessage({
      stage: "confirm",
      result: { outcome: "api-error", code: "photo_not_an_image", retryAfterSeconds: null },
    });
    expect(message).toContain("JPG");
  });

  it("a refused ticket gets the shared transport sentences", () => {
    expect(
      petPhotoFailureMessage({
        stage: "ticket",
        result: { outcome: "unreachable", detail: "offline" },
      }),
    ).toContain("conexión");
    expect(
      petPhotoFailureMessage({
        stage: "ticket",
        result: { outcome: "api-error", code: "rate_limited", retryAfterSeconds: 30 },
      }),
    ).toContain("Esperá");
  });
});
