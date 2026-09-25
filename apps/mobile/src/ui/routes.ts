// The route tree, named once.
//
// WHY THIS FILE AND NOT `experiments.typedRoutes`
// ---------------------------------------------------------------------------
// expo-router can generate route types into `.expo/types/router.d.ts` — during
// `expo start` or `expo export`. That is the problem: `.expo/` is a build
// artifact, it is gitignored, and `pnpm --filter mimar typecheck` runs on CI
// against a checkout that has never started the bundler. Turning typed routes on
// would make the typecheck depend on an artifact the typecheck cannot produce,
// which is either a red build on a clean clone or a `d.ts` committed by hand and
// then quietly wrong.
//
// So the paths live here, as literals, and every navigation goes through them.
// It buys the same thing typed routes buy — a rename is a compile error at every
// call site, not a screen that silently fails to open — with no generated file
// in the loop.

export const ROUTES = {
  /** The gate. Decides where a cold start actually lands. */
  root: "/",
  ingreso: "/ingreso",
  /**
   * Step 1 of the signup — the account. Step 2 (the identity) is
   * `identidadPendiente` below, which hands the person a web URL.
   *
   * The path deliberately does NOT match the web's, which is `/registro`. The
   * reason `/transferencias` and `/cuidado` match theirs is that both are
   * deep-link destinations shared with a notification or an e-mail; nothing
   * links INTO a signup form from outside the app, so this path is free to say
   * what the screen does in the words the screen uses ("Crear cuenta") rather
   * than in the word the web's router happens to use.
   */
  crearCuenta: "/crear-cuenta",
  /**
   * Password recovery — ask for a code, then set a new password.
   *
   * The path MATCHES the web's (`/recuperar`), and for once that is not the
   * deep-link reason `/transferencias` and `/cuidado` match theirs. Nothing links
   * into this screen from outside the app and nothing may: it is NOT in
   * `DEEP_LINK_MAP` and must never be added to it. A `mimar://recuperar` url
   * would be an unverified custom scheme any installed app can claim, standing
   * in front of the one flow whose entire job is to hand back control of an
   * account. The paths agree here simply because both surfaces call the act the
   * same thing.
   */
  recuperar: "/recuperar",
  identidadPendiente: "/identidad-pendiente",
  misMascotas: "/mascotas",
  /**
   * The owner's casos — every open cycle plus the recent history, the web's
   * `/mis-mascotas#inbox` "Casos abiertos" + "Historial" (M11). Its own screen
   * because the Mis mascotas block shows only the open ones.
   */
  casos: "/casos",
  altaMascota: "/alta",
  ajustes: "/ajustes",
  /**
   * The Ley 25.326 rights — descargar mis datos (art. 14) and eliminar mi cuenta
   * (art. 16).
   *
   * THE PATH MATCHES THE WEB'S EXACTLY (`/cuenta/privacidad`) and here that is
   * not the forward-looking deep-link argument `/notificaciones` makes: this
   * URL is ALREADY in the world. `ACCOUNT_DELETION_URL` has been handing it to
   * people in a browser since the Play submission and the Data safety form
   * names it. Choosing `/ajustes/privacidad` — which is where the entry point
   * actually is — would have meant the one screen a store reviewer is told to
   * look for lives at a different address in the two clients.
   */
  privacidad: "/cuenta/privacidad",
  /**
   * Editar mis datos — name, phone, and the DEFAULT vet / emergency contact
   * every pet's own override falls back to.
   *
   * Beside `privacidad` under `/cuenta` rather than under `/ajustes`, where its
   * button is. The deep-link argument that pins `privacidad` does not apply here
   * — nothing outside the app links in — but two account screens at two
   * different depths, each for its own local reason, is how a route tree stops
   * describing anything. The web's leaf is `/cuenta/editar` too, so the paths
   * agree for free.
   */
  editarCuenta: "/cuenta/editar",
  /**
   * The transfer hub — THE ONE TOP-LEVEL SCREEN THAT IS NOT ABOUT A PET THIS
   * PERSON HOLDS. Half of what it lists is offers from animals somebody else
   * owns, which is why it sits beside `/mascotas` rather than under it.
   *
   * The path deliberately matches the WEB's (`/transferencias`), unlike
   * `/mascotas` which shortens `/mis-mascotas`. The reason is the deep link: a
   * notification CTA and an invitation e-mail both name `/transferencias/{token}`,
   * and keeping the app's path identical means the `mimar://` form and the
   * `https` form differ only in scheme — one less place for the two to drift.
   */
  transferencias: "/transferencias",
  /**
   * La bandeja — THE OTHER TOP-LEVEL SCREEN THAT IS NOT ABOUT A PET THIS PERSON
   * HOLDS, and the one where the reason is plainest: a notification is addressed
   * to a person, not to an animal. Some rows are about a pet, several are about a
   * pet whose custody LEFT the reader (that is what `pet_transfer_accepted` is),
   * and some are about no animal at all.
   *
   * The path matches the WEB's for the reason `/transferencias` does, one step
   * early: nothing links in from outside today — `DEEP_LINK_MAP` has no row for
   * it, because nothing outside the rendering surface names it — but a push
   * opening the inbox is exactly what the next work unit is, and two paths that
   * already agree are one less thing to reconcile when it lands.
   */
  notificaciones: "/notificaciones",
  /**
   * MIS TURNOS — the third top-level screen that is not one pet's.
   *
   * Every row DOES name an animal, unlike the two above, and it still sits
   * beside `/mascotas` rather than under it: the question the screen answers is
   * "what do I have booked", across every animal this person is responsible for,
   * ordered by time. It also lists turnos for animals they do not own, because
   * booking accepts any active ownership role — a foster's turno is the foster's.
   *
   * THE PATH SHORTENS THE WEB'S `/mis-turnos`, exactly as `/mascotas` shortens
   * `/mis-mascotas` and for the same reason: in an app that only ever shows you
   * your own, "mis" is a word the URL does not need. Nothing deep-links here —
   * `DEEP_LINK_MAP.appointment` names the WEB path and its `mimar://` form
   * resolves to its OWN generic fallback screen (`app/appointment/
   * [appointmentToken].tsx`, F-8), not to this hub or to `turnoRoute` below —
   * so unlike `/transferencias` this path is free to say what the screen is.
   */
  turnos: "/turnos",
  /**
   * BUSCAR UN TURNO — el picker de servicio y los resultados.
   *
   * ANIDA BAJO `/turnos` Y LA WEB NO ANIDA SU EQUIVALENTE BAJO `/mis-turnos`. El
   * navegador tiene dos árboles sin relación para una feature — `/turnos/buscar`
   * para encontrar uno y `/mis-turnos` para ver los que tenés — porque su nav los
   * hizo crecer aparte, y el tablero registra que ninguno de los dos está en esa
   * nav: se llega por deep link. Un stack navigator no tiene esa historia, y en un
   * teléfono el arreglo honesto es el que la persona camina: abrís tus turnos, no
   * tenés el que necesitás, lo buscás.
   */
  buscarTurnos: "/turnos/buscar",
  /**
   * RECLAMAR UNA MASCOTA — the only top-level screen that is about an animal
   * this person does NOT hold, and does not (yet) have any relationship to.
   *
   * `/transferencias` and `/notificaciones` sit beside `/mascotas` because HALF
   * of what they carry is about somebody else's animal. This one is further out:
   * ALL of it is, by definition. It is also why the path names no pet — the
   * server resolves the animal from the private identifier and refuses to be
   * told which one it is, which is the whole authorization story of the feature
   * (`submit-free-claim.ts` calls the identifier "the evidence").
   *
   * THE PATH SHORTENS THE WEB'S `/mis-mascotas/reclamar`, the way `/mascotas`
   * shortens `/mis-mascotas`: the web nests it under the list because that is
   * where its entry point is, and a stack navigator has no such requirement.
   * Nothing deep-links here and nothing may — a `mimar://reclamar` URL would be
   * an unverified custom scheme any installed app can claim, standing in front
   * of the flow that hands over an animal.
   */
  reclamar: "/reclamar",
  /**
   * El catálogo de adopción — THE FIRST SCREEN IN THIS APP ABOUT ANIMALS NOBODY
   * IN IT HOLDS. `/mascotas` is what this person is responsible for;
   * `/transferencias` and `/notificaciones` are addressed to them. This one is a
   * public catalogue a shelter published, and it sits beside those three rather
   * than under any of them for exactly that reason.
   *
   * THE PATH IS `/adoptar` AND NOT `/adopciones`, matching the WEB's public
   * landing rather than the org-side queue's. That distinction is the whole
   * feature: `/adopciones` on the web is what a REFUGIO opens to review
   * applications, and this app has no org surfaces at all. Naming the citizen
   * screen after the org one would put the two a rename apart.
   */
  adoptar: "/adoptar",
  /**
   * Mis postulaciones.
   *
   * UNDER `/adoptar` AND NOT UNDER `/mascotas`, which is where the WEB puts it
   * (`/mis-mascotas/postulaciones`). The web's placement is a fact about its
   * navigation — everything a citizen owns hangs off `/mis-mascotas` there — and
   * following it here would file "animals I asked to adopt" under "animals I am
   * responsible for", which is the one distinction this screen exists to keep.
   * A person with no pets has postulaciones; a person with postulaciones has no
   * pet yet, by definition.
   *
   * Nothing links in from outside the app, so no deep-link argument pins the
   * path — and if one ever does, `DEEP_LINK_MAP` is where the two forms are
   * reconciled, not here.
   */
  adoptarPostulaciones: "/adoptar/postulaciones",
  /**
   * DENUNCIAR MALTRATO — the route that is not about an animal anybody in this
   * app holds, and often not about a registered animal at all.
   *
   * `/reclamar` is one step further out than `/transferencias` because ALL of
   * what it carries is about somebody else's animal. This is one step further
   * again: the subject is usually an animal with no owner in the registry, seen
   * in a place the person walked past, and the denuncia accuses a NAMED THIRD
   * PARTY of a crime under Ley 14.346. There is nothing in this tree it belongs
   * under.
   *
   * THE PATH IS A VERB AND DOES NOT MATCH THE WEB'S `/denuncias/nueva`, which is
   * the first path in this file to diverge for a reason other than shortening.
   * The web nests the form under the public denuncia section because that section
   * has other pages — `/denuncias`, `/denuncias/buscar`, `/denuncias/codigo/…`,
   * `/denuncias/seguimiento` — and this app has none of them: it can file one and
   * it can do nothing else with one, because following a denuncia needs the
   * reporter-session cookie a bearer client has no jar for. A `/denuncias/nueva`
   * here would be a "nueva" with nothing to be new AMONG.
   *
   * Nothing deep-links here and nothing may. `DEEP_LINK_MAP.welfareReport` names
   * the CONSTANCIA (`/denuncias/codigo/:referenceCode`) with `appPath: null`,
   * which is correct and must stay that way: a `mimar://denunciar` URL would be
   * an unverified custom scheme any installed app can claim, standing in front of
   * a form that files a criminal allegation.
   */
  denunciar: "/denunciar",
  /**
   * TRÁNSITO — proposals awaiting a volunteer's answer, plus the fosters that
   * came of one. THE FOURTH TOP-LEVEL SCREEN THAT IS NOT ONE PET'S, for
   * `/transferencias`'s own reason: half of what it holds is an offer to care
   * for an animal the reader does not yet have.
   *
   * THE PATH DOES NOT MATCH THE WEB'S `/cuenta/transitos`, which is three
   * pages (propuestas, activos, historial) this app folds into one hub —
   * `GET /api/v1/me/foster` answers all three in one round trip, the way
   * `/me/caretaker-grants` folds its own two web doors. Matching the web's
   * plural would promise a page this app does not have.
   *
   * IT IS a deep-link destination — `DEEP_LINK_MAP.fosterProposal.appPath`
   * points here — even though the web path carries a `:proposalToken` this
   * screen does not take: `pathParamNames` only requires an `appPath`'s own
   * placeholders to be a SUBSET of the web path's, never the whole set, and
   * opening the hub is enough for the person to find the one proposal a
   * notification named. See that table entry.
   */
  transito: "/cuenta/transito",
} as const;

