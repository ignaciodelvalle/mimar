// La regla de la captura rápida, sin pantalla.
//
// LO QUE ESTAS PRUEBAS CUIDAN no es el matcher: ése es compartido y tiene su
// propia suite del lado web (`__tests__/event-capture-matcher.test.ts`, que
// sigue corriendo contra el mismo módulo después de la mudanza). Lo que se
// prueba acá es el ESTRECHAMIENTO, que es donde están los modos de fallar que
// importan en un registro que no se edita:
//
//   · Que una frase no pueda abrir un formulario que el menú no ofrece.
//   · Que la fecha llegue como la máscara la dibuja y no como la manda el cable.
//   · Que lo que la tarjeta MUESTRA sea exactamente lo que el formulario va a
//     tener adentro.
//   · Que una frase que no se entiende no se pierda.

import { describe, expect, it } from "@jest/globals";

import { isoToDateInput } from "../ui/date-input";
import {
  type CaptureOutcome,
  captureConfidenceNote,
  captureOpenLabel,
  readCapture,
} from "./capture-match";
import {
  type PetFactsForMenu,
  RECORD_KINDS,
  type WritableKind,
  conditionalKinds,
  todayInAr,
} from "./record-event-view-model";

/**
 * Un instante fijo, para que ninguna afirmación sobre "hoy" o "ayer" dependa de
 * cuándo corre la suite.
 *
 * MEDIODÍA UTC A PROPÓSITO: son las 09:00 en Argentina, así que el día
 * argentino y el día UTC coinciden y la prueba dice lo mismo en una máquina de
 * Buenos Aires y en un CI en UTC. Un instante cerca de medianoche probaría el
 * huso y no la regla.
 */
const NOW = new Date("2026-09-17T12:00:00.000Z");
const TODAY = isoToDateInput(todayInAr(NOW));
const YESTERDAY = "16/09/2026";

/** Nada se sabe del animal todavía: la lectura del pet detail no contestó. */
const UNKNOWN_FACTS = null;

/** Una hembra con un seguimiento post-adopción abierto: los condicionales están. */
const RICH_FACTS: PetFactsForMenu = {
  sex: "female",
  species: "dog",
  pregnancyStatus: "none",
  postAdoptionCheckinPending: true,
};

function read(text: string, facts: PetFactsForMenu | null = UNKNOWN_FACTS): CaptureOutcome {
  return readCapture(text, facts, NOW);
}

/** El resultado como `matched`, o falla nombrando lo que salió en su lugar. */
function matched(outcome: CaptureOutcome) {
  if (outcome.status !== "matched") {
    throw new Error(`se esperaba una coincidencia y salió "${outcome.status}"`);
  }
  return outcome;
}

describe("readCapture — qué formulario abre una frase", () => {
  // LA TABLA ES TAMBIÉN LA DOCUMENTACIÓN. Una fila por cada tipo del menú que
  // la caja puede alcanzar, con una frase que una persona escribiría de verdad.
  const CASES: readonly [string, WritableKind][] = [
    ["le di la antirrábica hoy", "vaccination"],
    ["pesó 12,5 kilos", "weight"],
    ["le di el antiparasitario", "deworming"],
    ["está descompuesto hace dos días", "symptom"],
    ["mordió al vecino", "bite"],
    ["empecé un tratamiento con antibiótico", "medication_start"],
    ["fuimos al veterinario", "vet_visit"],
    ["le hicieron una ecografía", "clinical_info"],
    ["lo castraron ayer", "sterilization"],
    ["le pusieron el microchip", "microchip"],
    ["anotar que come poco", "note"],
  ];

  for (const [phrase, kind] of CASES) {
    it(`lee "${phrase}" como ${kind}`, () => {
      expect(matched(read(phrase)).kind).toBe(kind);
    });
  }

  it("NUNCA abre un tipo que el menú no esté ofreciendo en ese momento", () => {
    // LA INVARIANTE CENTRAL DE ESTE MÓDULO, y la única forma honesta de
    // probarla: la lista contra la que se compara se calcula acá igual que la
    // calcula el menú, apuntando a `RECORD_KINDS` y a `conditionalKinds`. Una
    // prueba que enumerara los once nombres a mano sería la fence que se olvida
    // de uno el día que se agrega el doceavo.
    const offered = [...RECORD_KINDS, ...conditionalKinds(RICH_FACTS)];
    const phrases = [
      ...CASES.map(([phrase]) => phrase),
      "hicimos el check-in",
      "está preñada",
      "parió tres cachorros",
      "le hicieron un tatuaje",
      "se me escapó",
      "apareció en el barrio",
      "quiero compartir la libreta",
      "transferir la mascota",
      "terminé el tratamiento",
      "se murió",
      "reemplazaron el chip",
    ];
    for (const phrase of phrases) {
      const outcome = readCapture(phrase, RICH_FACTS, NOW);
      if (outcome.status !== "matched") continue;
      expect(offered).toContain(outcome.kind);
    }
  });
});

