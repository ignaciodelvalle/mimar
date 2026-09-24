// `runPetPhotoUpload` — the walk's order, its two short-circuits, and the
// ticket that must die inside it.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. THE ORDER IS ticket → PUT → confirm, and `onStep` fires BEFORE the work
//      it names — a label that trails its step reads as frozen exactly when
//      the slow part is running.
//   2. EACH FAILURE STOPS THE WALK. A confirm after a failed PUT would ask the
//      server to bless bytes that never landed.
//   3. WHAT TRAVELS IS WHAT ARRIVED: the ticket goes to the PUT verbatim, the
//      ticket's OWN `stagedPath` goes to confirm — never a value this module
//      derived.
//   4. THE FAILURE RESULT CARRIES THE STAGE AND NEVER THE TICKET. The signed
//      URL is a bearer capability; it dies inside this function.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockTicket = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPut = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockConfirm = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  requestPetPhotoTicket: (...args: unknown[]) => mockTicket(...args),
  uploadPetPhotoBytes: (...args: unknown[]) => mockPut(...args),
  confirmPetPhoto: (...args: unknown[]) => mockConfirm(...args),
}));

import type { SessionPort } from "../api/client";
import { runPetPhotoUpload } from "./pet-photo-upload-flow";
import type { AcceptedImage } from "./pet-photo-view-model";
import { stageTattooPhoto } from "./tattoo-photo-flow";

const TOKEN = "DIM-PAMP-0001";
const STAGED = "22222222-2222-4222-8222-222222222222/333.jpg";

const ticket = {
  uploadUrl: "https://storage.test/sign/uploads-staging/x?token=capability-tok",
  token: "capability-tok",
  stagedPath: STAGED,
  bucket: "uploads-staging",
  validForSeconds: 7200,
};

const session = {} as SessionPort;

const image: AcceptedImage = {
  bytes: new Uint8Array([1, 2, 3, 4, 5]),
  contentType: "image/jpeg",
  previewUri: null,
};

const updated = { photoUrl: "https://s.test/p.jpg", replacedPrevious: false };

/** Every step signal and every endpoint call, in the order they happened. */
let log: string[] = [];

beforeEach(() => {
  log = [];
  mockTicket.mockReset().mockImplementation(async () => {
    log.push("call:ticket");
    return { outcome: "ok", payload: ticket };
  });
  mockPut.mockReset().mockImplementation(async () => {
    log.push("call:put");
    return { outcome: "ok" };
  });
  mockConfirm.mockReset().mockImplementation(async () => {
    log.push("call:confirm");
    return { outcome: "ok", payload: updated };
  });
});

const stepLogger = (step: string) => log.push(`step:${step}`);

describe("the happy walk", () => {
  it("runs the three calls in order, each step announced BEFORE its work", async () => {
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(result).toEqual({ outcome: "done", photo: updated });
    expect(log).toEqual([
      "step:ticket",
      "call:ticket",
      "step:put",
      "call:put",
      "step:confirm",
      "call:confirm",
    ]);
  });

  it("hands each call what ARRIVED: the ticket to the PUT, its stagedPath to confirm", async () => {
    await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(mockTicket).toHaveBeenCalledWith(session, TOKEN, "image/jpeg");
    expect(mockPut).toHaveBeenCalledWith(ticket, image.bytes, "image/jpeg");
    expect(mockConfirm).toHaveBeenCalledWith(session, TOKEN, STAGED);
  });
});