/**
 * `/recuperar`, with the address already typed elsewhere carried along.
 *
 * U-3 (native review, PO decision 21A): the sign-in screen's "¿Olvidaste tu
 * contraseña?" used to open `ROUTES.recuperar` bare, so an address already
 * typed into the email field had to be re-typed on the very next screen.
 * `email` is OPTIONAL and OMITTED WHEN EMPTY, the way `credentialRoute`'s
 * `face` is: recovery reached with no email typed (e.g. a deep link, were one
 * ever added) must still open the plain ask-step form rather than a URL
 * carrying `email=`.
 */
export function recuperarRoute(email?: string): "/recuperar" | `/recuperar?email=${string}` {
  const trimmed = email?.trim();
  if (!trimmed) return "/recuperar";
  return `/recuperar?email=${encodeURIComponent(trimmed)}`;
}

/**
 * One turno.
 *
 * NOT A DEEP-LINK DESTINATION, and the distinction matters here more than
 * anywhere else in this file. `DEEP_LINK_MAP.appointment` names
 * `appointment/{token}` — a QR payload kept byte-for-byte for a front-desk
 * reader that has never been built — and that path does NOT match this route;
 * since F-8 it resolves to its own generic fallback screen instead
 * (`app/appointment/[appointmentToken].tsx`). Adding this path to that table
 * would change the string the web already prints on every check-in QR, which is
 * a debt to close deliberately and not a side effect of adding a screen.
 * Recorded here so the next reader does not "fix" the mismatch by hand.
 */