describe("readCapture — lo que queda afuera, y cómo lo dice", () => {
  it("manda 'terminé el tratamiento' a la puerta donde de verdad se hace", () => {
    // NO ES "NO LO RECONOCIMOS": sí se reconoció. Ese formulario necesita el id
    // del asiento que cierra y una frase no lo trae, así que la única respuesta
    // útil es decir dónde está el control que sí lo tiene.
    const outcome = read("terminé el tratamiento");
    expect(outcome.status).toBe("elsewhere");
    if (outcome.status !== "elsewhere") return;
    expect(outcome.kind).toBe("medication_end");
    expect(outcome.where).toContain("Terminar medicación");
  });

  it("manda un fallecimiento a la ficha del animal y no abre el formulario", () => {
    // El asiento terminal se entra desde una puerta deliberada. La caja no
    // puede ser la puerta de atrás del único formulario irreversible.
    const outcome = read("se murió ayer");
    expect(outcome.status).toBe("elsewhere");
    if (outcome.status !== "elsewhere") return;
    expect(outcome.kind).toBe("death");
    expect(outcome.where).toContain("Reportar fallecimiento");
  });

  it("no abre nada con una ruta de la web adentro", () => {
    // Todo `routeOverride` apunta a una pantalla que esta app no tiene. Se
    // rechazan todos, y estas cuatro son las que más duelen: son kinds que el
    // menú SÍ ofrece. Ver la cabecera de `capture-match.ts`.
    for (const phrase of ["le hicieron un tatuaje", "está preñada", "parió tres cachorros"]) {
      expect(readCapture(phrase, RICH_FACTS, NOW).status).toBe("unmatched");
    }
  });

  it("no abre un asiento con lo que no es un asiento", () => {
    // Perdida, encontrada y las hojas de gestión del perfil no se escriben en
    // la libreta y no tienen formulario en esta pantalla.
    for (const phrase of ["se me escapó", "apareció en el barrio", "transferir la mascota"]) {
      expect(read(phrase).status).toBe("unmatched");
    }
  });

  it("no reconoce nada en una frase vacía", () => {
    expect(read("   ").status).toBe("unmatched");
  });

  it("no inventa un tipo para una frase que no dice nada del animal", () => {
    expect(read("qwerty asdf").status).toBe("unmatched");
  });
});

describe("readCapture — los condicionales siguen la misma regla que el menú", () => {
  it("ofrece el check-in cuando el refugio está esperando uno", () => {
    expect(matched(readCapture("hicimos el check-in", RICH_FACTS, NOW)).kind).toBe(
      "post_adoption_checkin",
    );
  });

  it("NO lo ofrece cuando no hay ventana abierta", () => {
    // El menú tampoco dibuja esa fila, y por la misma razón: el formulario sólo
    // podría terminar en un rechazo. Sale como "no lo reconocimos" y no como una
    // explicación, a propósito: la caja no es el lugar donde la app empieza a
    // contar hechos del animal que nadie preguntó.
    const closed: PetFactsForMenu = { ...RICH_FACTS, postAdoptionCheckinPending: false };
    expect(readCapture("hicimos el check-in", closed, NOW).status).toBe("unmatched");
  });

  it("NO lo ofrece mientras la lectura del animal no contestó", () => {
    // `null` es "todavía no sé". El menú está dibujando en ese instante sólo las
    // filas fijas, y la caja no puede adelantarse a una regla sobre el animal.
    expect(read("hicimos el check-in", UNKNOWN_FACTS).status).toBe("unmatched");
  });
});

