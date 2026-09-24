// La caja de captura rápida, arriba del menú de Asentar.
//
// QUÉ ES. Alguien escribe "le di la antirrábica hoy" y la app le abre el
// formulario de Vacuna con el nombre y la fecha ya puestos. Nada más. Toda la
// regla sobre qué frase puede abrir qué formulario vive en `capture-match.ts`,
// que es puro; esto es la caja, los tres estados que puede mostrar y los tres
// botones.
//
// DÓNDE VA, Y POR QUÉ ACÁ Y NO EN EL INICIO (decisión del PO, 2026-09-16)
// ---------------------------------------------------------------------------
// Adentro del flujo que ya existe, arriba de las trece filas, sin tocar la
// navegación principal. Es la opción barata: lo que se ahorra es LEER un menú de
// trece filas y decidir cuál de los nombres de la app corresponde a lo que pasó,
// que es el trabajo caro, y no hace falta rediseñar nada para averiguar si el
// matcher sirve. En el inicio habría que resolver primero de CUÁL mascota se
// habla; acá esa pregunta ya está contestada por la ruta.
//
// ARRIBA DEL MENÚ Y NO EN LUGAR DEL MENÚ. Dos razones, y la segunda es la dura:
// el camino rápido abajo de una lista de trece filas no es un camino rápido; y
// la lista es la única enumeración COMPLETA de lo que se puede escribir. El
// matcher no llega a todos los kinds (ver `capture-match.ts`), así que una caja
// que reemplazara al menú dejaría formularios sin puerta.
//
// NO SE ENFOCA SOLA, Y ESA ES LA DECISIÓN MÁS DISCUTIBLE DE ACÁ
// ---------------------------------------------------------------------------
// `autoFocus` ahorraría un toque a quien viene a escribir. Cobraría uno a quien
// viene a tocar una fila: el teclado se abre sin que nadie lo pida, tapa la
// mitad inferior de la pantalla, y hay que cerrarlo antes de llegar a las filas
// de abajo. Son los dos caminos y no uno: el menú es el que funciona hoy y no
// puede empeorar para probar el que todavía no sabemos si sirve. Un toque para
// enfocar la caja es el mismo toque que cuesta una fila, así que el camino nuevo
// no queda en desventaja; el viejo queda igual que ayer.
//
// LO QUE SÍ SE AHORRA ES EL BOTÓN: la tecla de enviar del teclado identifica.
// El campo es de UNA línea justamente para eso (en uno multilínea esa tecla
// escribe un salto de línea, que es su trabajo), y `submitBehavior="submit"`
// del kit hace que el teclado NO se cierre: si la lectura salió mal, la persona
// corrige el texto sin volver a tocar el campo.
//
// SIEMPRE SE MUESTRA LO QUE SE ENTENDIÓ, ANTES DE ABRIR NADA
// ---------------------------------------------------------------------------
// Con confianza alta también. Este formulario escribe en una libreta que no se
// edita: una equivocación se corrige asentando otra cosa encima, para siempre.
// El modo de fallar que importa no es "abrió el formulario equivocado y me di
// cuenta", es "lo abrió bien llenado, con el valor equivocado, y firmé". Un
// campo lleno se lee como un campo revisado. La tarjeta es el único momento en
// que la persona lee la INTERPRETACIÓN de la app en vez de un formulario.
//
// Cuesta un toque. Es el mismo que ya paga la consola de atender, que es la más
// nueva de las dos superficies de captura de la web y la que tomó esta decisión
// después de haber visto funcionar la otra.
//
// NADA DE ESTO ASIENTA NADA. Abre un formulario con campos puestos. Lo único
// que escribe en la libreta es el botón del final de ese formulario, apretado
// por una persona que lo está mirando.

import { useState } from "react";

import { CAPTURE_INPUT_MAX_LENGTH } from "@dim/contract/events";

import { Body } from "../ui/components";
import { Callout, PrimaryButton, SecondaryButton, TextField } from "../ui/kit";
import {
  type CaptureOutcome,
  captureConfidenceNote,
  captureOpenLabel,
  readCapture,
} from "./capture-match";
import type { EventDraft, PetFactsForMenu, WritableKind } from "./record-event-view-model";
import { kindTitle } from "./record-event-view-model";

/**
 * Los ejemplos del placeholder, uno al azar por visita.
 *
 * ROTAN PORQUE ENSEÑAN. Una caja de texto libre no dice por sí sola qué se
 * puede escribir adentro, y el ejemplo fijo enseña una sola cosa: quien ve
 * siempre "le di la antirrábica" aprende que sirve para vacunas. Son los mismos
 * cinco de la web (`CaptureBox.tsx`), para que la frase que a alguien le
 * funcionó en un lado le funcione en el otro.
 */
export const CAPTURE_EXAMPLES = [
  'ej: "le di la antirrábica hoy"',
  'ej: "pesa 12,5 kg"',
  'ej: "lo castraron ayer"',
  'ej: "le pusieron el chip"',
  'ej: "tiene vómitos hace 2 días"',
] as const;

