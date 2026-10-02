import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Qué hace miMAR — Funcionalidades",
  description:
    "Todo lo que hace miMAR en la web y en la app de Android: lo que funciona en todo el país, lo que llega con las organizaciones de tu zona y lo que se activa cuando tu municipio se suma.",
};

// Honest functionality map. Three tiers by what has to be true for a feature
// to work: nothing (whole country), an organization nearby, or your
// municipality joining. One plain, law-citation-free line per row.
//
// REVISED 2026-10 against the code, row by row:
//   - every "Web · App" tag was checked against a native route under
//     apps/mobile/app (e.g. mascotas/[publicToken]/viaje.tsx, reclamar.tsx,
//     turnos/, adoptar/); a row without one says "Web";
//   - removed the "Homologación de la libreta" row: no such feature exists,
//     and the landing says to keep the paper booklet;
//   - the PPP row no longer promises "inscripción": miMAR classifies by breed
//     and, in CABA only, builds a PDF the owner files;
//   - the libreta is not "inmutable": nothing is erased, corrections are new
//     records;
//   - the vet row keeps its wording on purpose — the signature copy is an
//     open legal question, not part of this revision.

type Platform = "web" | "web-app";

type FeatureRow = { name: string; line: string; platform: Platform };

type FeatureTier = {
  id: string;
  title: string;
  intro: string;
  rows: FeatureRow[];
};

const PLATFORM_LABEL: Record<Platform, string> = {
  web: "Web",
  "web-app": "Web · App",
};

const TIERS: FeatureTier[] = [
  {
    id: "todo-el-pais",
    title: "Para vos y tu mascota, en todo el país",
    intro: "Funciona desde el primer día, vivas donde vivas.",
    rows: [
      {
        name: "Credencial con QR y chapita",
        line: "Una página que identifica a tu mascota desde cualquier teléfono. La chapita con el QR se imprime desde la ficha.",
        platform: "web-app",
      },
      {
        name: "Libreta sanitaria y recordatorios",
        line: "Vacunas, controles y atenciones en orden, con aviso de la próxima vacuna. Nada se borra: las correcciones se agregan como un registro nuevo.",
        platform: "web-app",
      },
      {
        name: "Mascota perdida",
        line: "La marcás como perdida, imprimís un cartel y quien la encuentra te avisa desde la credencial.",
        platform: "web-app",
      },
      {
        name: "Reclamar por microchip o tatuaje",
        line: "Si tu mascota ya está registrada por su chip o su tatuaje, la vinculás a tu cuenta o iniciás una disputa.",
        platform: "web-app",
      },
      {
        name: "Compartir la libreta",
        line: "Un enlace para tu veterinaria o un cuidador, con vencimiento si querés, que podés cortar cuando quieras.",
        platform: "web-app",
      },
      {
        name: "Cuidador temporal",
        line: "Le das acceso acotado a quien cuida a tu mascota mientras no estás.",
        platform: "web-app",
      },
      {
        name: "Transferencias",
        line: "El cambio de responsable queda registrado de punta a punta.",
        platform: "web-app",
      },
      {
        name: "Viajes",
        line: "Un semáforo orientativo de lo que vas a necesitar. No reemplaza el certificado de SENASA.",
        platform: "web-app",
      },
      {
        name: "Denuncias con fotos",
        line: "Denunciás maltrato con fotos y seguís el caso con un código. Desde la web, también sin cuenta.",
        platform: "web-app",
      },
      {
        name: "Vecino en tránsito",
        line: "Si cuidás a un animal sin dueño, lo registrás a tu cargo y editás sus datos mientras no aparezca un titular.",
        platform: "web-app",
      },
      {
        name: "Mudanza y perro de asistencia",
        line: "Actualizás la localidad de tu mascota y registrás si es un perro de asistencia.",
        platform: "web-app",
      },
    ],
  },
  {
    id: "organizaciones",
    title: "Cuando hay organizaciones cerca",
    intro: "Llega con las veterinarias, refugios y redes de rescate de tu zona que se suman.",
    rows: [
      {
        name: "Turnos",
        line: "Reservás turnos en clínicas y en campañas de vacunación o castración de tu zona.",
        platform: "web-app",
      },
      {
        name: "Vacunas firmadas y verificadas",
        line: "Un profesional con matrícula validada firma el evento en tu libreta.",
        platform: "web",
      },
      {
        name: "Atención en la veterinaria",
        line: "La veterinaria ve la historia de tu mascota antes de registrar la atención, en la clínica o a domicilio.",
        platform: "web",
      },
      {
        name: "Adopción",
        line: "Ves mascotas en adopción, te postulás y seguís tu postulación. Si no podés tener a tu mascota, una organización te ayuda a buscarle hogar.",
        platform: "web-app",
      },
      {
        name: "Devolución a su familia",
        line: "Cuando un refugio tiene a tu mascota, coordinan la devolución desde miMAR.",
        platform: "web-app",
      },
      {
        name: "Refugios y custodia",
        line: "Ingreso, permanencia y egreso de los animales que cuida un refugio.",
        platform: "web",
      },
      {
        name: "Tránsitos y traslados",
        line: "Hogares de tránsito voluntarios y traslados entre organizaciones, con registro de quién cuida a cada animal.",
        platform: "web-app",
      },
    ],
  },
  {
    id: "municipio",
    title: "Cuando tu municipio se suma",
    intro: "Herramientas para el área municipal, que se activan con cada jurisdicción.",
    rows: [
      {
        name: "Denuncias y casos",
        line: "El área municipal recibe las denuncias de su territorio y gestiona cada caso.",
        platform: "web",
      },
      {
        name: "Observación antirrábica",
        line: "Tras una mordedura, el período de observación se abre, se sigue y se cierra en miMAR.",
        platform: "web",
      },
      {
        name: "Vigilancia de zoonosis",
        line: "La autoridad sanitaria ve los diagnósticos de enfermedades de notificación obligatoria de su zona.",
        platform: "web",
      },
      {
        name: "Campañas y operativos",
        line: "El municipio sigue el resultado de las campañas de vacunación y castración y de los operativos de su zona.",
        platform: "web",
      },
      {
        name: "Mapa y padrón",
        line: "Tableros de salud animal del territorio, con datos agregados que protegen la identidad de cada vecino.",
        platform: "web",
      },
      {
        name: "Perros potencialmente peligrosos",
        line: "Te avisamos si tu perro entra en el régimen. En la Ciudad de Buenos Aires, armás la constancia para presentar en su registro.",
        platform: "web",
      },
    ],
  },
];