export function turnoRoute(appointmentToken: string): `/turnos/${string}` {
  return `/turnos/${encodeURIComponent(appointmentToken)}`;
}

/**
 * La grilla de horarios de una offering, y la reserva.
 *
 * UNA PANTALLA PARA LO QUE LA WEB PARTE EN DOS PÁGINAS. La grilla vive en
 * `/turnos/buscar/{offering}` y el picker de mascota en `.../reservar/{slotId}`,
 * que es una segunda página y un segundo round trip en el medio de un flujo de
 * dos toques. La lectura acá trae la grilla Y las mascotas reservables juntas,
 * porque la pantalla no puede ofrecer un horario honestamente a alguien sin
 * mascota reservable — y eso lo tiene que saber ANTES de dibujar la grilla.
 *
 * EL SEGMENTO ES EL TOKEN PÚBLICO DE LA OFFERING (`OFR-XXXX-XXXX`), cubierto por
 * `CAPABILITY_PATH_SEGMENTS` a través de `buscar` — la misma entrada que cubre
 * `/turnos/buscar/[offeringToken]` de la web, porque la regla de redacción se
 * fija en el segmento PADRE y los dos árboles lo escriben igual.
 */
export function buscarOfferingRoute(offeringToken: string): `/turnos/buscar/${string}` {
  return `/turnos/buscar/${encodeURIComponent(offeringToken)}`;
}