describe("the short-circuits", () => {
  it("a refused ticket stops the walk — nothing is PUT, nothing confirmed", async () => {
    mockTicket.mockResolvedValue({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(result).toEqual({
      outcome: "failed",
      failure: {
        stage: "ticket",
        result: { outcome: "api-error", code: "rate_limited", retryAfterSeconds: 30 },
      },
    });
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("an expired ticket at the PUT stops the walk before confirm", async () => {
    mockPut.mockResolvedValue({ outcome: "expired" });
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(result).toEqual({ outcome: "failed", failure: { stage: "put", kind: "expired" } });
    // THE ASSERTION THIS FILE EXISTS FOR: confirming after a failed PUT asks
    // the server to bless bytes that never landed.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("a dead PUT stops the walk too, carrying the detail", async () => {
    mockPut.mockResolvedValue({ outcome: "failed", detail: "HTTP 503" });
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(result).toEqual({
      outcome: "failed",
      failure: { stage: "put", kind: "failed", detail: "HTTP 503" },
    });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("a refused confirm comes back as the confirm stage, with the server's refusal", async () => {
    mockConfirm.mockResolvedValue({
      outcome: "api-error",
      code: "photo_not_an_image",
      retryAfterSeconds: null,
    });
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(result).toEqual({
      outcome: "failed",
      failure: {
        stage: "confirm",
        result: { outcome: "api-error", code: "photo_not_an_image", retryAfterSeconds: null },
      },
    });
  });
});

describe("the ticket dies here", () => {
  it("no failure result carries the capability — not the URL, not the token", async () => {
    // Whatever stage fails, what the screen receives (and might render, log or
    // hand to an error reporter) must not contain the signed capability.
    mockPut.mockResolvedValue({ outcome: "expired" });
    const result = await runPetPhotoUpload(session, TOKEN, image, stepLogger);
    expect(JSON.stringify(result)).not.toContain("capability-tok");
  });
});

// `stageTattooPhoto` — the SAME two first steps, and then it stops.
//
// TESTED IN THIS FILE AND NOT ITS OWN, because the two modules share a subject,
// a mock surface and every fixture above. What separates them is exactly one
// property and it is the one worth asserting side by side: a pet photo's
// confirm is its own endpoint; a tattoo's confirm is the ASIENTO, so this walk
// must NOT make a third call and must hand back the staged path for the event
// body to carry.
describe("stageTattooPhoto — dos pasos, y el tercero es el asiento", () => {
  it("mints a ticket, PUTs the bytes, and hands back the staged path", async () => {
    const result = await stageTattooPhoto(session, TOKEN, image);
    expect(result).toEqual({ outcome: "staged", stagedPath: STAGED });
    expect(log).toEqual(["call:ticket", "call:put"]);
  });

  it("NEVER CALLS CONFIRM — the asiento is the confirm", async () => {
    await stageTattooPhoto(session, TOKEN, image);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("passes the ticket to the PUT verbatim, and returns the TICKET's own path", async () => {
    // Never a value this module derived: the server re-derives the prefix it
    // will accept from the pet whose access check passed, so a path composed
    // here could only ever be refused.
    await stageTattooPhoto(session, TOKEN, image);
    expect(mockPut).toHaveBeenCalledWith(ticket, image.bytes, "image/jpeg");
  });

  it("stops at a refused ticket, and never uploads", async () => {
    mockTicket.mockImplementation(async () => ({ outcome: "api-error", code: "not_found" }));
    const result = await stageTattooPhoto(session, TOKEN, image);
    expect(result).toMatchObject({ outcome: "failed", failure: { stage: "ticket" } });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("reports an expired signed URL as its own failure — the retry IS the fix", async () => {
    mockPut.mockImplementation(async () => ({ outcome: "expired" }));
    const result = await stageTattooPhoto(session, TOKEN, image);
    expect(result).toEqual({
      outcome: "failed",
      failure: { stage: "put", kind: "expired" },
    });
  });

  it("carries the PUT's detail through when the upload itself failed", async () => {
    mockPut.mockImplementation(async () => ({ outcome: "failed", detail: "network down" }));
    const result = await stageTattooPhoto(session, TOKEN, image);
    expect(result).toEqual({
      outcome: "failed",
      failure: { stage: "put", kind: "failed", detail: "network down" },
    });
  });
});
