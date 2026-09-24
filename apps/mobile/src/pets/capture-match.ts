// Captura rápida, del lado nativo: qué hace la app con lo que alguien escribió.
//
// PURO Y SIN PANTALLA, como todo view-model de este repo. La caja de texto vive
// en `QuickCaptureBox.tsx` y no decide nada; acá está la única regla sobre qué
// puede abrir una frase y qué no, y por eso se puede probar sin renderizar.
//
// EL MATCHER ES EL COMPARTIDO Y NO HAY OTRO. `@dim/contract/events` es el mismo
// módulo que usan la caja de la web, la consola de atender y la respuesta rápida
// de una notificación. Lo que se agrega acá es el ESTRECHAMIENTO: el matcher
// habla el vocabulario de la web (dieciséis `EventType`, más rutas web), y esta
// pantalla escribe dieciocho `WritableKind` de los cuales el menú ofrece once
// fijos más los condicionales. Las dos listas no coinciden, y una frase que cae
// afuera tiene que leerse como "no lo reconocimos acá", nunca abrir el
// formulario de al lado.
//
// LA REGLA, EN UNA LÍNEA: la caja sólo puede llegar a un kind que el menú
// ESTARÍA OFRECIENDO EN ESTE MOMENTO.
//
// Eso es deliberadamente un puntero a `RECORD_KINDS` y a `conditionalKinds()`, y
// no una segunda lista de nombres. Una fence que enumera las formas en vez de
// apuntar a la cosa es la que se olvida de una: el día que se agregue un kind al
// menú, la caja lo hereda sin tocar este archivo, y el día que un kind se saque
// del menú la caja deja de poder abrirlo sin que nadie se acuerde de venir acá.
//
// De esa regla salen solas tres consecuencias que si no serían tres decisiones
// sueltas:
//
//   · `death`, `microchip_replace` y `dangerous_breed_attestation` NO están en
//     el menú porque cada uno tiene una puerta mejor en otro lado (la ficha del
//     animal, el asiento del microchip, la tarjeta de cumplimiento). La caja no
//     puede ser la puerta de atrás de una regla que el menú aplica adelante.
//   · `medication_end` tampoco, y es el más claro: ese formulario necesita el
//     id del asiento que cierra, y una frase no lo trae. Abrirlo desde acá sería
//     un formulario que sólo puede terminar en un rechazo del contrato.
//   · Los condicionales (embarazo, check-in) se ofrecen sólo cuando los HECHOS
//     del animal lo permiten. `conditionalKinds` ya resuelve eso con la lectura
//     que el menú hace igual, así que la caja pregunta lo mismo a la misma
//     función en vez de adivinar.
//
// TODA COINCIDENCIA CON `routeOverride` SE RECHAZA, sin excepciones.
//
// Un `routeOverride` es una ruta de la web (`/eventos/nuevo/embarazo?phase=…`,
// `?sheet=marcar-perdida`) y esta app no tiene ninguna de esas pantallas. Es la
// misma regla que `atender-quick-capture-match.ts` aplica del lado web, por la
// misma razón, y falla para el lado seguro: un override que cambie de forma
// deja de matchear y cae en "no lo reconocimos", nunca en el formulario
// equivocado.
//
// LO QUE ESA REGLA CUESTA, dicho en voz alta: "le hicieron un tatuaje" y las dos
// mitades de embarazo ("está preñada", "parió tres") no las agarra la caja,
// aunque las tres SON kinds que el menú ofrece. Se paga porque las tres son
// actos raros (una vez en la vida del animal, o una vez cada gestación) y
// porque la fila está ahí abajo, a un toque. El arreglo honesto el día que
// importe no es parsear la URL acá: es que el matcher devuelva un
// discriminador propio, y que las dos superficies lo lean.
//
// NADA DE ESTO ESCRIBE UN ASIENTO. Devuelve un kind y un borrador de arranque.
// Lo único que asienta sigue siendo el botón del formulario, apretado por una
// persona que lo está mirando.

import {
  type ConfidenceLabel,
  type EventType,
  type MatchResult,
  extractDateFromText,
  matchCaptureIntent,
} from "@dim/contract/events";

import { isoToDateInput } from "../ui/date-input";
import {
  type EventDraft,
  type PetFactsForMenu,
  RECORD_KINDS,
  type WritableKind,
  conditionalKinds,
  kindTitle,
  todayInAr,
} from "./record-event-view-model";

/** Lo que la frase dijo, ya en es-AR, para mostrarlo ANTES de abrir el formulario. */
export type CaptureUnderstood = {
  label: string;
  value: string;
};

