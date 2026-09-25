// THE error switch. One per app, not one per endpoint.
//
// This is `apiErrorMessage` and `apiV1ErrorCode`, lifted verbatim out of
// `credential/credential-api.ts` when the app grew a second caller. The lifting
// is the point: the switch is exhaustive over `API_V1_ERROR_CODES` with no
// `default` and no trailing return, so a code added to the contract is a COMPILE
// error here — and that guarantee is worth exactly as much as the number of
// copies of the switch, which must therefore be one.
//
// It has already earned its keep three times. It covered the three codes the
// vocabulary had when it was written; WU-A widened `API_V1_ERROR_CODES` from
// three to ten on a branch that did not contain this app and the two merged
// without touching a common file (git had nothing to report); WU-B added the
// three write codes; B9 added `session_shift_expired`. Every one of those was
// found by the typechecker and by nothing else.
//
// A FAILURE THAT MAPS TO NO MESSAGE renders as an empty `<Text>` under a "no se
// pudo" heading — a blank where an explanation should be, which is the same
// class of dishonesty as a blank `unavailable` section. Two things enforce that
// it cannot happen: the code is validated against the contract's CLOSED
// vocabulary at the parse boundary (`apiV1ErrorCode`) rather than merely
// asserted by a type, and the switch below is exhaustive.

import { API_V1_ERROR_CODES, type ApiV1ErrorCode } from "@dim/contract/api";

/**
 * The endpoint's error vocabulary, as a runtime set.
 *
 * `API_V1_ERROR_CODES` is exported by the contract as a frozen array precisely
 * so a client can do this instead of hard-coding the strings. Checking
 * MEMBERSHIP — not just `typeof === "string"` — is what keeps an unrecognised
 * code from flowing into a result union as a valid `ApiV1ErrorCode` it is not,
 * and then falling out of the message switch as a blank line on the screen.
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(API_V1_ERROR_CODES);

/** The declared error code, or `null` if the body does not carry a known one. */
export function apiV1ErrorCode(body: unknown): ApiV1ErrorCode | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? (code as ApiV1ErrorCode) : null;
}

/**
 * The body DID declare a code and this build has never heard of it (CANON-451).
 *
 * `apiV1ErrorCode` answers `null` for three different situations — no body, no
 * `error` field, and a code outside the vocabulary — and collapsing them cost
 * the app its only signal for version skew. An OTA channel makes that skew
 * ordinary in BOTH directions: a bundle can outlive the server it was written
 * against, and a server can ship a code a published bundle will never know.
 *
 * Distinguishing it matters because the two answers send a person to different
 * places. "El servidor no pudo responder, volvé a intentar en unos segundos" is
 * an instruction to wait, and waiting will never help — the code will still be
 * unknown tomorrow. "Actualizá la app" is the only move that works.
 */
export function carriesUnknownErrorCode(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" && code.length > 0 && !KNOWN_ERROR_CODES.has(code);
}

/**
 * What to say about a refusal whose code this build cannot read.
 *
 * NOT the raw code. `error: "welfare_case_reopen_forbidden"` on screen is a
 * developer's string in a citizen's wallet: unreadable, untranslated, and it
 * names an internal concept rather than anything the person can act on.
 */
export const UNKNOWN_API_ERROR_MESSAGE =
  "El servidor respondió con un motivo que esta versión de la app no conoce. Actualizá la app.";

/**
 * es-AR copy for a code that arrived ON THE WIRE — known or not.
 *
 * `apiErrorMessage` below stays exhaustive with no `default` and no trailing
 * return, which is what makes a code added to the contract a COMPILE error
 * here. That guarantee is worth keeping exactly as it is, so the runtime
 * fallback lives in this second door instead of being folded into the switch:
 * a `default:` arm would answer for the new code and the typechecker would stop
 * asking anybody to write its sentence.
 */
export function apiErrorMessageForWireCode(code: string): string {
  return KNOWN_ERROR_CODES.has(code)
    ? apiErrorMessage(code as ApiV1ErrorCode)
    : UNKNOWN_API_ERROR_MESSAGE;
}

