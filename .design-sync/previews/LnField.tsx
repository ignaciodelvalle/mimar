// LnField — the accessible form-field wrapper (label/hint/error wiring via a
// render prop). Real usage: every owner-facing form; pairs with LnInput and
// LnTextarea.
import { LnField, LnInput, LnTextarea } from "dim";

export function Basico() {
  return (
    <div style={{ maxWidth: 360 }}>
      <LnField label="Nombre de la mascota" required>
        {(api) => <LnInput id={api.id} placeholder="Ej.: Rocco" />}
      </LnField>
    </div>
  );
}

export function Estados() {
  return (
    <div style={{ maxWidth: 360, display: "grid", gap: 16 }}>
      <LnField label="Correo electrónico" hint="Usamos tu correo solo para avisos importantes.">
        {(api) => <LnInput id={api.id} type="email" placeholder="lucia@ejemplo.com" />}
      </LnField>
      <LnField label="Número de microchip" error="El número debe tener 15 dígitos." required>
        {(api) => <LnInput id={api.id} mono invalid={api.invalid} defaultValue="85800010003" />}
      </LnField>
      <LnField label="Señas particulares" optional>
        {(api) => <LnInput id={api.id} placeholder="Ej.: mancha blanca en el pecho" />}
      </LnField>
    </div>
  );
}

export function ConTextarea() {
  return (
    <div style={{ maxWidth: 420 }}>
      <LnField
        label="¿Qué pasó?"
        hint="Contanos con tus palabras; después lo convertimos en un evento de la libreta."
      >
        {(api) => (
          <LnTextarea
            id={api.id}
            rows={3}
            defaultValue="Ayer la vacunaron contra la rabia en la Clínica Recoleta."
          />
        )}
      </LnField>
    </div>
  );
}