/**
 * One adoption ficha.
 *
 * THE SEGMENT IS THE PET'S PUBLIC TOKEN, which makes this path collide in shape
 * with `/adoptar/postulaciones` — expo-router resolves the STATIC segment first,
 * so a shelter would have to publish an animal whose token is literally
 * "postulaciones" for that to matter, and tokens are `DIM-XXXX-XXXX`. Said out
 * loud because a future static sibling with a token-shaped name would not be so
 * safe.
 */
export function adoptionDetailRoute(petToken: string): `/adoptar/${string}` {
  return `/adoptar/${encodeURIComponent(petToken)}`;
}

/**
 * The application form for one animal.
 *
 * NESTED UNDER THE FICHA rather than living beside it, and the reason is the
 * back gesture: somebody who abandons the form should land on the animal they
 * were reading about, not on the catalogue they scrolled past. The web nests it
 * the same way (`/adoptar/{token}/postular`) for the same reason.
 */
export function adoptionApplyRoute(
  petToken: string,
  petName?: string | null,
): `/adoptar/${string}/postular${string}` {
  // THE NAME IS DISPLAY COPY AND NOTHING ELSE. It travels so the form can say
  // "Adoptar a Lola" instead of "Postularme", and the screen it lands on already
  // holds the animal's whole ficha — so this is one string, not a second round
  // trip for a word the caller has in its hand. Nothing branches on it: if it is
  // absent or stale the title degrades and no request changes, because the
  // ANIMAL is named by the path segment the server resolves.
  const suffix = petName ? `?petName=${encodeURIComponent(petName)}` : "";
  return `/adoptar/${encodeURIComponent(petToken)}/postular${suffix}`;
}