/** es-AR copy for each API error code. Exhaustive: every code has a sentence. */
export function apiErrorMessage(code: ApiV1ErrorCode): string {
  switch (code) {
    case "rate_limited":
      return "Demasiadas consultas. Esperá un momento y volvé a intentar.";
    case "not_found":
      return "No encontramos una credencial para este código.";
    case "temporarily_unavailable":
      return "El servidor no pudo responder. Volvé a intentar en unos segundos.";
    case "auth_required":
      return "Necesitás iniciar sesión para ver esto.";
    case "auth_expired":
      return "Tu sesión venció. Iniciá sesión de nuevo.";
    // One sentence for "no such account" and for "wrong password" alike — the
    // contract keeps the two byte-identical so this endpoint never becomes an
    // account-enumeration oracle, and copy that split them would undo that.
    case "invalid_credentials":
      return "El email o la contraseña no coinciden.";
    case "account_deactivated":
      return "Esta cuenta está desactivada. Si la desactivaste vos, podés volver a activarla desde Mi cuenta en la web; si la desactivó tu organización, hablá con ella.";
    case "account_erased":
      return "Esta cuenta ya no existe.";
    // B9. Deliberately NOT the `auth_expired` sentence, even though both are
    // 401s: that one says "tu sesión venció", which invites a refresh, and a
    // refresh here SUCCEEDS (the session is valid at GoTrue — the 8-hour
    // operator shift is our policy) and the retry is refused again, forever.
    // This copy has to send the person through a full sign-in.
    //
    // A citizen wallet has no operator surface, so nobody using this app should
    // ever see it. Answered because this function's contract is the whole
    // vocabulary, not one endpoint's subset.
    case "session_shift_expired":
      return "Tu turno de trabajo terminó. Volvé a iniciar sesión para seguir.";
    case "invalid_request":
      return "La app envió un pedido que el servidor no pudo leer. Actualizá la app.";
    case "signup_failed":
      return "No pudimos crear la cuenta. Volvé a intentar en unos minutos.";
    // NAMES THE FIX, because the generic sentence above names a remedy that is
    // impossible here: waiting changes nothing about a password. It also does
    // not say "insegura" or "débil" as a scolding — the person did nothing
    // wrong, the password is simply one a lot of people already use.
    case "weak_password":
      return "Esa contraseña es muy fácil de adivinar. Probá con otra que no uses en ningún otro lado.";
    // Says WHAT IS MISSING and WHERE it gets fixed. "No tenés permiso" would be
    // the wrong sentence twice over: nothing was denied to this person, and the
    // remedy is a step they can take right now. The app already routes a
    // `profilePending` session to `identidad-pendiente`, so a person only reads
    // this if a gate was skipped — which is the case the code exists for.
    case "identity_pending":
      return "Todavía no completaste tus datos. Terminá el registro para poder registrar una mascota.";
    // The three codes of `POST /api/v1/me/identity`, which is the screen that
    // FIXES the state above — so none of these sentences may send the person to
    // "terminá el registro". They are already there.
    case "identity_name_provisional":
      // NAMES THE FIELD, not the request. The person typed something the server
      // cannot tell apart from the provisional name it is replacing, and the only
      // move is to type a different one. Nearly unreachable in practice (see the
      // contract), which is why it says what to do rather than apologising.
      return "Ese nombre no nos sirve para identificarte. Escribí tu nombre y apellido reales.";
    case "identity_already_complete":
      // NOT "no tenés permiso": nothing was denied and nothing is missing. The
      // person's data is already loaded and this door only ever loads it once, so
      // the sentence names the place where a name actually changes. A gate that
      // is working sends nobody here — reaching it means the app's copy of
      // `profilePending` was stale, which "actualizá" alone would not explain.
      return "Tus datos ya están cargados. Si querés corregirlos, entrá a Ajustes → Editar mis datos.";
    case "identity_failed":
      // Retrying IS safe and the copy says so: completing an identity is a value,
      // not an append, so writing the same two names twice writes them once.
      return "No pudimos guardar tus datos. Volvé a intentar.";
    // Covers BOTH halves of the code: the header was absent, OR it was present
    // and not a UUID. They were joined into one code deliberately (see
    // `idempotency_key_required` in @dim/contract/api — the fix is the same
    // sentence either way).
    case "idempotency_key_required":
      return "La app envió un registro con una clave de reintento ausente o mal formada. Actualizá la app.";
    case "duplicate_pet_suspected":
      return "Ya tenés una mascota registrada con ese nombre. Revisá tu lista antes de crear otra.";
    case "pet_registration_failed":
      return "No pudimos completar el registro. Volvé a intentar en unos minutos.";
    // WU-J, the correction codes. A screen that got here has already been told
    // the specific reason — `PetEventDetailV1.amend.refusal` carries it — so
    // these are the sentences for a client that reached the door anyway.
    case "amend_forbidden":
      // The web's own words, verbatim: the person needs a capability granted,
      // and naming it is what lets them ask for the right thing.
      return "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.";
    case "amend_not_allowed":
      // Covers both halves of the code — a type outside the allowlist, and a
      // deceased animal — because the client's move is the same either way and
      // the screen already holds the precise reason.
      return "Este registro no admite correcciones.";
    case "amend_failed":
      return "No pudimos guardar la corrección. Volvé a intentar en unos minutos.";
    // FI-7. Reachable only for an `admin` or `govt` profile — a rule about WHO
    // is asking, which no wire schema can check, so the refusal can only arrive
    // from the server and has to say what to do about it. A citizen wallet's
    // user never sees this; an administrator who also owns a pet does.
    case "amend_reason_required":
      return "Para corregir este registro tenés que indicar un motivo de al menos 5 caracteres.";
    // WU-K, the writer codes. Every one of these is reachable from an "Asentar"
    // form, and every sentence has to say what the person does NEXT — these are
    // shown under a filled-in form somebody is waiting to submit.
    case "event_forbidden":
      // The web's own words: the person needs a capability granted, and naming
      // it is what lets them ask for the right thing.
      return "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.";
    case "event_not_allowed":
      // A closed life record. Deliberately says which asiento IS still
      // accepted, because the endpoint accepts it and a bare refusal would hide
      // the one thing left to do.
      return "Esta mascota está registrada como fallecida y no acepta nuevos registros clínicos. Sí podés dejar una nota.";
    // THE THREE PREGNANCY REFUSALS, and they are three sentences rather than
    // one because each names a DIFFERENT next move — which is the same reason
    // the contract gave them three codes instead of reusing
    // `event_not_allowed`. That code's sentence above is about a deceased
    // animal, and it is the sentence a male dog would have been shown.
    case "pregnancy_not_applicable":
      // No next move exists, so the sentence does not invent one. It says what
      // is true and stops — a "probá con…" here would be a suggestion to do
      // something impossible.
      return "Esta mascota no puede tener un embarazo registrado: el seguimiento es solo para hembras de una especie con gestación conocida.";
    case "pregnancy_already_open":
      return "Esta mascota ya tiene un embarazo en seguimiento. Cerralo primero y después registrá el nuevo.";
    case "pregnancy_none_open":
      return "Esta mascota no tiene un embarazo en seguimiento para cerrar. Registrá primero el inicio.";
    // THE THREE CHECK-IN REFUSALS. Three sentences because each names a
    // different next move — none, none-for-you, and wait — and the third is
    // the web page's own wording for the same fact ("Sin check-ins
    // pendientes"), so a person reads the same explanation on both doors.
    case "checkin_not_adopted":
      return "Esta mascota no tiene una adopción registrada en miMAR, así que no hay un refugio al que enviarle un check-in.";
    case "checkin_not_adopter":
      return "Solo el adoptante registrado puede enviar el check-in de esta mascota.";
    case "checkin_no_open_window":
      return "Esta mascota no tiene un check-in post-adopción pendiente en este momento. Si el refugio te pide otro seguimiento más adelante, te vamos a avisar.";
    case "event_date_future":
      return "La fecha no puede ser futura.";
    case "event_date_before_birth":
      // NOT folded into the sentence above, because the fix is different: either
      // the date is wrong or the birth date on the record is, and only the
      // person can say which.
      return "La fecha es anterior a la fecha de nacimiento registrada de la mascota.";
    case "same_day_duplicate_suspected":
      // A PROMPT, not a wall. The screen turns this code into a confirm
      // affordance that resends with the override; this sentence is the
      // fallback for anywhere that does not.
      return "Ya hay un registro igual para esta mascota en esta fecha.";
    case "medication_source_invalid":
      return "No pudimos identificar la medicación que estás terminando. Abrila desde su asiento en la libreta.";
    case "event_failed":
      return "No pudimos guardar el registro. Volvé a intentar en unos minutos.";
    // WU-M, modo perdida. These arrive while somebody is looking for an animal,
    // which is the worst moment to read a sentence that does not say what to do,
    // so every one of them names the next move.
    case "lost_already":
      return "Esta mascota ya está marcada como perdida. Abrí su búsqueda para actualizar dónde la vieron.";
    case "pet_not_lost":
      // Covers the honest case (somebody else already marked it found) and the
      // stale one (the app's copy of the status is old). Both fix the same way.
      return "Esta mascota no está marcada como perdida. Actualizá la pantalla para ver su estado.";
    case "lost_episode_closed":
      // NOT the sentence above, because the animal IS lost and the fix is
      // specific and available: reopen the search, then update.
      return "La búsqueda de esta mascota se cerró por inactividad. Reactivala para volver a cargar avistajes.";
    case "lost_forbidden":
      // Two cases, one sentence, because the person's position is the same in
      // both: they hold the animal and this particular decision is not theirs.
      return "Esta acción es solo del titular de la mascota.";
    case "lost_microchip_invalid":
      return "El número de microchip no tiene un formato válido. Revisalo o dejalo vacío.";
    case "lost_report_target_invalid":
      // The item the person tapped is not on this animal's feed any more —
      // somebody else already reported it, or the screen is holding an old copy
      // of the list. Both fix by re-reading, and neither is the person's fault,
      // so the sentence says what to do and does not accuse them of anything.
      return "Ese mensaje ya no está en la búsqueda. Actualizá la pantalla para ver el listado al día.";
    case "lost_failed":
      return "No pudimos completar la acción. Volvé a intentar en unos minutos.";
    case "share_forbidden":
      // Covers three different web refusals — a caretaker, an org member with no
      // `ownerships` row, and a holder who did not create the link they are
      // trying to revoke. The sentence names the rule rather than the identity,
      // because the screen already knows which control was pressed.
      return "No tenés permiso para esta acción de compartir.";
    case "share_limit_reached":
      return "Llegaste al máximo de links activos. Revocá uno para crear otro.";
    case "tier2_not_allowed":
      return "No se puede mostrar la libreta en la credencial pública de una mascota fallecida.";
    // WU-O, transferencias. These land on a screen where somebody is about to
    // give away an animal or take one, so every sentence names the next move and
    // none of them implies a retry that cannot work.
    case "transfer_forbidden":
      // Three different rules behind one code — not the current owner, not the
      // addressee, not the sender. The sentence names the SITUATION rather than
      // which rule refused, because saying which would describe somebody else's
      // proposal, and because the fix is the same in all three: re-read.
      return "Esta propuesta no es tuya para responder. Actualizá la pantalla.";
    case "transfer_self":
      return "No podés transferirte una mascota a vos mismo/a. Revisá el email del receptor.";
    case "transfer_not_allowed":
      // Four situations, one sentence, and the screen can do better: the pet
      // payload it already holds carries `status` and the rehome banner, so a
      // client that re-reads names the real obstacle. This is the fallback.
      return "La situación de esta mascota no permite transferirla ahora. Abrí su ficha para ver por qué.";
    case "transfer_pending_exists":
      return "Ya hay una transferencia pendiente para esta mascota. Cancelala antes de enviar otra.";
    case "transfer_already_resolved":
      // AMBIGUOUS AFTER A TIMEOUT, and the copy must not pretend otherwise: the
      // first attempt may well have landed. "Actualizá" is the honest
      // instruction; "volvé a intentar" would be wrong advice.
      return "Esta propuesta ya fue respondida o cancelada. Actualizá la pantalla para ver cómo quedó.";
    case "transfer_expired":
      // NOT the sentence above. Nothing was decided — the seven days ran out —
      // and the fix is specific and available: ask for a new proposal.
      return "La propuesta venció. Pedile a quien te la envió que la vuelva a iniciar.";
    case "transfer_failed":
      // NO retry advice, unlike `event_failed`. Without an idempotency key a
      // blind retry of "aceptar" cannot be told from a second attempt.
      return "No pudimos completar la operación. Actualizá la pantalla para ver cómo quedó.";
    // WU-P, cuidador temporal. Two audiences read these: a titular arranging for
    // somebody to look after their animal, and a person deciding whether to take
    // that on. Neither is in a crisis, but both are about to be responsible for a
    // living thing, so no sentence here may leave the next move unsaid.
    case "caretaker_forbidden":
      // Four different rules behind one code — you are the caretaker and not the
      // titular, you did not grant this invitation, or it is not addressed to
      // you. The sentence names the SITUATION and not which rule refused, because
      // saying which would describe somebody else's arrangement.
      return "Esta acción no es tuya para hacer. Actualizá la pantalla para ver cómo quedó.";
    case "caretaker_self":
      return "No podés designarte a vos mismo/a como cuidador/a. Revisá el correo de la persona.";
    case "caretaker_period_invalid":
      // One sentence for four date refusals, because the move is one move. The
      // screen holds `CARETAKER_MAX_DURATION_DAYS` and bounds its own picker, so
      // reaching this code means the dates were wrong in a way the picker could
      // not prevent.
      return "Revisá las fechas del cuidado: tienen que ser reales, futuras y dentro del máximo permitido.";
    case "caretaker_grant_exists":
      return "Esta mascota ya tiene un cuidado en curso. Terminá o retirá el que está antes de invitar a alguien más.";
    case "caretaker_already_resolved":
      // AMBIGUOUS AFTER A TIMEOUT, exactly like `transfer_already_resolved`: the
      // first attempt may well have landed. "Actualizá" is the honest
      // instruction; "volvé a intentar" would be wrong advice.
      return "Este cuidado ya no está en ese estado. Actualizá la pantalla para ver cómo quedó.";
    case "caretaker_expired":
      // NOT the sentence above. Nothing was decided — the period the invitation
      // offers is simply over — and the fix is specific: ask for new dates.
      return "El período de este cuidado ya terminó. Pedile al titular que te invite de nuevo con fechas nuevas.";
    case "caretaker_granter_not_titular":
      // The one refusal on this surface where re-reading is a DEAD END: the
      // invitation still reads pending, and the person who sent it can no longer
      // re-send it. The sentence has to redirect the person to somebody else.
      return "Quien te invitó ya no es titular de esta mascota. Pedile al titular actual que te invite de nuevo.";
    case "caretaker_failed":
      // NO retry advice, for the same reason `transfer_failed` gives none.
      return "No pudimos completar la operación. Actualizá la pantalla para ver cómo quedó.";
    case "photo_forbidden":
      // Today this reaches only an org-path caller without `event.write`. The
      // sentence names the permission the way the web names it, so the person
      // can repeat it to whoever administers their organización.
      return "No tenés permiso para cambiar la foto de esta mascota. Pedile a un administrador el permiso «Registrar eventos clínicos».";
    case "photo_not_an_image":
      // The file, not the request. "Volvé a intentar" would be wrong advice:
      // the same file will fail again.
      return "Ese archivo no es una foto que podamos usar. Elegí una imagen JPG, PNG o WebP.";
    case "photo_failed":
      // The ONE arm on this surface where retrying is honestly safe: a photo is
      // a value, not an append, so setting it twice is setting it once.
      return "No pudimos guardar la foto. Volvé a intentar.";
    // Editar datos y contactos de emergencia. The screen reads `capabilities`
    // and does not offer a control it may not use, so reaching either refusal
    // below means the arrangement changed under the person's feet — somebody
    // transferred the animal, or a cuidado started — and "actualizá" is the
    // honest instruction rather than "pedí permiso".
    case "profile_forbidden":
      // TWO rules behind one code (see the contract). The sentence names
      // neither, because which one refused describes somebody else's role.
      return "Esta acción no es tuya para hacer. Actualizá la pantalla para ver cómo quedó.";
    case "profile_breed_invalid":
      // The FIELD, not the request. The picker offers the catalog, so this
      // reaches a person only when the value did not come from it.
      return "Esa raza no está en el catálogo. Elegí una de la lista o dejá el campo vacío.";
    case "profile_failed":
      // Retrying IS safe: an edit is a value, not an append, and repeating one
      // that already landed appends nothing at all.
      return "No pudimos guardar los cambios. Volvé a intentar.";
    // Privacidad — los dos derechos de la Ley 25.326 desde el teléfono.
    case "erasure_reason_required":
      // The screen already disables its button below five characters, so this
      // reaches a person only if their build is out of step with the contract.
      // It still names the FIELD rather than the request, because that is the
      // one thing they can act on.
      return "Contanos brevemente por qué querés darte de baja (mínimo 5 caracteres).";
    case "export_failed":
      // Retrying is safe — the export writes nothing the subject can see.
      return "No pudimos armar el archivo con tus datos. Volvé a intentar.";
    case "erasure_failed":
      // DELIBERATELY DOES NOT SAY "no se borró nada". This arm is reached when
      // the RPC itself refused, so the data really is intact — but a later step
      // failing never reaches here (it logs and still reports success), and copy
      // that promised an untouched account would be a promise this code cannot
      // keep for the case it does not cover. "Volvé a intentar" is true in both.
      return "No pudimos completar la baja. Volvé a intentar en unos minutos.";
    // Turnos. The screen reads `capabilities` and does not draw "Cancelar" on a
    // row it may not cancel, so every sentence below is reached when the world
    // moved between the read and the tap — which is why all four end in an
    // instruction to look again rather than in an apology.
    case "appointment_forbidden":
      // The turno exists and belongs to somebody else. The sentence says whose
      // it is NOT, never whose it is.
      return "Este turno no es tuyo. Volvé a Mis turnos para ver los que sí lo son.";
    case "appointment_already_resolved":
      // DELIBERATELY AMBIGUOUS, like the code (see the contract): this may be
      // the caller's own retry landing on a cancel that already committed, or
      // the clinic having moved first. Saying either one would report the
      // provider's action as the person's own, so the copy says only that the
      // row changed and sends them to look.
      return "Este turno ya cambió de estado. Actualizá la pantalla para ver cómo quedó.";
    case "appointment_past":
      // A DIFFERENT MOVE from the one above: nothing changed, the clock simply
      // passed the start time. The row is still there and still worth reading.
      return "Ese turno ya pasó, así que no se puede cancelar.";
    case "appointment_failed":
      // NOT "volvé a intentar" on its own. A retry after a commit that did land
      // answers `appointment_already_resolved`, so the honest instruction is to
      // re-read first — the place is either freed or it is not, and the list is
      // what says which.
      return "No pudimos cancelar el turno. Actualizá la pantalla para ver si quedó cancelado.";
    // Reservar un turno. Las tres terminan en una instrucción de MIRAR, no de
    // reintentar: el escritor no toma llave de idempotencia y rechaza el replay
    // en vez de absorberlo, así que una negativa después de un timeout es
    // indistinguible de que otra persona se llevó el último lugar.
    case "booking_slot_taken":
      return "Ese horario ya no está disponible. Actualizá los horarios y elegí otro.";
    case "booking_pet_not_bookable":
      return "No podés reservar un turno para esa mascota. Volvé a Mis mascotas para ver cómo está.";
    case "booking_already_in_offering":
      return "Esa mascota ya tiene un turno reservado en este servicio. Elegí otra mascota.";
    case "booking_slot_past":
      // NOT the sibling above's "ya no está disponible". Nobody took this hour —
      // it simply passed while the grid was open, so "elegí otro" is the whole
      // instruction and there is nothing to re-read first. It also must not say
      // "no se puede cancelar": that is `appointment_past`, this code's previous
      // home, and it talks about a turno the person actually holds.
      return "Ese horario ya empezó. Elegí uno más adelante.";
    // Reclamos. Both sentences end in "buscá de nuevo" rather than in an
    // apology, and that is the contract's own instruction rather than a style:
    // the LOOKUP's fresh `variant` is the only thing that says what the animal's
    // situation is now, and neither of these codes carries it.
    case "claim_not_claimable":
      // FOUR SITUATIONS BEHIND ONE CODE — an active custody of any role, a
      // deceased animal, a lost one, an open dispute — and one of them is this
      // caller's OWN successful claim being retried after a timeout. So the copy
      // must not say "otra persona la reclamó": it says the situation changed and
      // sends them to look, which is true in all four and wrong in none.
      return "Esta mascota ya no se puede reclamar así. Buscá el identificador de nuevo para ver cómo está.";
    case "claim_failed":
      // Retrying IS safe (one transaction, `SELECT … FOR UPDATE`), and it may
      // still answer `claim_not_claimable` because the first attempt landed. So
      // the instruction is to look before re-tapping, not to re-tap.
      return "No pudimos completar el reclamo. Buscá el identificador de nuevo para ver si quedó registrado.";
    // Disputas (D6). Their own three, because the two above are about claiming
    // a FREE animal and a person refused a dispute must not read that.
    case "claim_not_disputable":
      // Deceased, already disputed, held by nobody, or held by the caller or
      // their organisation — and a retry of a dispute that DID land. The copy
      // is true in every one of them and sends the person to look.
      return "No se puede iniciar una disputa por esta mascota: puede que ya haya una abierta. Buscá el identificador de nuevo para ver cómo está.";
    case "claim_evidence_refused":
      // NOTHING WAS FILED, and the photos are spent (each one is used once), so
      // the instruction is to attach them again, not to re-tap.
      return "No pudimos usar una de las fotos y no se envió la disputa. Volvé a agregar las fotos (probá con otra si alguna falla) y enviala de nuevo.";
    case "claim_dispute_failed":
      return "No pudimos enviar la disputa y no quedó registrada. Volvé a agregar las fotos y probá de nuevo en un momento.";
    case "adoption_application_refused":
      // ONE SENTENCE FOR EVERY DOMAIN REFUSAL, because that is what the code is:
      // the use-case returns es-AR prose rather than a discriminated reason, so
      // the server sends one code and this app cannot tell "ya te postulaste"
      // from "esta mascota ya no está disponible".
      //
      // SO THE COPY SENDS THE PERSON BACK TO THE FICHA, which is where the
      // difference is actually stated: `canApply` and `applyBlockedReason` come
      // back on the read, and the screen re-reads after this refusal instead of
      // guessing. Copy that picked one of the two reasons would be right about
      // half the time and confidently wrong the other half.
      return "El refugio no pudo tomar tu postulación. Volvé a la ficha para ver por qué.";
    case "adoption_application_failed":
      // Retrying is safe, and for a stronger reason than most: if the first
      // attempt in fact landed, the retry meets the duplicate-pending refusal
      // and comes back as the code above — never as a second letter in the
      // shelter's queue.
      return "No pudimos enviar tu postulación. Volvé a intentar.";
    case "welfare_report_failed":
      // TWO SERVER STATES BEHIND ONE CODE, and the copy has to be true in both:
      // either nothing was written, or the denuncia landed and the case over it
      // did not. The contract keeps them indistinguishable on purpose — telling a
      // caller on a FAILURE path whether a legal filing about a named third
      // party is now on record, with no reference code to prove it, is worse
      // than not telling them.
      //
      // So the copy does NOT say "no se registró". It says to try again and
      // names the place where the question "did it land?" can actually be
      // answered — `/denuncias/buscar`, the web's own lookup by reference code
      // — rather than inviting a blind re-send that files a second denuncia.
      return "No pudimos enviar la denuncia. Volvé a intentar en un momento; si ya te dimos un código antes, buscalo en la web antes de mandarla de nuevo.";
    case "bite_location_mismatch":
      // Both answers are the person's own; the copy names the two and lets
      // them pick which one to fix. Nothing was written.
      return "El lugar del mapa y la localidad elegida no coinciden. Mové el punto o cambiá la localidad, y volvé a registrarla.";
    case "welfare_evidence_refused":
      // NOTHING WAS FILED — the photos are checked before the row exists — so the
      // copy can say so plainly and offer the two moves that work.
      return "No pudimos usar una de las fotos. No se envió nada: sacala de la lista o probá con otra, y volvé a enviar.";
    // Mudanza. Las cuatro terminan en instrucciones DISTINTAS y por eso son
    // cuatro códigos: una manda a pedirle a otra persona, otra a corregir la
    // localidad, otra a no hacer nada, y sólo la última a reintentar.
    case "move_forbidden":
      // La persona SÍ tiene a la mascota — es cuidadora — así que la copia no
      // puede decir "no encontramos". Nombra el vínculo que tiene y quién sí
      // puede hacerlo, que es lo que hace la web en su `NotTitularNotice`.
      return "Sos cuidador/a de esta mascota: la mudanza la registra el titular.";
    case "move_destination_invalid":
      // NO es "escribí bien": el destino se elige de una lista que el servidor
      // devuelve, así que llegar acá significa que se mandó un par que la lista
      // no ofrece. La instrucción es volver a la lista.
      return "Esa localidad no figura en el catálogo. Elegila de la lista de sugerencias.";
    case "move_same_locality":
      return "Esa ya es la localidad registrada de tu mascota. No hay mudanza que anotar.";
    case "move_failed":
      // Reintentar es seguro: el escritor valida el payload ANTES de abrir la
      // transacción y el evento y la denormalización van en una sola, así que un
      // intento fallido no deja media mudanza escrita.
      return "No pudimos registrar la mudanza. Volvé a intentar en unos segundos.";
    // Devolución. Las cinco terminan en instrucciones distintas y una sola manda
    // a reintentar: dos mandan a MIRAR de nuevo (la propuesta se mueve sola,
    // porque del otro lado hay otra persona), una a esperar, y una a no
    // insistir porque nada va a cambiar.
    case "return_forbidden":
      // UN CÓDIGO PARA DOS SITUACIONES — "tenés a este animal en un rol que esta
      // función no atiende" y "esa propuesta no está dirigida a vos" — así que
      // la copia no puede nombrar ninguna de las dos. Manda a leer el estado,
      // que es lo único que sabe cuál de las dos es.
      return "Esta acción no es tuya en esta mascota. Volvé a abrir la devolución para ver qué podés hacer.";
    case "return_no_proposal":
      // Puede ser que la propuesta se haya resuelto — incluso por este mismo
      // intento, después de un timeout. Por eso no dice "no había nada": dice
      // que mires.
      return "Ya no hay una propuesta de devolución pendiente. Volvé a abrir la pantalla para ver cómo quedó.";
    case "return_already_pending":
      return "Ya hay una propuesta de devolución en curso para esta mascota. Esperá la respuesta antes de mandar otra.";
    case "return_no_source_org":
      // ESTRUCTURAL Y NO TRANSITORIO: reintentar no lo cambia. La copia nombra
      // la salida real, que es hablar con la organización por fuera.
      return "No encontramos una organización a la que devolver esta mascota. Si la recibiste de un refugio fuera de miMAR, contactalo directamente.";
    case "return_failed":
      return "No pudimos completar la devolución. Volvé a abrir la pantalla antes de intentar de nuevo.";
    case "reminder_failed":
      return "No pudimos guardar el recordatorio. Volvé a intentar en unos segundos.";
    // Acompañamiento de adopción. Cinco instrucciones distintas y una sola
    // manda a reintentar: la primera nombra de quién es la decisión, la
    // segunda dice que el animal no está en situación, dos mandan a MIRAR de
    // nuevo (el estado se mueve solo: del otro lado hay una organización), y
    // una manda a elegir otra organización de la lista.
    case "rehome_forbidden":
      // La web dice exactamente esto (`NOT_TITULAR_ERROR`): pedir, cancelar y
      // dar de baja son del titular, y un co-titular o un cuidador que llegó
      // acá tiene al animal y NO tiene esta decisión.
      return "Solo el titular de la mascota puede pedir, cancelar o dar de baja un acompañamiento de adopción.";
    case "rehome_not_allowed":
      // Perdida o fallecida. La ficha ya dice cuál; esta es la frase de
      // respaldo para quien llegó sin leerla.
      return "La situación de esta mascota no permite buscarle hogar ahora. Abrí su ficha para ver por qué.";
    case "rehome_already_open":
      // TAMBIÉN es la respuesta de un pedido reintentado que sí había llegado,
      // así que la copia no puede decir "otra persona pidió": dice que ya hay
      // uno y manda a mirar.
      return "Ya hay un pedido de acompañamiento en curso para esta mascota. Actualizá la pantalla para ver cómo quedó.";
    case "rehome_org_invalid":
      return "Esa organización no puede acompañar la adopción de tu mascota. Elegí otra de la lista.";
    case "rehome_nothing_to_withdraw":
      // Puede ser que se haya resuelto — por la organización, o por un intento
      // anterior con otra clave. Por eso no dice "no había nada": dice que mires.
      return "Ya no hay un pedido ni un acompañamiento para dar de baja. Actualizá la pantalla para ver cómo quedó.";
    case "rehome_failed":
      return "No pudimos completar la acción. Volvé a intentar en unos segundos.";
    // T4-M5, tránsito. Aceptar o rechazar una propuesta de foster. La persona
    // que la recibe todavía no tiene el animal — es una invitación — así que
    // ninguna de estas frases habla de "tu mascota" hasta que la acepta.
    case "foster_forbidden":
      // El token no se adivina; llegar acá es una propuesta de otra persona.
      return "Esta propuesta no es tuya. Actualizá la pantalla para ver tus propuestas.";
    case "foster_not_eligible":
      // Tres reglas, una frase: no inscripto, inscripción pausada, o sin
      // slots — el arreglo es el mismo en las tres, en "Ofrecerme como
      // tránsito".
      return "Tu inscripción como voluntario/a no permite aceptar esta propuesta ahora. Revisala en «Ofrecerme como tránsito».";
    case "foster_already_resolved":
      // AMBIGUO tras un timeout, igual que `transfer_already_resolved`: el
      // primer intento puede haber llegado. "Actualizá" es la instrucción
      // honesta.
      return "Esta propuesta ya no está disponible. Actualizá la pantalla para ver cómo quedó.";
    case "foster_failed":
      // SIN consejo de reintentar, misma razón que `caretaker_failed`: sin
      // clave de idempotencia, un reintento ciego no se distingue de un
      // segundo intento.
      return "No pudimos completar la acción. Actualizá la pantalla para ver cómo quedó.";
  }
}
