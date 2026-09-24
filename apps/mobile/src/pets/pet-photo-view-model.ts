// La foto de la credencial — the words, the gate, and nothing else.
//
// PURE, like every view-model in this app: no network, no port, no React. What
// lives here is the SCREEN'S HALF of the photo flow's rules — which pick is
// acceptable, and which sentence each way of failing gets. The three network
// calls live in `pet-photo-upload-flow.ts`; the native module lives behind
// `native/image-picker-port.ts`.
//
// WHY THE SCREEN VALIDATES AT ALL, when the server re-checks everything
// ---------------------------------------------------------------------------
// The server is the authority: `confirm` re-authorizes, sniffs the MAGIC BYTES
// (never the declared type) and re-encodes before anything reaches the public
// bucket. This gate exists for a different reason — the person's time. An
// unacceptable file refused HERE costs one sentence; the same file refused by
// the server costs a ticket, an upload of up to 5 MB over a phone connection,
// and THEN the sentence. The adapter is supposed to hand over JPEG only (the
// handback doc pins it to `expo-image-manipulator`, which re-encodes and strips
// EXIF); this gate is what catches the adapter that does not.
//
// HEIC IS REFUSED BY DESIGN, NOT BY OMISSION. The bucket's allowlist (migration
// 0206) is jpeg/png/webp, deliberately: HEIC is the one format a phone hands
// over with the GPS position of the person's HOME embedded in it, and the
// known-leak path this product refuses. The sentence for it names the fix
// (elegir otra / convertirla) rather than the policy — the policy lives here,
// in the handback doc, and in the migration.

import { PET_PHOTO_CONTENT_TYPES, type PetPhotoContentType } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { apiErrorMessage } from "../api/error-copy";
import type { ImagePickResult } from "../native/image-picker-port";

/**
 * The bucket's own size cap, mirrored — NOT invented here.
 *
 * `MAX_IMAGE_BYTES` in `lib/media/validate.ts` is the server's declaration and
 * migration 0206 sets the staging bucket's `file_size_limit` to the same 5 MiB.
 * This constant transcribes that decision so the screen can refuse before the
 * upload instead of after it; if the server's number ever moves, this one
 * follows it, never leads.
 */
export const PET_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** A pick this screen accepts: typed content, bounded size, ready to upload. */
export type AcceptedImage = {
  bytes: Uint8Array;
  contentType: PetPhotoContentType;
  previewUri: string | null;
};

/**
 * What one pick attempt means for the screen.
 *
 * `message: null` is CANCELLED — the person changed their mind, and a form
 * that scolds somebody for closing a dialog is noise. Every other refusal
 * carries its sentence.
 */
export type PickOutcome =
  | { ok: true; image: AcceptedImage }
  | { ok: false; message: string | null };

const ACCEPTED: ReadonlySet<string> = new Set(PET_PHOTO_CONTENT_TYPES);

/** The formats, in words, for every sentence that needs to list them. */
const FORMATS = "JPG, PNG o WebP";

export function acceptPickedImage(result: ImagePickResult): PickOutcome {
  switch (result.outcome) {
    case "cancelled":
      return { ok: false, message: null };
    case "unavailable":
      // Defensive: a screen reads `available` before offering the control, so
      // reaching this arm means the port changed under it. Still a sentence —
      // silence is the one answer a tap may not get.
      return {
        ok: false,
        message: "En esta versión de la app todavía no se puede elegir una foto.",
      };
    case "failed":
      return { ok: false, message: "No pudimos abrir tus fotos. Volvé a intentar." };
    case "picked": {
      const type = result.contentType.toLowerCase();
      if (type === "image/heic" || type === "image/heif") {
        // The iPhone default. Named apart from the generic arm because the fix
        // is different: the same photo, exported as JPG, is fine.
        return {
          ok: false,
          message: `Esa foto está en formato HEIC y no lo podemos usar. Compartila o exportala como ${FORMATS} y volvé a elegirla.`,
        };
      }
      if (!ACCEPTED.has(type)) {
        return {
          ok: false,
          message: `Ese archivo no es una imagen que podamos usar. Elegí una ${FORMATS}.`,
        };
      }
      if (result.bytes.byteLength === 0) {
        return { ok: false, message: "Esa foto no se pudo leer. Probá con otra." };
      }
      if (result.bytes.byteLength > PET_PHOTO_MAX_BYTES) {
        // The bucket would refuse it at the PUT; refusing here saves the
        // person a full upload that ends in the same sentence.
        return { ok: false, message: "Esa foto pesa más de 5 MB. Elegí una más liviana." };
      }
      return {
        ok: true,
        image: {
          bytes: result.bytes,
          // The narrowed type, from the MEMBERSHIP check above — not a cast of
          // whatever the adapter declared.
          contentType: type as PetPhotoContentType,
          previewUri: result.previewUri,
        },
      };
    }
  }
}