describe("readCapture — los campos que llena", () => {
  it("pone el nombre de la vacuna y la fecha de hoy", () => {
    const outcome = matched(read("le di la antirrábica hoy"));
    expect(outcome.prefill.vaccineName).toBe("antirrábica");
    expect(outcome.prefill.occurredAt).toBe(TODAY);
  });

  it("escribe la fecha como el campo la dibuja, NUNCA como la manda el cable", () => {
    // EL ERROR QUE ESTA PRUEBA EXISTE PARA IMPEDIR. El matcher habla
    // `AAAA-MM-DD`; este borrador guarda lo que la máscara muestra. Pasar la
    // fecha cruda dibuja `20/26/0917` en el campo, que es un día que no existe,
    // en un formulario que asienta en una libreta inmutable.
    const outcome = matched(read("lo castraron ayer"));
    expect(outcome.prefill.occurredAt).toBe(YESTERDAY);
    expect(outcome.prefill.occurredAt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("devuelve el peso con coma, que es como el campo lo pide", () => {
    // El matcher normaliza a punto porque la web lo manda a un input numérico.
    // Acá el campo es texto libre y su placeholder dice "12,5".
    expect(matched(read("pesa 12.5 kg")).prefill.kg).toBe("12,5");
  });

  it("copia la frase entera en el campo del síntoma", () => {
    // Sin esto, "está descompuesto desde ayer" abre el formulario VACÍO y la
    // persona vuelve a escribir lo que acaba de escribir: el peor final posible
    // para algo que existe para ir rápido.
    const outcome = matched(read("está descompuesto desde ayer"));
    expect(outcome.prefill.freeText).toBe("está descompuesto desde ayer");
  });

  it("manda la fecha de un síntoma a 'desde cuándo' y no a la fecha del hecho", () => {
    // El formulario de síntoma no tiene fecha del hecho. Tiene "desde cuándo",
    // vacío a propósito porque prellenarlo con hoy convertiría un "no sé" en una
    // afirmación; acá lo llena lo que la persona ESCRIBIÓ.
    const outcome = matched(read("vómitos desde ayer"));
    expect(outcome.prefill.onsetAt).toBe(YESTERDAY);
    expect(outcome.prefill.occurredAt).toBeUndefined();
  });

  it("no pone ninguna fecha cuando la frase no dijo ninguna", () => {
    // El formulario ya arranca con hoy. Un `occurredAt` acá haría que la
    // tarjeta afirme una fecha que nadie dijo.
    expect(matched(read("le pusieron el microchip")).prefill.occurredAt).toBeUndefined();
  });

  it("no vuelca la frase cruda en las notas de los demás formularios", () => {
    // Guardar "le di la antirrábica hoy" en las Notas de una vacuna sería meter
    // en un registro nacional una oración que los campos ya dicen.
    const outcome = matched(read("le di la antirrábica hoy"));
    expect(outcome.prefill.notes).toBeUndefined();
    expect(outcome.prefill.freeText).toBeUndefined();
  });
});

describe("readCapture — lo que se muestra es lo que se va a abrir", () => {
  it("muestra una fila por campo lleno, y ninguna de más", () => {
    // `understood` sale del prefill y no de los slots, para que la tarjeta no
    // pueda prometer un dato que el formulario no va a tener.
    const outcome = matched(read("le di la antirrábica hoy"));
    const shown = Object.fromEntries(outcome.understood.map((f) => [f.label, f.value]));
    expect(shown).toEqual({ Vacuna: "antirrábica", Fecha: TODAY });
  });

  it("no muestra nada cuando entendió el tipo y ningún dato", () => {
    // Lo normal en los formularios cuyos campos necesitarían un LLM. La caja
    // dice que se abre vacío en vez de dibujar una tarjeta sin filas.
    expect(matched(read("mordió al vecino")).understood).toEqual([]);
  });

  it("nombra el campo del síntoma con la etiqueta que el formulario usa", () => {
    const labels = matched(read("vómitos desde ayer")).understood.map((f) => f.label);
    expect(labels).toEqual(["Qué le viste", "Desde cuándo"]);
  });
});

describe("la confianza cambia la frase, nunca la acción", () => {
  it("afirma cuando está segura y pide revisión cuando no", () => {
    expect(captureConfidenceNote("high")).toBe("Entendimos esto:");
    expect(captureConfidenceNote("medium")).toContain("Revisalo");
    expect(captureConfidenceNote("low")).toContain("No estamos seguros");
  });

  it("abre igual con la confianza más baja del matcher", () => {
    // `low` la lleva un solo patrón de todos: el cajón clínico. Para
    // "ecografía", abrir Información clínica es correcto, así que un umbral que
    // se guardara las lecturas de baja confianza taparía justo el caso donde
    // acierta. Lo que cambia es la frase de arriba.
    const outcome = matched(read("le hicieron una ecografía"));
    expect(outcome.confidence).toBe("low");
    expect(outcome.kind).toBe("clinical_info");
  });
});

describe("captureOpenLabel", () => {
  it("nombra el formulario que abre, no un 'Continuar'", () => {
    expect(captureOpenLabel("vaccination")).toBe("Abrir vacuna");
    expect(captureOpenLabel("clinical_info")).toBe("Abrir información clínica");
  });
});
