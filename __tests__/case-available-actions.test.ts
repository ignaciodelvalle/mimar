/**
 * Tests para src/modules/cases/domain/available-actions.ts (#41).
 *
 * Lo que se prueba NO es "los botones aparecen": es que la lista de acciones
 * sale del ciclo de vida y no de una lista escrita a mano. Por eso los casos
 * recorren los DOCE kinds reales leyendo sus declaraciones, en vez de afirmar
 * contra un puñado elegido.
 */

import { describe, expect, it } from "vitest";

import {
  availableCaseActions,
  canPerformCaseAction,
  describeTerminalEvents,
} from "@/src/modules/cases/domain/available-actions";
import { CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";
import { getLifecycle } from "@/src/modules/cases/domain/lifecycles";

describe("availableCaseActions — la nota", () => {
  it("está disponible en TODOS los kinds abiertos", () => {
    // La nota no es una transición: no toca el estado ni pretende ser un evento
    // terminal. Por eso es legítima para los doce, y es la única acción que
    // sirve al 100% de la cola real.
    for (const kind of CASE_KINDS) {
      expect(canPerformCaseAction(kind, "open", "note"), `${kind} no admite nota`).toBe(true);
    }
  });

  it("desaparece en un expediente cerrado, y dice por qué", () => {
    const [note] = availableCaseActions("custody_episode", "closed");
    expect(note.available).toBe(false);
    expect(note.unavailableReason).toMatch(/cerrado/i);
  });

  it("distingue cerrado de fusionado en el motivo", () => {
    const [cerrado] = availableCaseActions("custody_episode", "closed");
    const [fusionado] = availableCaseActions("custody_episode", "merged");
    expect(fusionado.unavailableReason).not.toBe(cerrado.unavailableReason);
    expect(fusionado.unavailableReason).toMatch(/fusion/i);
  });
});

describe("availableCaseActions — el cierre manual se DERIVA del ciclo de vida", () => {
  // Éste es el test que importa. Si alguien habilita un cierre manual en la UI
  // sin declararlo en el ciclo, o al revés, esto se pone rojo.
  it("coincide exactamente con manualCloseAllowed, kind por kind", () => {
    for (const kind of CASE_KINDS) {
      const lifecycle = getLifecycle(kind);
      const declarado = lifecycle?.manualCloseAllowed ?? false;
      expect(canPerformCaseAction(kind, "open", "close"), `${kind}`).toBe(declarado);
    }
  });

  it("hoy lo admiten exactamente dos kinds, y hay que nombrarlos", () => {
    // Fijaba el estado del 2026-08-10 con un solo kind y decía: "si mañana son
    // dos, este test obliga a pasar por acá y decir cuál — que es la fricción
    // que corresponde para una acción que cierra un expediente legal".
    //
    // Mañana fue el 2026-09-17 y la fricción funcionó. El segundo es
    // `microchip_remediation`, por decisión del PO, y el motivo de que vaya al
    // cierre genérico está escrito en su ciclo de vida: hasta ese día no tenía
    // NINGUNA vía de cierre (L-22), y es un acto administrativo — corregir el
    // registro de un identificador — no uno sanitario, así que el argumento que
    // mantiene apagado el flag en brotes no lo alcanza.
    //
    // La lista se queda ORDENADA como la declara CASE_KINDS, no alfabética: es
    // la lista real, no una reescritura para que el test quede lindo.
    const conCierreManual = CASE_KINDS.filter((k) => canPerformCaseAction(k, "open", "close"));
    expect(conCierreManual).toEqual(["custody_episode", "microchip_remediation"]);
  });

  it("cuando no se puede cerrar a mano, el motivo NOMBRA el hecho en castellano", () => {
    // Un motivo que sólo dice "no se puede" manda al operador a buscar el botón
    // tres veces. Nombrar el hecho terminal cierra la pregunta.
    const [, close] = availableCaseActions("lost_pet_episode", "open");
    expect(close.available).toBe(false);
    expect(close.unavailableReason).toMatch(/no se cierra a mano/i);
    // `status_changed` y `custody_transferred`, dichos como los vive el operador.
    expect(close.unavailableReason).toMatch(/cambia el estado del animal/i);
    expect(close.unavailableReason).toMatch(/cambia de responsable/i);
  });

  it("NINGÚN motivo filtra un identificador de evento crudo", () => {
    // La versión original de este módulo interpolaba `terminalEvents` directo, y
    // en staging se leía textual: "se cierra solo cuando ocurre el hecho que lo
    // termina (custody_dispute_resolved)". Un identificador en inglés, en la
    // copia de un expediente legal, contra el invariante #4 — y justo en la
    // frase que existe para que la ausencia del botón se ENTIENDA.
    //
    // El test viejo hacía `expect(reason).toContain(eventType)`: no sólo dejaba
    // pasar el defecto, lo EXIGÍA. Éste afirma lo contrario, sobre los doce
    // kinds y los dos estados.
    const idsCrudos = new Set<string>();
    for (const kind of CASE_KINDS) {
      for (const e of getLifecycle(kind)?.terminalEvents ?? []) idsCrudos.add(e);
    }
    expect(idsCrudos.size, "hay eventos terminales que revisar").toBeGreaterThan(5);

    for (const kind of CASE_KINDS) {
      for (const status of ["open", "closed"] as const) {
        for (const a of availableCaseActions(kind, status)) {
          const reason = a.unavailableReason ?? "";
          for (const id of idsCrudos) {
            expect(reason, `${kind}/${status} filtra "${id}"`).not.toContain(id);
          }
          // Ningún snake_case en general, no sólo los que hoy conocemos.
          expect(reason, `${kind}/${status} tiene forma de identificador`).not.toMatch(
            /[a-z]+_[a-z]+/,
          );
        }
      }
    }
  });

  it("un evento terminal sin prosa degrada a la frase genérica, no al identificador", () => {
    // La garantía que hace que lo de arriba siga siendo cierto mañana: agregar
    // un evento nuevo a un ciclo de vida empeora la explicación, nunca la
    // convierte en jerga.
    expect(describeTerminalEvents(["custody_transferred"])).toBe("el animal cambia de responsable");
    expect(describeTerminalEvents([])).toBeNull();
    expect(
      describeTerminalEvents(["custody_transferred", "evento_inventado" as never]),
      "un evento sin traducir invalida la enumeración entera",
    ).toBeNull();
  });

  it("un expediente ya cerrado no ofrece cerrarse otra vez", () => {
    const [, close] = availableCaseActions("custody_episode", "closed");
    expect(close.available).toBe(false);
    expect(close.unavailableReason).toMatch(/ya está cerrado/i);
  });
});

describe("availableCaseActions — un expediente que se cierra por ACCIÓN lo dice, no manda a escalar", () => {
  // rehome-by-titular (WU5 carry-forward 2). `rehome_request` no tiene evento
  // terminal ni cierre manual: lo cierran dos ACCIONES — la respuesta de la
  // organización y la cancelación del titular. Con `terminalEvents: []` el
  // detalle le decía a la org "todavía no tiene una vía de cierre definida…
  // pedí que se defina la política", que es falso: la política existe y la
  // org es quien la ejecuta.
  it("rehome_request: el motivo nombra a la organización y al titular, nunca 'sin vía de cierre'", () => {
    const [, close] = availableCaseActions("rehome_request", "open");
    expect(close.available).toBe(false);
    expect(close.unavailableReason).not.toMatch(/todavía no tiene una vía de cierre/i);
    expect(close.unavailableReason).toMatch(/no se cierra a mano/i);
    expect(close.unavailableReason).toMatch(/organización/i);
    expect(close.unavailableReason).toMatch(/titular/i);
  });

  it("el ciclo de vida lo declara en un campo legible por máquina, no en un comentario", () => {
    // Derivado, no restatado: si mañana la prosa vive sólo en el header del
    // archivo, este test vuelve a ponerse rojo.
    expect(getLifecycle("rehome_request")?.actionCloseProse).toMatch(/organización/);
    expect(getLifecycle("rehome_request")?.actionCloseProse).toMatch(/titular/);
  });

  it("outbreak_investigation: el motivo manda a la pantalla que SÍ cierra", () => {
    // 2026-09-17. Este kind estaba en la lista de "nadie escribió la política"
    // por sumar dos flags — `terminalEvents: []` y `manualCloseAllowed: false`
    // — y concluir que no había cierre. El cierre existe, y es MÁS estricto
    // que el genérico: `closeInvestigation` exige un outcome, un motivo de diez
    // caracteres y, cuando se resuelve, un informe epidemiológico final.
    //
    // La frase genérica le pedía a una autoridad sanitaria que reclamara una
    // política ya escrita, sobre un expediente legalmente sensible.
    const [, close] = availableCaseActions("outbreak_investigation", "open");
    expect(close.available).toBe(false);
    expect(close.unavailableReason).not.toMatch(/todavía no tiene una vía de cierre/i);
    expect(close.unavailableReason).toMatch(/investigación/i);
    expect(close.unavailableReason).toMatch(/informe/i);
  });

  it("y lo declara en el ciclo de vida, no en un comentario", () => {
    // Mismo criterio que rehome_request: derivado, no restatado.
    expect(getLifecycle("outbreak_investigation")?.dedicatedCloseProse).toMatch(/investigación/);
    // Y el flag genérico sigue apagado a propósito — prenderlo abriría una
    // segunda puerta, más débil, al mismo acto.
    expect(getLifecycle("outbreak_investigation")?.manualCloseAllowed).toBe(false);
  });

  it("microchip_remediation se cierra a mano, desde el detalle genérico", () => {
    // Decisión del PO, 2026-09-17. Hasta ese día este kind no tenía NINGUNA vía
    // de cierre (L-22): ni un hecho que lo terminara ni un operador que pudiera
    // darlo por terminado.
    //
    // Va al genérico y no a una pantalla propia con intención: el argumento que
    // mantiene el cierre manual apagado en brotes es no darle una segunda
    // puerta, más débil, a un acto legalmente sensible. Una remediación de
    // microchip es administrativa, no sanitaria, y ese argumento no la alcanza.
    const lifecycle = getLifecycle("microchip_remediation");
    expect(lifecycle?.terminalEvents).toHaveLength(0);
    expect(lifecycle?.dedicatedCloseProse).toBeUndefined();
    expect(lifecycle?.manualCloseAllowed).toBe(true);

    const [, close] = availableCaseActions("microchip_remediation", "open");
    expect(close.available).toBe(true);
    expect(close.unavailableReason).toBeNull();
  });

  it("welfare_denuncia manda a SU pantalla, no a pedir una política que ya existe", () => {
    // El mismo defecto que se arregló para brotes, encontrado el mismo día en el
    // kind de al lado — y el de al lado es el que MÁS tráfico tiene.
    //
    // `terminalEvents: []` + `manualCloseAllowed: false` hacía que el detalle
    // genérico dijera "todavía no tiene una vía de cierre definida… pedí que se
    // defina la política", mientras `closeWelfareReport` está escrito, cableado
    // a `closeWelfareReportAction` y desplegado en `app/gob/maltrato/[id]` con
    // notas de resolución obligatorias.
    //
    // El flag sigue en false A PROPÓSITO: prenderlo abriría un botón genérico
    // que saltearía esas notas.
    const lifecycle = getLifecycle("welfare_denuncia");
    expect(lifecycle?.terminalEvents).toHaveLength(0);
    expect(lifecycle?.manualCloseAllowed).toBe(false);
    expect(lifecycle?.dedicatedCloseProse).toMatch(/[Mm]altrato/);

    const [, close] = availableCaseActions("welfare_denuncia", "open");
    expect(close.available).toBe(false);
    expect(close.unavailableReason).toMatch(/no se cierra desde acá/i);
    // Y sobre todo: ya NO le pide a nadie que reclame una política escrita.
    expect(close.unavailableReason).not.toMatch(/todavía no tiene una vía de cierre/i);
  });

  it("NINGÚN kind le pide al operador que reclame una política de cierre", () => {
    // LA REJA QUE IMPORTA, y la que habría evitado los dos defectos de arriba.
    //
    // La frase genérica "este expediente todavía no tiene una vía de cierre
    // definida" es honesta sólo cuando es cierta, y hoy no es cierta de ninguno
    // de los doce: cada uno se cierra por un hecho terminal, a mano, por acción
    // de las partes, o en su propia pantalla.
    //
    // La rama que emite esa frase SE QUEDA en el código a propósito — es donde
    // caería un kind NUEVO agregado sin política, y decirlo honestamente es
    // mejor que adivinar. Lo que este caso fija es que hoy no la alcanza nadie,
    // así que agregar un kind sin decidir cómo termina pone el gate en rojo en
    // vez de mandar a producción una pantalla que miente.
    const sinPolitica: string[] = [];
    for (const kind of CASE_KINDS) {
      const [, close] = availableCaseActions(kind, "open");
      if (close.unavailableReason?.match(/todavía no tiene una vía de cierre/i)) {
        sinPolitica.push(kind);
      }
    }
    expect(sinPolitica, `kinds sin vía de cierre declarada: ${sinPolitica.join(", ")}`).toEqual([]);
  });

  it("y cada kind declara CÓMO se cierra, no sólo que se cierra", () => {
    // Complemento del caso anterior, del lado de la declaración en vez del de la
    // frase: la ausencia de las cuatro formas es lo que produce la frase
    // deshonesta, así que fijarla acá nombra al culpable antes de que salga a
    // pantalla.
    for (const kind of CASE_KINDS) {
      const lifecycle = getLifecycle(kind);
      const tieneVia =
        (lifecycle?.terminalEvents.length ?? 0) > 0 ||
        lifecycle?.manualCloseAllowed === true ||
        lifecycle?.dedicatedCloseProse !== undefined ||
        lifecycle?.actionCloseProse !== undefined;
      expect(tieneVia, `${kind} no declara ninguna vía de cierre`).toBe(true);
    }
  });
});

describe("no vacuidad", () => {
  it("hay doce kinds y todos tienen ciclo de vida declarado", () => {
    // Sin esto, los barridos de arriba podrían recorrer una lista vacía y pasar
    // sin haber juzgado nada — el modo de falla que tres fences de este repo
    // tuvieron esta misma semana.
    expect(CASE_KINDS.length).toBeGreaterThanOrEqual(12);
    for (const kind of CASE_KINDS) {
      expect(getLifecycle(kind), `${kind} sin ciclo de vida`).not.toBeNull();
    }
  });

  it("siempre devuelve las TRES acciones, disponibles o no", () => {
    // Devolver sólo lo disponible haría imposible explicar la ausencia, que es
    // justamente lo que la pantalla necesita.
    for (const kind of CASE_KINDS) {
      for (const status of ["open", "escalated", "closed", "merged"] as const) {
        const acciones = availableCaseActions(kind, status);
        expect(acciones.map((a) => a.action).sort()).toEqual(["close", "escalate", "note"]);
        for (const a of acciones) {
          if (a.available) expect(a.unavailableReason).toBeNull();
          else expect(a.unavailableReason?.length ?? 0).toBeGreaterThan(10);
        }
      }
    }
  });

  it("el ORDEN es parte del contrato: nota, cierre, escalada", () => {
    // Hay tests que desestructuran por índice y la escalada se agregó al final
    // por eso. Si alguien reordena, esto lo dice antes de que un `const [,
    // close] = …` empiece a leer silenciosamente la acción equivocada.
    for (const kind of CASE_KINDS) {
      expect(availableCaseActions(kind, "open").map((a) => a.action)).toEqual([
        "note",
        "close",
        "escalate",
      ]);
    }
  });
});

describe("availableCaseActions — la escalada", () => {
  // El PO decidió "escalar en los doce tipos" el 2026-09-17, y lo que se entrega
  // es DERIVADO y no literal, porque lo literal es imposible: ocho de los trece
  // kinds no declaran `escalated` entre sus `statusValues`, así que no existe el
  // estado al que subirlos. Un botón que lo ofreciera fallaría en el servidor
  // después de prometerle al operador que iba a andar — que es exactamente la
  // falla que este módulo existe para no cometer.
  const CON_ESCALADA = CASE_KINDS.filter((k) =>
    getLifecycle(k)?.statusValues.includes("escalated"),
  );

  it("coincide exactamente con lo que el ciclo de vida declara", () => {
    for (const kind of CASE_KINDS) {
      const declarado = getLifecycle(kind)?.statusValues.includes("escalated") ?? false;
      expect(canPerformCaseAction(kind, "open", "escalate"), `${kind}`).toBe(declarado);
    }
  });

  it("hoy son cinco, y hay que nombrarlos", () => {
    // Misma fricción que la lista de cierre manual: si mañana son seis, este
    // test obliga a pasar por acá y decir cuál.
    // El orden es el de CASE_KINDS, no alfabético: es la lista real, no una
    // reescritura para que el test quede lindo.
    expect(CON_ESCALADA).toEqual([
      "bite_incident",
      "welfare_denuncia",
      "custody_dispute",
      "outbreak_investigation",
      "microchip_remediation",
    ]);
  });

  it("donde no existe el estado, el motivo NO sugiere que falte una decisión", () => {
    // La diferencia importa: "todavía no" invita a esperar o a reclamar una
    // política. Acá no falta una política — falta el estado, y no va a llegar.
    for (const kind of CASE_KINDS) {
      if (CON_ESCALADA.includes(kind)) continue;
      const [, , escalate] = availableCaseActions(kind, "open");
      expect(escalate.available).toBe(false);
      expect(escalate.unavailableReason).toMatch(/no tiene estado de escalada/i);
      expect(escalate.unavailableReason).not.toMatch(/todavía/i);
    }
  });

  it("un expediente ya escalado dice que ya lo está, no que no se puede", () => {
    // El operador que aprieta dos veces necesita saber que la primera funcionó.
    // "No se puede escalar" le haría creer que ninguna anduvo.
    for (const kind of CON_ESCALADA) {
      const [, , escalate] = availableCaseActions(kind, "escalated");
      expect(escalate.available).toBe(false);
      expect(escalate.unavailableReason).toMatch(/ya está escalado/i);
    }
  });

  it("un expediente cerrado o fusionado no se escala, y dice cuál de los dos", () => {
    for (const kind of CON_ESCALADA) {
      const [, , cerrado] = availableCaseActions(kind, "closed");
      expect(cerrado.available).toBe(false);
      expect(cerrado.unavailableReason).toMatch(/cerrado/i);

      const [, , fusionado] = availableCaseActions(kind, "merged");
      expect(fusionado.available).toBe(false);
      expect(fusionado.unavailableReason).toMatch(/fusionó/i);
    }
  });
});