/**
 * One transfer proposal.
 *
 * THE DEEP-LINK-HEAVY ONE. This is where `mimar://transferencias/{PTR-…}` lands
 * and where the `pet_transfer_received` notification points, so the segment
 * shape here is not free: it must equal the web's `/transferencias/:transferToken`
 * so `DEEP_LINK_MAP.petTransfer` can carry both forms of one destination.
 */
export function transferRoute(transferToken: string): `/transferencias/${string}` {
  return `/transferencias/${encodeURIComponent(transferToken)}`;
}

/**
 * The "ofrecer la titularidad" form for one pet.
 *
 * NESTED UNDER THE PET even though the other three transfer commands are not,
 * and the asymmetry is the feature's: `initiate` is the only one addressed by an
 * ANIMAL. The other three name a proposal, and a proposal outlives the sender's
 * relationship to the pet — which is the whole point of accepting one.
 */
export function transferPetRoute(publicToken: string): `/mascotas/${string}/transferir` {
  return `/mascotas/${encodeURIComponent(publicToken)}/transferir`;
}

/**
 * The query parameter that names which face of the document to open on.
 *
 * Named once, here, because it is written by `credentialRoute` and read by
 * `app/mascotas/[publicToken].tsx` — two files that would otherwise agree on a
 * string literal by coincidence, which is the failure this whole module exists
 * to prevent for paths.
 */
export const DOCUMENT_FACE_PARAM = "face";

/**
 * One pet's document.
 *
 * `face` IS OPTIONAL AND THE OMISSION IS THE DEFAULT, not a shrug: the document
 * opens on the credential, which is what a person navigating to an animal
 * expects to see. It is passed only by a caller that knows better — today just
 * the writer's "Volver a la libreta", which returns a person to the face they
 * were writing into (native QA batch 1, D3). A return that landed on the front
 * of a document whose back had just been written is not a wrong screen, it is a
 * lost place.
 */
export function credentialRoute(
  publicToken: string,
  options: { face?: "credencial" | "libreta" } = {},
): `/mascotas/${string}` {
  const suffix = options.face ? `?${DOCUMENT_FACE_PARAM}=${options.face}` : "";
  return `/mascotas/${encodeURIComponent(publicToken)}${suffix}`;
}

/**
 * One pet's PUBLIC credential — the anonymous document behind the QR.
 *
 * A ROUTE AND NOT A FACE, since the two-face rewrite (PO decision, 2026-08-28):
 * the web's card has exactly two faces (Credencial · frente, Libreta · dorso)
 * and its public document lives one tap away at `/p/{token}`. This is that tap,
 * reached from the profile's QR block and from "Más" — mirroring where the web
 * puts it rather than surfacing the public page as a third tab beside the two
 * faces it is not one of.
 */
export function publicCredentialRoute(publicToken: string): `/mascotas/${string}/credencial` {
  return `/mascotas/${encodeURIComponent(publicToken)}/credencial`;
}

/**
 * One asiento of one pet's libreta.
 *
 * A REAL ROUTE and not a panel inside the libreta tab, because a detail screen
 * is a page: it earns the back gesture, the stack header and — when the deep
 * link work lands — an address. Nesting it under the pet is what makes the back
 * gesture land on the libreta rather than on the pet list.
 */
export function libretaEventRoute(
  publicToken: string,
  eventId: string,
): `/mascotas/${string}/eventos/${string}` {
  return `/mascotas/${encodeURIComponent(publicToken)}/eventos/${encodeURIComponent(eventId)}`;
}

/**
 * The "Asentar" form for one pet.
 *
 * `kind` and `source` are OPTIONAL and travel together: they exist for the
 * "Terminar medicación" affordance on a `medication_started` asiento, which is
 * the only place a person already holds the identifier a medication END needs.
 * Called with neither, this opens the picker.
 */