/** Lo que se está mostrando debajo del campo. `null` es todavía nada. */
type BoxResult = CaptureOutcome | null;

export function QuickCaptureBox({
  facts,
  onOpen,
}: {
  /** Los mismos hechos con los que el menú decide sus filas condicionales. */
  facts: PetFactsForMenu | null;
  /** Abrir el formulario de `kind` con estos campos puestos. */
  onOpen: (kind: WritableKind, prefill: Partial<EventDraft>) => void;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<BoxResult>(null);
  const [example] = useState(
    () => CAPTURE_EXAMPLES[Math.floor(Math.random() * CAPTURE_EXAMPLES.length)],
  );

  function identify() {
    if (text.trim().length === 0) return;
    setResult(readCapture(text, facts));
  }

  return (
    <>
      <TextField
        label="Contá qué pasó"
        value={text}
        onChangeText={(value) => {
          setText(value);
          // LA TARJETA NUNCA SOBREVIVE AL TEXTO QUE LA PRODUJO. Una tarjeta que
          // dice "Vacuna" arriba de un campo que ahora dice "pesó 12 kilos" es
          // el formulario equivocado esperando un toque.
          if (result !== null) setResult(null);
        }}
        placeholder={example}
        // El matcher trunca a este largo antes de mirar nada. Truncar acá es lo
        // mismo pero VISIBLE: quien pega un texto largo ve qué quedó.
        maxLength={CAPTURE_INPUT_MAX_LENGTH}
        // Una línea a propósito: es lo que hace que la tecla del teclado
        // identifique en vez de escribir un salto. Ver la cabecera.
        returnKeyType="search"
        onSubmitEditing={identify}
        accessibilityHint="Escribí lo que pasó con tus palabras y te abrimos el formulario que corresponde."
      />
      {/* SECUNDARIO, NO PRIMARIO, y no es timidez: mientras no hay lectura, esta
          pantalla es un menú de trece filas iguales y no tiene una acción
          principal. La única primaria de la pantalla aparece con la tarjeta, y
          es la que abre el formulario. Dos pastillas azules a la vez serían dos
          respuestas a "¿qué hago ahora?". */}
      <SecondaryButton label="Identificar" disabled={text.trim().length === 0} onPress={identify} />

      {result === null ? null : <CaptureResult result={result} text={text} onOpen={onOpen} />}
    </>
  );
}

/** Los tres finales posibles de una lectura. Ver `CaptureOutcome`. */
function CaptureResult({
  result,
  text,
  onOpen,
}: {
  result: CaptureOutcome;
  text: string;
  onOpen: (kind: WritableKind, prefill: Partial<EventDraft>) => void;
}) {
  if (result.status === "matched") {
    return (
      <Callout
        // EL COLOR REFUERZA, NUNCA INFORMA SOLO. La frase de arriba ya dice si
        // estamos seguros o no (`captureConfidenceNote`); el tono es la segunda
        // señal, que es la doctrina que la tarjeta de la web ya sigue.
        tone={result.confidence === "high" ? "neutral" : "warn"}
        title={kindTitle(result.kind)}
      >
        <Body>{captureConfidenceNote(result.confidence)}</Body>
        {result.understood.map((field) => (
          <Body key={field.label}>
            {field.label}: {field.value}
          </Body>
        ))}
        {result.understood.length === 0 ? (
          // RECONOCIÓ EL TIPO Y NINGÚN DATO, que es lo normal en los formularios
          // cuyos campos necesitarían un LLM (mordedura, medicación, clínico).
          // Decirlo es mejor que mostrar una tarjeta con un título y nada
          // abajo, que se lee como una tarjeta rota.
          <Body>El formulario se abre vacío, con la fecha de hoy.</Body>
        ) : null}
        <PrimaryButton
          label={captureOpenLabel(result.kind)}
          onPress={() => onOpen(result.kind, result.prefill)}
        />
      </Callout>
    );
  }

  if (result.status === "elsewhere") {
    return (
      <Callout tone="neutral" title={kindTitle(result.kind)}>
        {/* NO ES "NO LO RECONOCIMOS", PORQUE SÍ LO RECONOCIMOS. Mandar a alguien
            a buscar en una lista que no lo tiene es peor que no contestar. */}
        <Body>Eso no se asienta desde acá. {result.where}</Body>
      </Callout>
    );
  }

  return (
    <Callout tone="warn" title="No lo reconocimos">
      <Body>
        Podés decirlo de otra manera, elegir el tipo en la lista de abajo, o dejarlo como nota tal
        cual lo escribiste.
      </Body>
      {/* LA FRASE NUNCA SE TIRA A LA BASURA. Es la misma salida que la caja de
          la web ofrece, y existe porque el peor final de una captura es que la
          persona escriba una oración, la app no la entienda, y la oración
          desaparezca. La nota la abre con el texto adentro; asentarla sigue
          siendo decisión de ella. */}
      <SecondaryButton
        label="Abrir una nota con este texto"
        onPress={() => onOpen("note", { text: text.trim() })}
      />
    </Callout>
  );
}
