// Post-adoption check-in use-case types.

export type CheckinFormState = {
  error: string | null;
  /**
   * Nav contract N3: on success the use-case RETURNS the destination and the
   * calling form performs the navigation (useActionRedirect). See
   * lib/ui/use-action-redirect.ts.
   */
  redirectTo?: string;
};

/**
 * What a check-in IS, with its transport stripped off.
 *
 * UNTIL 2026-09-09 THE USE-CASE TOOK A `FormData` AND A SUPABASE CLIENT, which
 * made it the one owner writer the native app could not reach: the app posts
 * JSON to `POST /api/v1/pets/{token}/events` and has no form to hand over. The
 * other kinds that crossed took this same shape — the web action parses the
 * form, uploads the file and normalises the location, and the writer receives
 * facts. The rules (who may write one, what it requires, what it appends and
 * what it closes) run here, once, for both doors.
 *
 * THE ATTACHMENT IS THREE NULLABLE FIELDS AND NOT A FILE, exactly as
 * `createVaccination` takes it: the web uploads first and hands over the path,
 * and the native path — which has no photo module yet — hands over three
 * nulls. A writer that uploaded would be a writer that knew about storage
 * clients, which is the coupling this type exists to remove.
 *
 * THE LOCATION ARRIVES CANONICAL. `eventJurisdictionProvince` is the display
 * name every other `jurisdiction_province` write stores ("CABA", never
 * "AR-C"); the web adapter runs `normalizeLocationForWrite` before calling, and
 * the native path sends the pair of nulls an untouched form resolves to.
 */
export type RecordPostAdoptionCheckinInput = {
  pet: { id: string; name: string };
  user: { id: string };
  notes: string | null;
  eventJurisdictionProvince: string | null;
  eventJurisdictionLocality: string | null;
  clientIdempotencyKey: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  now?: Date;
};

/**
 * WHICH refusal about THE ANIMAL or THE CALLER this is — or absent, when the
 * failure was the transaction rather than a rule.
 *
 * A DISCRIMINATOR AND NOT A BOOLEAN, by the same bar `PregnancyRefusal` meets:
 * a code earns its own name when the NEXT MOVE is different, and the `error`
 * beside it is es-AR prose written for a web form that cannot cross a wire.
 *
 *   · `not_adopted`    — no `adoption_finalized` on this animal's spine. No
 *                        next move: this animal can never have this event.
 *   · `not_adopter`    — the latest adoption names somebody else. About the
 *                        CALLER, which is why the endpoint answers 403 and not
 *                        the 409 the other two get.
 *   · `no_open_window` — the adopter is right and there is no follow-up
 *                        window pending. The next move is to wait: the refugio's
 *                        next milestone opens one and the app is told.
 */
export type PostAdoptionCheckinRefusal = "not_adopted" | "not_adopter" | "no_open_window";

export type RecordPostAdoptionCheckinResult =
  | {
      ok: true;
      eventId: string;
      /** `true` when the key resolved to a check-in that already existed. */
      wasDuplicate: boolean;
    }
  | {
      ok: false;
      error: string;
      notAllowed?: PostAdoptionCheckinRefusal;
    };