export function recordEventRoute(
  publicToken: string,
  options: { kind?: string; sourceEventId?: string } = {},
): `/mascotas/${string}/asentar${string}` {
  const query = new URLSearchParams();
  if (options.kind) query.set("kind", options.kind);
  if (options.sourceEventId) query.set("source", options.sourceEventId);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `/mascotas/${encodeURIComponent(publicToken)}/asentar${suffix}`;
}

/**
 * The lost-mode cockpit for one pet.
 *
 * A REAL ROUTE and not a fourth face on the pet screen, because it is not a
 * FACE: the three faces are documents (the owner's chrome, the libreta, the
 * public credential) and this is a workflow that only exists some of the time.
 * Nesting it under the pet is what makes the back gesture land on the animal
 * somebody came from.
 */
export function lostModeRoute(publicToken: string): `/mascotas/${string}/perdida` {
  return `/mascotas/${encodeURIComponent(publicToken)}/perdida`;
}

/**
 * The sharing cockpit for one pet — share links and the Tier-2 public window.
 *
 * A REAL ROUTE and not a face on the pet screen, for the reason modo perdida is
 * one: the faces are DOCUMENTS (the owner's chrome, the libreta, the public
 * credential) and this is a control panel over who may read them. It is also the
 * one screen in the app that holds bearer secrets, which is a second reason to
 * give it its own lifetime — it dies on back, and the tokens die with it.
 */
export function sharesRoute(publicToken: string): `/mascotas/${string}/compartir` {
  return `/mascotas/${encodeURIComponent(publicToken)}/compartir`;
}

/**
 * Editar los datos de la mascota, and the emergency contacts, on ONE screen.
 *
 * TWO ENTRY POINTS LAND HERE and that is deliberate. The web keeps them as two
 * rows of the "⋯ Más" sheet — "Editar datos y ficha" and "Contactos de
 * emergencia" — because each opens a different `?sheet=`, which is a URL
 * mechanism a stack navigator does not have. Splitting them into two native
 * routes would have bought a second copy of one fetch, one guard-derived
 * capability pair and one save path, to hide a card a person can already see by
 * scrolling. The two entry points differ in what they PROMISE and in nothing
 * else: this function takes no section argument, the screen renders both cards
 * in a fixed order — datos, then contactos — and whichever row was tapped, the
 * other is one scroll away.
 *
 * The path matches the WEB's leaf (`/mis-mascotas/{token}/editar`), unlike the
 * `?sheet=` half: nothing deep-links in today, and when something does, the
 * `mimar://` and `https` forms will already agree on the word.
 */
export function editPetRoute(publicToken: string): `/mascotas/${string}/editar` {
  return `/mascotas/${encodeURIComponent(publicToken)}/editar`;
}

/**
 * LA FOTO — the credential's image, picked and uploaded from the phone.
 *
 * A ROUTE OF ITS OWN, NOT A FIELD ON `/editar`, and the split mirrors the
 * server's: the web's photo lives inside `updatePetAction` behind the titular
 * gate BECAUSE of the other fields in that form, while `POST /pets/{token}/photo`
 * takes ANY holder role — `lib/domain/titular-only.ts` lists photos among what
 * a caretaker MAY do, and a caretaker photographing the animal in their care
 * is the case the role exists for. Folding the photo into `/editar` here would
 * bolt a caretaker-allowed act onto a screen a caretaker cannot use.
 *
 * NO WEB PATH TO MATCH: the web has no `/foto` page (its photo is a form
 * field), so the segment is free to say the word the screen uses.
 */
export function petPhotoRoute(publicToken: string): `/mascotas/${string}/foto` {
  return `/mascotas/${encodeURIComponent(publicToken)}/foto`;
}