const NOT_YET: string[] = [
  "No reemplaza la libreta de papel: todavía no hay un reconocimiento oficial de la libreta digital.",
  "No emite recetas electrónicas ni reemplaza el sistema de SENASA.",
  "No reemplaza el certificado de SENASA para viajar.",
  "La constancia de perro potencialmente peligroso es solo para la Ciudad de Buenos Aires.",
  "El ingreso con Mi Argentina está en preparación.",
];

function TierRow({ row }: { row: FeatureRow }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-base font-semibold text-[var(--color-ln-ink)]">{row.name}</span>
        <span className="mt-0.5 block text-sm leading-snug text-[var(--color-ln-mute)]">
          {row.line}
        </span>
      </span>
      <span className="shrink-0 whitespace-nowrap pt-1 font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-mute)]">
        {PLATFORM_LABEL[row.platform]}
      </span>
    </div>
  );
}

function TierSection({ tier, children }: { tier: FeatureTier; children?: ReactNode }) {
  return (
    <section aria-labelledby={`${tier.id}-heading`} className="space-y-3">
      <div className="space-y-1">
        <h2 id={`${tier.id}-heading`} className="text-xl font-semibold text-[var(--color-ln-ink)]">
          {tier.title}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--color-ln-mute)]">{tier.intro}</p>
      </div>
      <div className="divide-y divide-[var(--color-ln-line-2)] overflow-hidden rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
        {tier.rows.map((row) => (
          <TierRow key={row.name} row={row} />
        ))}
      </div>
      {children}
    </section>
  );
}

export default function FuncionalidadesPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-16">
        <header className="space-y-3">
          <h1
            className="text-2xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Qué hace miMAR
          </h1>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            miMAR funciona en la web y en la app de Android. Algunas funciones están disponibles en
            todo el país desde el primer día; otras se activan cuando tu municipio o las
            organizaciones de tu zona se suman.
          </p>
        </header>

        {TIERS.map((tier) => (
          <TierSection key={tier.id} tier={tier}>
            {tier.id === "municipio" ? (
              <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
                ¿Trabajás en un municipio?{" "}
                <Link
                  href="/municipios"
                  className="text-[var(--color-ln-azul)] underline underline-offset-4"
                >
                  Conocé cómo sumarlo a miMAR
                </Link>
                .
              </p>
            ) : null}
          </TierSection>
        ))}

        <section
          aria-labelledby="todavia-no-heading"
          className="space-y-2 rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-4"
        >
          <h2
            id="todavia-no-heading"
            className="text-base font-semibold text-[var(--color-ln-ink)]"
          >
            Lo que miMAR todavía no hace
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            {NOT_YET.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <p className="text-sm leading-relaxed text-[var(--color-ln-mute)]">
          La disponibilidad se define en cada jurisdicción. Para saber qué normas se aplican, mirá
          el{" "}
          <Link href="/leyes" className="text-[var(--color-ln-azul)] underline underline-offset-4">
            marco legal
          </Link>
          ; si tenés dudas, entrá a la{" "}
          <Link href="/ayuda" className="text-[var(--color-ln-azul)] underline underline-offset-4">
            ayuda
          </Link>
          .
        </p>

        <Link
          href="/"
          className="inline-block text-md text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Volver al inicio
        </Link>
      </div>
    </div>
  );
}
