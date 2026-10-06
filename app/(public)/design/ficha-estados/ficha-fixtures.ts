// Fixture catalogue for /design/ficha-estados. Not live pet data.
// The nine product situations, plus a new pet, a stack of notices, and a
// co-owner so a grey row can show its reason.

import type { OwnerPetDetailViewerRole } from "@dim/contract/api";
import type { CredentialSituationKey } from "@dim/contract/credential";

export type FichaNotice = { icon: string; label: string };
export type FichaStep = { label: string; done: boolean };
export type FichaLibretaRow = { what: string; who: string; when: string; upcoming?: boolean };

export type FichaFixture = {
  id: string;
  kicker: string;
  note: string;
  name: string;
  token: string;
  meta: string;
  sex: "female" | "male";
  situation: CredentialSituationKey;
  /** Right-hand cell. Deceased is none; lost-with-a-point is ping. */
  cell: "qr" | "ping" | "none";
  notices: FichaNotice[];
  compliance: { summary: string; rows: { dt: string; dd: string }[] } | null;
  nextDue: string | null;
  firstSteps: FichaStep[] | null;
  petStatus: "active" | "lost" | "deceased";
  viewerRole: OwnerPetDetailViewerRole;
  showActions: boolean;
  flip: boolean;
  libreta: FichaLibretaRow[];
  weights: number[] | null;
};

const LIBRETA: FichaLibretaRow[] = [
  { what: "Antirrábica", who: "Próxima dosis", when: "18 oct 2026", upcoming: true },
  { what: "Vacuna séxtuple", who: "Vet. Luna · clínica", when: "12 mar 2026" },
  { what: "Peso 8,2 kg", who: "La familia", when: "2 oct 2026" },
];

const WEIGHTS = [7.4, 7.6, 7.9, 8.1, 8.2];

function base(partial: FichaFixture): FichaFixture {
  return partial;
}