/**
 * MUDANZA — registrar que el animal cambió de jurisdicción.
 *
 * UNA RUTA APARTE DE `/editar`, Y NO ES UNA DECISIÓN DE ESTA APP. La
 * jurisdicción es FULL-LOCK en el camino de editar (PO decision #40): el writer
 * de perfil omite las tres columnas de su `SET` y cada una tiene su propio
 * camino gobernado por eventos. Una mudanza APPENDS un `movement_recorded` a la
 * libreta y mueve las columnas que deciden qué autoridad responde por el animal;
 * un cambio de nombre no. Meterlas en una pantalla sería juntar dos actos que el
 * servidor autoriza y registra distinto.
 *
 * SE LLEGA DESDE `/editar`, que es donde la web pone su entrada: un renglón
 * bloqueado con la localidad actual y un enlace "Registrar mudanza"
 * (`components/PetForm.tsx`). El anidamiento bajo la mascota es lo que hace que
 * "atrás" caiga en el animal del que se vino.
 *
 * EL PATH COINCIDE CON EL DE LA WEB (`/mis-mascotas/{token}/mudanza`) por la
 * razón de `/editar`: hoy no entra ningún deep link, y el día que entre las dos
 * formas — `mimar://` y `https` — ya van a estar de acuerdo en la palabra.
 */
export function movePetRoute(publicToken: string): `/mascotas/${string}/mudanza` {
  return `/mascotas/${encodeURIComponent(publicToken)}/mudanza`;
}

/**
 * PRÓXIMAS VACUNAS — programar un recordatorio de vacuna, o eliminar uno.
 *
 * ONE SCREEN FOR WHAT THE WEB SPLITS IN TWO. The web schedules on a page of its
 * own (`/mis-mascotas/{token}/vacunas/programar`) and deletes inline on the
 * pet page's "Recordatorios" card. A stack navigator has no inline form
 * post, and the face here never writes (every write in this app is a route of
 * its own — `asentar`, `mudanza`, `editar`); so both operations live on this
 * one screen, and the face's reminders card is the door to it.
 *
 * THE SEGMENT MATCHES THE WEB'S PARENT (`/vacunas`), not its leaf: nothing
 * deep-links in today, and when something does the two forms already agree on
 * the word.
 */
export function vaccineRemindersRoute(publicToken: string): `/mascotas/${string}/vacunas` {
  return `/mascotas/${encodeURIComponent(publicToken)}/vacunas`;
}

/**
 * ACOMPAÑAMIENTO DE ADOPCIÓN — pedirle a una organización verificada que
 * acompañe la adopción, cancelar el pedido, o dar de baja el acompañamiento.
 *
 * ANIDADA BAJO LA MASCOTA por la razón de `cuidado`: las tres acciones se
 * autorizan contra el ANIMAL (el titular legal, y nadie más — spec REQ-14), así
 * que la mascota está de verdad en la dirección, y "atrás" cae en el animal
 * del que se vino.
 *
 * EL PATH COINCIDE CON EL DE LA WEB (`/mis-mascotas/{token}/buscar-hogar`),
 * aunque el encabezado diga "Acompañamiento de adopción": la web pone las dos
 * preguntas — la del foster ("Buscar hogar") y la del titular — en una misma
 * ruta y decide adentro a quién le habla. Acá sólo entra el titular (la fila de
 * "Más" del foster sigue diciendo "Disponible en la web"), pero el día que
 * entre un deep link las dos formas ya van a estar de acuerdo en la palabra.
 */
export function rehomeRoute(publicToken: string): `/mascotas/${string}/buscar-hogar` {
  return `/mascotas/${encodeURIComponent(publicToken)}/buscar-hogar`;
}

/**
 * DEVOLUCIÓN — responder a quien quiere devolverte el animal, o proponer
 * devolvérselo a la organización de origen.
 *
 * ANIDADA BAJO LA MASCOTA aunque la mitad de lo que muestra es sobre otra
 * persona, y esa es la diferencia con `/transferencias`, que vive al lado de
 * `/mascotas` precisamente porque la mitad de sus filas son de animales de
 * terceros. Acá el animal SIEMPRE es uno que esta persona tiene: o lo tiene
 * legalmente y alguien más lo tiene físicamente, o lo tiene en tránsito y quiere
 * devolverlo. No hay ninguna fila sobre una mascota ajena, así que la mascota
 * está de verdad en la dirección.
 *
 * EL PATH COINCIDE CON EL DE LA WEB (`/mis-mascotas/{token}/devolucion`). Hoy no
 * entra ningún deep link — `DEEP_LINK_MAP` no tiene fila para esto — pero la
 * notificación `custody_transfer_proposal_owner` es exactamente lo que un push
 * abriría, así que las dos formas ya están de acuerdo en la palabra para cuando
 * llegue.
 */