/** The three steps of the upload, in the order they run. */
export type PetPhotoUploadStep = "ticket" | "put" | "confirm";

/**
 * What the screen says while each step runs. Present-tense and specific,
 * because the whole flow can take the better part of a minute on a slow
 * connection and "Cargando…" for sixty seconds reads as frozen.
 */
export function petPhotoStepLabel(step: PetPhotoUploadStep): string {
  switch (step) {
    case "ticket":
      return "Preparando la subida…";
    case "put":
      return "Subiendo la foto…";
    case "confirm":
      return "Guardando…";
  }
}

/**
 * How the flow can fail — the three arms the board's row asked to be tested,
 * each its own shape because each one's honest instruction is different.
 *
 * Declared HERE (not in the flow module) so the import direction stays
 * one-way: the flow imports the vocabulary and this file never imports the
 * flow. The generic parameter of the refused `ApiResult` is `never` because a
 * failure carries no payload by construction.
 */
export type PetPhotoUploadFailure =
  | { stage: "ticket"; result: Exclude<ApiResult<never>, { outcome: "ok" }> }
  /**
   * The PUT was refused, and WHICH refusal decides what to tell the person:
   *   · `expired`  — the ticket is spent or invalid. A new one is the cure.
   *   · `rejected` — the FILE was refused (type, size). A new ticket is not.
   *   · `failed`   — no signal, or a refusal this build does not recognise.
   */
  | { stage: "put"; kind: "expired" | "rejected" | "failed"; detail: string }
  | { stage: "confirm"; result: Exclude<ApiResult<never>, { outcome: "ok" }> };

/** The transport arms every bearer call shares — the ClaimScreen sentences. */
function transportMessage(result: Exclude<ApiResult<never>, { outcome: "ok" }>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer esta respuesta. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
  }
}

/**
 * The es-AR sentence for each failure. Every arm ends in an instruction, and
 * every instruction is honest about what retrying does:
 *
 *   · ticket refused    — the server's own sentence (`apiErrorMessage`), or the
 *                         transport's. Nothing was uploaded.
 *   · PUT expired       — the RETRY IS THE FIX: the screen re-runs the whole
 *                         flow, which mints a fresh ticket. The sentence says a
 *                         new permission is asked for so "volvé a intentar"
 *                         does not read as "do the same doomed thing again".
 *   · PUT failed        — retrying with the same ticket is safe (nothing was
 *                         claimed), and the likely cause is the connection.
 *   · confirm refused   — the server's own sentence: `photo_not_an_image`
 *                         already says the FILE is the problem, `photo_failed`
 *                         already says retrying is safe. This file adds none
 *                         over them, because two copies of one sentence drift.
 */
export function petPhotoFailureMessage(failure: PetPhotoUploadFailure): string {
  switch (failure.stage) {
    case "ticket":
      return transportMessage(failure.result);
    case "put":
      return putFailureMessage(failure);
    case "confirm":
      return transportMessage(failure.result);
  }
}

/**
 * THE THREE SENTENCES DIFFER IN WHAT THEY ASK FOR, which is the whole point of
 * the split. Until 2026-09-11 every refusal got the "expired" one, so a photo
 * the bucket refused by TYPE or SIZE told the person to retry — and every retry
 * was refused the same way. An error message that asks for something that
 * cannot work is worse than no message at all.
 *
 * ITS OWN FUNCTION rather than a switch nested inside the one above: a nested
 * switch whose arms all return still reads as a fall-through to the `confirm`
 * arm (`lint/suspicious/noFallthroughSwitchClause`), and silencing that rule
 * here would silence it for a file where the next fall-through might be real.
 * Split out, both switches stay exhaustive and both stay checked.
 */
function putFailureMessage(failure: Extract<PetPhotoUploadFailure, { stage: "put" }>): string {
  switch (failure.kind) {
    case "expired":
      return "La subida tardó demasiado y el permiso venció. Volvé a intentar: pedimos uno nuevo.";
    case "rejected":
      // NO "volvé a intentar". The same file will be refused again.
      return `El servidor no aceptó esa foto. Probá con otra. (${failure.detail})`;
    case "failed":
      // The detail rides along because this arm is also where an unrecognised
      // refusal lands, and during the pilot a tester reading it aloud is the
      // only instrument we have on their device.
      return `No pudimos subir la foto. Revisá tu conexión y volvé a intentar. (${failure.detail})`;
  }
}