export const FICHA_FIXTURES: readonly FichaFixture[] = [
  base({
    id: "al-dia",
    kicker: "Al día",
    note: "Sin chip de situación. El cumplimiento es el contenido, en calma.",
    name: "Pampa",
    token: "DIM-MUES-0001",
    meta: "Perro · Caniche · Hembra · 4 años",
    sex: "female",
    situation: "al-dia",
    cell: "qr",
    notices: [],
    compliance: {
      summary: "3 de 4 al día",
      rows: [
        { dt: "Antirrábica", dd: "Al día" },
        { dt: "Séxtuple", dd: "Al día" },
        { dt: "Desparasitación", dd: "Falta" },
        { dt: "Esterilización", dd: "Al día" },
      ],
    },
    nextDue: "Próximo · Antirrábica · 18 oct",
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA,
    weights: WEIGHTS,
  }),
  base({
    id: "perdida",
    kicker: "Perdida",
    note: "La situación es lo único fuerte. El ping ocupa la celda.",
    name: "Firulais",
    token: "DIM-3MF8-6674",
    meta: "Perro · Caniche · Macho",
    sex: "male",
    situation: "perdida",
    cell: "ping",
    notices: [{ icon: "clock", label: "Última vez vista hace 22 h · Palermo" }],
    compliance: {
      summary: "2 de 4 al día",
      rows: [
        { dt: "Antirrábica", dd: "Al día" },
        { dt: "Microchip", dd: "Sí" },
      ],
    },
    nextDue: null,
    firstSteps: null,
    petStatus: "lost",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA,
    weights: WEIGHTS,
  }),
  base({
    id: "custodia",
    kicker: "Custodia oficial",
    note: "Ámbar, con escudo. No es una emergencia médica.",
    name: "Tito",
    token: "DIM-TITO-0004",
    meta: "Perro · Mestizo · Macho · 6 años",
    sex: "male",
    situation: "custodia-oficial",
    cell: "qr",
    notices: [{ icon: "shield", label: "Autoridad a cargo: Zoonosis CABA" }],
    compliance: null,
    nextDue: null,
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA.slice(1),
    weights: null,
  }),
  base({
    id: "observacion",
    kicker: "Observación antirrábica",
    note: "Celeste, con el ícono de ver. El plazo va escrito.",
    name: "Luna",
    token: "DIM-LUNA-0002",
    meta: "Perro · Cruza · Hembra · 3 años",
    sex: "female",
    situation: "observacion-antirrabica",
    cell: "qr",
    notices: [{ icon: "clock", label: "Día 4 de 10 · cierra el 10 oct" }],
    compliance: null,
    nextDue: null,
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA.slice(1),
    weights: null,
  }),
  base({
    id: "tratamiento",
    kicker: "En tratamiento",
    note: "El dueño lo ve. La credencial pública no tiñe este estado.",
    name: "Mora",
    token: "DIM-MORA-0007",
    meta: "Gato · Común · Hembra · 2 años",
    sex: "female",
    situation: "en-tratamiento",
    cell: "qr",
    notices: [{ icon: "medicacion", label: "Meloxicam · 1 comprimido cada 24 h · día 3 de 7" }],
    compliance: null,
    nextDue: "Próximo · Meloxicam · mañana 8:00",
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: [
      { what: "Meloxicam", who: "En curso", when: "mañana 8:00", upcoming: true },
      { what: "Consulta", who: "Vet. Luna", when: "1 oct 2026" },
    ],
    weights: null,
  }),
  base({
    id: "prenada",
    kicker: "Preñada",
    note: "Rosa, con el ícono. Una sola voz; el resto son filas.",
    name: "Nina",
    token: "DIM-NINA-0011",
    meta: "Perro · Labrador · Hembra · 5 años",
    sex: "female",
    situation: "prenada",
    cell: "qr",
    notices: [{ icon: "clock", label: "Semana 6 · control el 22 oct" }],
    compliance: null,
    nextDue: "Próximo · Control de gestación · 22 oct",
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA.slice(1),
    weights: null,
  }),
  base({
    id: "adopcion",
    kicker: "En adopción",
    note: "La mascota sigue en casa. La fila lo dice.",
    name: "Coco",
    token: "DIM-COCO-0008",
    meta: "Perro · Beagle · Macho · 1 año",
    sex: "male",
    situation: "en-adopcion",
    cell: "qr",
    notices: [{ icon: "casa", label: "Vive con su familia · El Campito acompaña la adopción" }],
    compliance: null,
    nextDue: null,
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA.slice(1),
    weights: null,
  }),
  base({
    id: "transito",
    kicker: "En tránsito",
    note: "Misma familia de color que adopción. El ícono de casa las separa.",
    name: "Lola",
    token: "DIM-LOLA-0009",
    meta: "Gato · Común · Hembra · 8 meses",
    sex: "female",
    situation: "en-transito",
    cell: "qr",
    notices: [{ icon: "casa", label: "En tránsito con Ana · hogar definitivo en busca" }],
    compliance: null,
    nextDue: null,
    firstSteps: null,
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: [],
    weights: null,
  }),
  base({
    id: "fallecida",
    kicker: "Fallecida",
    note: "Sobria. Sin celda, sin acciones. La libreta no gira.",
    name: "Laika",
    token: "DIM-MUES-0015",
    meta: "Perro · Cruza · Hembra · 2019–2026",
    sex: "female",
    situation: "fallecida",
    cell: "none",
    notices: [],
    compliance: null,
    nextDue: null,
    firstSteps: null,
    petStatus: "deceased",
    viewerRole: "owner",
    showActions: false,
    flip: false,
    libreta: [],
    weights: null,
  }),
  base({
    id: "nueva",
    kicker: "Recién registrada",
    note: "Primeros pasos, invitación. No es un aviso.",
    name: "Rita",
    token: "DIM-RITA-0020",
    meta: "Perro · Sin raza cargada · Hembra",
    sex: "female",
    situation: "al-dia",
    cell: "qr",
    notices: [],
    compliance: {
      summary: "0 de 4 con datos",
      rows: [
        { dt: "Antirrábica", dd: "Sin dato" },
        { dt: "Microchip", dd: "Sin dato" },
      ],
    },
    nextDue: null,
    firstSteps: [
      { label: "Agregá una foto", done: false },
      { label: "Cargá el microchip", done: false },
      { label: "Registrá su primera vacuna", done: false },
      { label: "Sumá un contacto de emergencia", done: false },
      { label: "Decidí qué se muestra si se pierde", done: true },
    ],
    petStatus: "active",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: [],
    weights: null,
  }),
  base({
    id: "avisos",
    kicker: "Varios avisos a la vez",
    note: "Perdida es la voz fuerte. Las otras cuatro son filas, con ícono y texto.",
    name: "Negra",
    token: "DIM-NEGR-0003",
    meta: "Gato · Común · Hembra · 2 años",
    sex: "female",
    situation: "perdida",
    cell: "ping",
    notices: [
      { icon: "clock", label: "Última vez vista hace 4 días · Belgrano" },
      { icon: "medicacion", label: "Medicación diaria · no dice cuál en la calle" },
      { icon: "clock", label: "Antirrábica vence en 12 días" },
      { icon: "casa", label: "Cuidadora temporal hasta el 20 oct" },
    ],
    compliance: null,
    nextDue: "Próximo · Antirrábica · en 12 días",
    firstSteps: null,
    petStatus: "lost",
    viewerRole: "owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA,
    weights: WEIGHTS,
  }),
  base({
    id: "cotitular",
    kicker: "Cotitular",
    note: "Lo que no puede hacer queda gris, con el motivo. No se esconde.",
    name: "Pampa",
    token: "DIM-MUES-0001",
    meta: "Perro · Caniche · Hembra · 4 años",
    sex: "female",
    situation: "al-dia",
    cell: "qr",
    notices: [],
    compliance: {
      summary: "3 de 4 al día",
      rows: [{ dt: "Antirrábica", dd: "Al día" }],
    },
    nextDue: null,
    firstSteps: null,
    petStatus: "active",
    viewerRole: "co_owner",
    showActions: true,
    flip: true,
    libreta: LIBRETA.slice(0, 2),
    weights: null,
  }),
];

export function fichaSituationsShown(): CredentialSituationKey[] {
  return [...new Set(FICHA_FIXTURES.map((f) => f.situation))];
}