/**
 * El resultado de leer una frase.
 *
 * TRES ARMAS Y NINGUNA ES "ABRÍ ALGO IGUAL". `matched` trae un kind y lo que se
 * entendió, para que la pantalla lo muestre y pregunte. `elsewhere` es una frase
 * que SÍ se reconoció y cuyo formulario vive en otro lado: decir "no lo
 * reconocimos" ahí sería mentir, y dejar a la persona buscando en una lista que
 * no lo tiene. `unmatched` es el único caso donde no hay nada que ofrecer, y la
 * pantalla tiene su propia salida para eso (guardarlo como nota).
 */
export type CaptureOutcome =
  | {
      status: "matched";
      kind: WritableKind;
      /** Los campos del borrador que la frase llenó. El resto queda como estaba. */
      prefill: Partial<EventDraft>;
      /** La etiqueta del matcher, tal cual. Ver `captureConfidenceNote`. */
      confidence: ConfidenceLabel;
      understood: readonly CaptureUnderstood[];
    }
  | {
      status: "elsewhere";
      /** Para nombrarlo: "Eso es un/a {kindTitle(kind)}". */
      kind: WritableKind;
      /** Dónde se hace, en una frase. */
      where: string;
    }
  | { status: "unmatched" };

/**
 * `EventType` del matcher → el kind de esta pantalla.
 *
 * LOS QUE FALTAN FALTAN A PROPÓSITO. `status_changed` cubre perdida, encontrada
 * y cinco hojas de gestión del perfil: ninguna es un asiento y ninguna se
 * escribe desde acá. `credential_scanned` y los demás del catálogo no los emite
 * el matcher. `tattoo_recorded` y `microchip_replaced` sí los emite, pero
 * siempre con `routeOverride`, así que mueren antes de llegar a esta tabla: no
 * se listan para que nadie lea una fila que no puede ejecutarse.
 */
const EVENT_TYPE_TO_KIND: Partial<Record<EventType, WritableKind>> = {
  vaccination_administered: "vaccination",
  weight_recorded: "weight",
  deworming_administered: "deworming",
  symptom_observed: "symptom",
  incident_reported: "bite",
  medication_started: "medication_start",
  medication_stopped: "medication_end",
  vet_visit_logged: "vet_visit",
  clinical_info_logged: "clinical_info",
  sterilization_performed: "sterilization",
  microchip_implanted: "microchip",
  death_recorded: "death",
  note_added: "note",
  post_adoption_checkin: "post_adoption_checkin",
};

/**
 * Los kinds que se reconocen pero se hacen en otra puerta, con la puerta dicha.
 *
 * LAS FRASES SON LAS QUE YA EXISTEN EN ESA PUERTA. La de medicación es, palabra
 * por palabra, la del `ListRow` inerte del menú; las otras dos nombran el
 * control tal como está escrito en su pantalla ("Reemplazar el microchip" en el
 * asiento del chip, "Reportar fallecimiento" en la ficha). Una persona que lee
 * esto y después va a buscarlo tiene que encontrar la misma palabra.
 */
const ELSEWHERE: Partial<Record<WritableKind, string>> = {
  medication_end:
    'Se hace desde el asiento del inicio del tratamiento, en la libreta: "Terminar medicación".',
  microchip_replace:
    'Se hace desde el asiento del microchip que tiene puesto: "Reemplazar el microchip".',
  death: 'Se hace desde la ficha de tu mascota: "Reportar fallecimiento".',
};

/**
 * Cómo se llama, en es-AR, cada campo que la frase puede llenar.
 *
 * Son las mismas etiquetas que el formulario dibuja arriba de cada campo, para
 * que la tarjeta de confirmación y el formulario que se abre después digan lo
 * mismo. La fecha es la excepción y tiene dos nombres, porque en síntoma
 * significa otra cosa: ver `prefillFor`.
 */
const FIELD_LABEL: Partial<Record<keyof EventDraft, string>> = {
  vaccineName: "Vacuna",
  kg: "Peso (kg)",
  chipNumber: "Número de microchip",
  text: "Nota",
  freeText: "Qué le viste",
  occurredAt: "Fecha",
  onsetAt: "Desde cuándo",
};

/** El orden en que se leen en la tarjeta: primero lo que la frase dice, después cuándo. */
const FIELD_ORDER: readonly (keyof EventDraft)[] = [
  "vaccineName",
  "kg",
  "chipNumber",
  "text",
  "freeText",
  "occurredAt",
  "onsetAt",
];

