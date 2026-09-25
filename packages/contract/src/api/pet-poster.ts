// `GET /api/v1/pets/{publicToken}/poster` — the printable lost-pet poster.
//
// THE SERVER SENDS THE POSTER, NOT ITS INGREDIENTS. The cartel prints the
// TITULAR's first name and phone, filtered through the disclosure preferences,
// and a QR that points at the public credential. Resolving that contact is a
// query narrower than the pet-access guard (role = 'owner', ownership still
// open — a caretaker's row must never reach a lamppost), and it is a privacy
// filter. Handing a phone the raw fields and letting it lay them out would be a
// second place that decides what a stranger reads; handing it finished HTML
// keeps the one decision on the server, next to the web page's own copy of it.
//
// The app turns `html` into a PDF on the device and shares it; it never edits
// it. `hasPhoto` is carried separately so the app can repeat the web's
// pre-print warning without parsing the document.

/** Bumped when a field changes meaning or leaves. */
export const PET_POSTER_PAYLOAD_VERSION = 1;

/** A4 at 72 PPI — the page size the HTML is laid out for, in points. */
export const PET_POSTER_PAGE_POINTS = { width: 595, height: 842 } as const;

export type PetPosterV1 =
  | {
      payloadVersion: typeof PET_POSTER_PAYLOAD_VERSION;
      publicToken: string;
      /** The poster exists only while the animal is marked lost. */
      available: true;
      petName: string;
      /** False → the web's "sin foto, el cartel pierde casi todo su valor". */
      hasPhoto: boolean;
      /** A complete, self-contained HTML document sized for one A4 page. */
      html: string;
    }
  | {
      payloadVersion: typeof PET_POSTER_PAYLOAD_VERSION;
      publicToken: string;
      /** Not lost (any more): there is no poster to print. */
      available: false;
      petName: string;
    };
