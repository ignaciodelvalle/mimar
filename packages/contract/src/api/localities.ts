// The wire shape of `GET /api/v1/localities?q=` — the INDEC locality typeahead
// (native-readiness WU-B).
//
// TYPES ONLY plus two frozen literals. The query is a URL parameter, not a body,
// so this endpoint has no counterpart in `@dim/contract/input`.

/** Bump when a field is removed or changes meaning. Adding one is additive. */
export const LOCALITIES_PAYLOAD_VERSION = 1;

/**
 * How long a cached locality result may be presented as current.
 *
 * ONE HOUR, deliberately far above the five minutes `/me`, the credential and
 * the pet list use. Those three describe things that change under the user;
 * `ar_localities` is the INDEC catalogue, which changes when a census does. The
 * point of a long window here is that a native client can hold a typeahead
 * result across a whole registration flow — including one that goes through a
 * tunnel — without the field it already filled in going stale under it.
 */
export const LOCALITIES_STALE_AFTER_MS = 60 * 60_000;

/**
 * One locality the caller may attribute a pet to.
 *
 * This is a STRICT subset of `LocalitySearchResult` (lib/infra/ar-localidades),
 * and the omissions are the point:
 *   · no `id` — the `ar_localities` uuid is the app's structural FK
 *     (migration 0147) and a client has no use for it. `indecId` is the
 *     PUBLISHED identifier and travels instead, for the reason below;
 *   · no `matchKind` — an internal ranking signal for the server's own ORDER BY;
 *     shipping it invites a client to re-sort and disagree with the server about
 *     which result is best.
 *
 * `provinceCode` and `localityName` are the two strings `POST /api/v1/pets`
 * takes back verbatim. That round-trip WAS the whole contract and it was not
 * enough (A2-alta-asentar-03): the INDEC catalogue ships 68 (province, name)
 * collisions, the picker disambiguates them by showing the DEPARTMENT, and the
 * server's name lookup then resolved the pair to the alphabetically first
 * department regardless of the row the person tapped. `indecId` is what closes
 * it — the identifier INDEC itself publishes, stable across a rename of the
 * display name, and the thing a client sends back so the server resolves the row
 * that was actually chosen.
 *
 * The CODE travels rather than `provinceName` because a display name can be
 * re-spelled by a catalogue update while `AR-C` cannot — `provinceName` is here
 * for the client to RENDER, not to send back.
 */
export type LocalityV1 = {
  /**
   * INDEC's own locality identifier. Send it back on a write and the server
   * resolves THIS row rather than guessing between homonyms — see above.
   *
   * NULLABLE, because the column is: `ar_localities.indec_id` is not populated
   * for every row. A client sends what it was given and omits the field when it
   * is null; the server falls back to the (province, name) pair, which is the
   * behaviour every client had before this field existed.
   */
  indecId: string | null;
  /** Canonical INDEC locality name, e.g. "Villa Crespo", "San Carlos de Bariloche". */
  localityName: string;
  /** URL-safe slug, stable across renames of the display name. */
  localitySlug: string;
  /** ISO 3166-2 province code, e.g. "AR-C", "AR-B". */
  provinceCode: string;
  /** Canonical province display name, e.g. "Ciudad Autónoma de Buenos Aires". */
  provinceName: string;
  /** INDEC department, when the catalogue records one (CABA barrios have none). */
  departmentName: string | null;
};

/**
 * A locality search (HTTP 200).
 *
 * An empty `results` array is a NORMAL answer and never an error — it is what a
 * query shorter than two characters returns, and what a query matching nothing
 * returns. The two are deliberately indistinguishable: a client renders "sin
 * resultados" for both, and there is nothing useful it would do differently.
 */
export type LocalitiesV1 = {
  payloadVersion: typeof LOCALITIES_PAYLOAD_VERSION;
  /** ISO-8601 — when the server built this snapshot. */
  issuedAt: string;
  /** ISO-8601 — after this, the snapshot must not be shown as current. */
  staleAfter: string;
  results: LocalityV1[];
};