export function returnPetRoute(publicToken: string): `/mascotas/${string}/devolucion` {
  return `/mascotas/${encodeURIComponent(publicToken)}/devolucion`;
}

/**
 * The cuidador-temporal cockpit for one pet — the TITULAR'S side.
 *
 * NESTED UNDER THE PET, unlike its sibling below, and the split is the feature's
 * rather than a layout choice: designating, withdrawing an invitation and ending
 * a live arrangement are all guarded against the ANIMAL (`requireTitularAccess`),
 * so the pet is genuinely in the address. What the invitee answers is not.
 */
export function caretakerPetRoute(publicToken: string): `/mascotas/${string}/cuidado` {
  return `/mascotas/${encodeURIComponent(publicToken)}/cuidado`;
}

/**
 * One caretaker invitation — the INVITEE'S side.
 *
 * TOP-LEVEL, because the person answering holds no ownership row on the animal:
 * that is what an invitation is. Nesting it under `/mascotas` would put an
 * address on a screen for somebody who is not (yet) responsible for the pet.
 *
 * THE PATH DELIBERATELY MATCHES THE WEB'S (`/cuidado/:grantToken`), for the
 * reason `/transferencias` does: this is a deep-link destination, the invitation
 * e-mail and the notification CTA both name the web form, and keeping the two
 * identical means the `mimar://` and `https` forms differ only in scheme — one
 * less place for `DEEP_LINK_MAP.caretakerGrant` to drift.
 */
export function caretakerGrantRoute(grantToken: string): `/cuidado/${string}` {
  return `/cuidado/${encodeURIComponent(grantToken)}`;
}

/**
 * One case — `/casos/{publicCode}`, the WEB's path, and for the reason
 * `/transferencias` keeps its own: a notification's `cta_url` names the web
 * form, and keeping the two identical is what lets the deep-link table map one
 * onto the other without a translation that could drift.
 */
export function caseRoute(publicCode: string): `/casos/${string}` {
  return `/casos/${encodeURIComponent(publicCode)}`;
}

/**
 * PHYSICAL TAG — D2 (2026-09-25): toggles interest in the §4.20
 * demand-signal placeholder, the SAME toggle the web's sheet reaches
 * (`PhysicalTagInterestSheet.tsx`).
 *
 * NESTED UNDER THE PET, for the same reason `cuidado` and `vacunas` are: the
 * write is authorized against the animal (`canTogglePhysicalTagInterest`,
 * derived from `POST /pets/{token}/profile`'s own access resolution) and "back"
 * has to land on the pet somebody came from.
 *
 * THE PATH USES THE WEB'S WORD ("chapita"), not "chapa-fisica": the sheet's
 * own query param is `?sheet=chapita` and the printable-QR sub-page is
 * `/mis-mascotas/{token}/chapita` — one word, kept the same across both forms
 * for the day a deep link needs it.
 */
export function physicalTagInterestRoute(publicToken: string): `/mascotas/${string}/chapita` {
  return `/mascotas/${encodeURIComponent(publicToken)}/chapita`;
}

export type AppRoute =
  | (typeof ROUTES)[keyof typeof ROUTES]
  | ReturnType<typeof credentialRoute>
  | ReturnType<typeof publicCredentialRoute>
  | ReturnType<typeof libretaEventRoute>
  | ReturnType<typeof recordEventRoute>
  | ReturnType<typeof lostModeRoute>
  | ReturnType<typeof sharesRoute>
  | ReturnType<typeof editPetRoute>
  | ReturnType<typeof petPhotoRoute>
  | ReturnType<typeof movePetRoute>
  | ReturnType<typeof vaccineRemindersRoute>
  | ReturnType<typeof rehomeRoute>
  | ReturnType<typeof returnPetRoute>
  | ReturnType<typeof transferRoute>
  | ReturnType<typeof transferPetRoute>
  | ReturnType<typeof caretakerPetRoute>
  | ReturnType<typeof caretakerGrantRoute>
  | ReturnType<typeof caseRoute>
  | ReturnType<typeof physicalTagInterestRoute>
  | ReturnType<typeof turnoRoute>
  | ReturnType<typeof buscarOfferingRoute>;