/**
 * Los slots del matcher, traducidos al borrador de ESTE formulario.
 *
 * DOS CONVERSIONES QUE NO SON COSMÉTICAS:
 *
 *   · LA FECHA. El matcher habla `AAAA-MM-DD` (es lo que un `input type=date` de
 *     la web quiere) y este borrador guarda lo que el campo enmascarado MUESTRA,
 *     `DD/MM/AAAA`. Pasar la fecha cruda dibuja `20/26/0917` en el campo, que es
 *     exactamente lo que `emptyDraft` ya advierte en su docblock. `isoToDateInput`
 *     es la única conversión entre las dos.
 *   · EL PESO. El matcher normaliza la coma a punto porque la web manda el valor
 *     a un `input type=number`. Acá el campo es texto libre con teclado decimal y
 *     el placeholder dice "12,5", así que vuelve a la coma. `numberOrNull` del
 *     view-model acepta las dos, o sea que esto es cómo se LEE y no qué se manda.
 *
 * Y DOS COSAS QUE EL MATCHER NO DA Y ESTA PANTALLA SÍ PUEDE:
 *
 *   · `freeText` DE SÍNTOMA ES LA FRASE ENTERA. El matcher no tiene extractor
 *     para ese campo (el catálogo de síntomas necesitaría un LLM), así que un
 *     "está descompuesto hace dos días" abriría el formulario VACÍO y la persona
 *     tendría que volver a escribir lo que acaba de escribir: el peor resultado
 *     posible para una función que existe para ir rápido. Y no es un invento
 *     nuestro sobre lo que quiso decir: ese campo es texto libre, es lo que el
 *     matcher del SERVIDOR lee, y lo que se copia son sus propias palabras.
 *   · LA FECHA DE UN SÍNTOMA VA A `onsetAt`, NO A `occurredAt`. El formulario de
 *     síntoma no tiene fecha del hecho; tiene "desde cuándo", vacío a propósito
 *     porque prellenarlo con hoy convertiría un "no sé" en una afirmación. Acá
 *     no se prellena con hoy: se prellena con lo que la persona ESCRIBIÓ ("desde
 *     ayer"), que es precisamente el caso en que ese campo tiene que hablar.
 *
 * NINGUNA OTRA FRASE CRUDA ENTRA EN NINGÚN CAMPO. Volcar "le di la antirrábica
 * hoy" en las Notas de una vacuna sería guardar en un registro nacional una
 * oración que los campos estructurados ya dicen, y con peor ortografía.
 */
function prefillFor(
  kind: WritableKind,
  match: MatchResult,
  rawText: string,
  now: Date,
): Partial<EventDraft> {
  const prefill: Partial<EventDraft> = {};
  const { vaccineName, kg, chipNumber, text } = match.slots;

  if (vaccineName !== undefined) prefill.vaccineName = vaccineName;
  if (kg !== undefined) prefill.kg = kg.replace(".", ",");
  if (chipNumber !== undefined) prefill.chipNumber = chipNumber;
  if (text !== undefined) prefill.text = text;

  // LA FECHA SE VUELVE A PEDIR CON EL RELOJ ARGENTINO, y ese renglón es la
  // corrección de un desacuerdo real entre las dos capas.
  //
  // `matchCaptureIntent` ya resolvió "hoy" y "ayer" adentro, pero contra el
  // calendario LOCAL DEL APARATO, que es lo correcto en la web (donde el
  // navegador y el servidor comparten la zona del usuario). Este formulario no:
  // `emptyDraft` usa `todayInAr`, a propósito, porque un teléfono que viaja con
  // su dueño ofrecería "ayer" como el hoy de alguien arriba de un avión. Las dos
  // reglas conviviendo significan que en un aparato fuera de Argentina la caja
  // diría un día y el campo por defecto otro, para la misma palabra.
  //
  // No es un fork del parser: es la MISMA función, llamada con el reloj que esta
  // app ya declaró como el suyo. Lo que se descarta es el `occurredAt` que venía
  // en los slots, calculado con el otro reloj.
  const occurredAt = extractDateFromText(rawText, argentineNow(now));
  if (occurredAt !== null) {
    if (kind === "symptom") prefill.onsetAt = isoToDateInput(occurredAt);
    else prefill.occurredAt = isoToDateInput(occurredAt);
  }
  if (kind === "symptom") prefill.freeText = rawText;

  return prefill;
}

/**
 * Ahora, pero con los campos locales puestos en el día argentino.
 *
 * `extractDateFromText` lee `getFullYear/getMonth/getDate` del `Date` que le
 * pasan, o sea el calendario local. Darle uno construido desde `todayInAr` es la
 * forma de que "ayer" signifique el ayer de Argentina sin tocar el parser ni
 * escribir una segunda aritmética de fechas.
 */
function argentineNow(now: Date): Date {
  const parts = todayInAr(now).split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return new Date(year, month - 1, day);
}

/**
 * Lo entendido, en el orden en que se lee.
 *
 * SALE DEL PREFILL Y NO DE LOS SLOTS, y esa dirección importa: lo que la tarjeta
 * muestra tiene que ser exactamente lo que va a aparecer en el formulario. Si un
 * slot se descarta o se transforma, la tarjeta se entera sola. Un campo que el
 * formulario llena por su cuenta (la fecha de hoy) NO está acá, porque la
 * pregunta que la tarjeta hace es "¿esto es lo que dijiste?" y nadie dijo hoy.
 */
function understoodFrom(prefill: Partial<EventDraft>): readonly CaptureUnderstood[] {
  const rows: CaptureUnderstood[] = [];
  for (const field of FIELD_ORDER) {
    const value = prefill[field];
    const label = FIELD_LABEL[field];
    if (typeof value !== "string" || value.length === 0 || label === undefined) continue;
    rows.push({ label, value });
  }
  return rows;
}

/**
 * Leer una frase con los hechos del animal a la vista.
 *
 * `facts` ES EL MISMO OBJETO QUE DIBUJA EL MENÚ, y llega `null` mientras la
 * lectura no contestó. Null significa "todavía no sé", no "no": se ofrecen sólo
 * los kinds fijos, que es lo mismo que el menú está dibujando en ese instante.
 * Una caja que ofreciera un condicional antes que el menú lo dibuje sería la
 * caja adelantándose a una regla sobre el animal.
 */
export function readCapture(
  rawText: string,
  facts: PetFactsForMenu | null,
  now: Date = new Date(),
): CaptureOutcome {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return { status: "unmatched" };

  const match = matchCaptureIntent(trimmed);
  // Ver la cabecera: un override es una ruta de la web y esta app no la tiene.
  if (match === null || match.routeOverride !== undefined) return { status: "unmatched" };

  const kind = EVENT_TYPE_TO_KIND[match.eventType];
  if (kind === undefined) return { status: "unmatched" };

  const offered: readonly WritableKind[] = [
    ...RECORD_KINDS,
    ...(facts === null ? [] : conditionalKinds(facts)),
  ];
  if (!offered.includes(kind)) {
    const where = ELSEWHERE[kind];
    // Un condicional que este animal no puede tener cae acá SIN frase, y sale
    // como "no lo reconocimos" a propósito: el menú tampoco explica por qué no
    // dibuja esa fila, y la caja no puede ser el lugar donde la app empieza a
    // contar hechos del animal que nadie preguntó.
    return where === undefined ? { status: "unmatched" } : { status: "elsewhere", kind, where };
  }

  const prefill = prefillFor(kind, match, trimmed, now);
  return {
    status: "matched",
    kind,
    prefill,
    confidence: match.confidence,
    understood: understoodFrom(prefill),
  };
}

/**
 * Lo que la tarjeta dice arriba de todo, según la confianza.
 *
 * LA CONFIANZA CAMBIA LA FRASE Y NUNCA LA ACCIÓN. No hay umbral por debajo del
 * cual la caja se guarde la respuesta, y hay una razón concreta: esas etiquetas
 * están escritas a mano, patrón por patrón, no medidas. `low` la lleva un solo
 * patrón de los treinta (el cajón clínico: "análisis", "ecografía",
 * "radiografía"), y para esas tres palabras abrir Información clínica es
 * correcto. Un umbral sobre una etiqueta escrita a mano sería una regla que
 * PARECE numérica sobre algo que no lo es, y lo primero que taparía es el único
 * caso donde acierta.
 *
 * Para lo que la etiqueta sí sirve es para elegir con cuánta seguridad se
 * pregunta, y eso es lo que se hace acá.
 */
export function captureConfidenceNote(confidence: ConfidenceLabel): string {
  switch (confidence) {
    case "high":
      return "Entendimos esto:";
    case "medium":
      return "Nos parece que es esto. Revisalo antes de seguir:";
    case "low":
      return "No estamos seguros. Revisalo antes de seguir:";
  }
}

/** "Abrir vacuna" y no "Continuar": el botón nombra el formulario que abre. */
export function captureOpenLabel(kind: WritableKind): string {
  return `Abrir ${kindTitle(kind).toLocaleLowerCase("es-AR")}`;
}
