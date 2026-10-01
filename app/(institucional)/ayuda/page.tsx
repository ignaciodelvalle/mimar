import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Ayuda — miMAR",
  description: "Centro de ayuda de miMAR — Mi Mascota Argentina.",
};

export default function AyudaPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-6 py-16 space-y-8">
        <h1
          className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          Ayuda
        </h1>

        {/* Register a pet */}
        <section aria-labelledby="registrar-heading" className="space-y-3">
          <h2 id="registrar-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Cómo registro a mi mascota?
          </h2>
          <ol className="text-md text-[var(--color-ln-ink-2)] leading-relaxed space-y-1 list-decimal pl-5">
            <li>
              {/* El paso dice "creá tu cuenta" y enlazaba a la pantalla de
                  INGRESO, mostrando además "/login" — la ruta inglesa que hoy
                  es sólo un redirect permanente. Crear cuenta es /registro. */}
              Creá tu cuenta en{" "}
              <Link
                href="/registro"
                className="text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                Crear cuenta
              </Link>
              . Si ya tenés una, entrá desde{" "}
              <Link
                href="/iniciar-sesion"
                className="text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                Iniciar sesión
              </Link>
              .
            </li>
            <li>
              Una vez dentro, accedé a <strong>Mis mascotas</strong> y usá el botón "Agregar
              mascota".
            </li>
            <li>
              Completá los datos básicos (nombre, especie, raza, fecha de nacimiento) y una foto
              opcional.
            </li>
            <li>
              Tu mascota recibe automáticamente un código <strong>DIM-XXXX-XXXX</strong> y un QR
              verificable.
            </li>
          </ol>
        </section>

        {/* QR credential */}
        <section aria-labelledby="qr-heading" className="space-y-3">
          <h2 id="qr-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Qué es la credencial QR?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Cada mascota registrada tiene una <strong>credencial digital pública</strong>, accesible
            vía QR desde cualquier dispositivo. Podés compartirla, imprimirla o usarla como
            identificación ante veterinarios, refugios o autoridades. El QR resuelve a una página
            con los datos básicos del animal (foto, nombre, especie, microchip si existe) sin
            exponer información personal del dueño por defecto.
          </p>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Si tu mascota está reportada como perdida, la credencial muestra también las
            instrucciones de contacto para quien la encuentre.
          </p>
        </section>

        {/* Lost pet */}
        <section aria-labelledby="perdida-heading" className="space-y-3">
          <h2 id="perdida-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            Mi mascota se perdió — ¿qué hago?
          </h2>
          <ol className="text-md text-[var(--color-ln-ink-2)] leading-relaxed space-y-1 list-decimal pl-5">
            <li>
              Entrá a <strong>Mis mascotas</strong>, seleccioná a tu animal y usá la opción "Marcar
              como perdida".
            </li>
            <li>
              Completá la descripción del lugar y fecha de la última vez que la viste. Podés activar
              datos de contacto de forma controlada para que aparezcan en la credencial pública.
            </li>
            <li>
              Quien encuentre a tu mascota puede escanear su QR y ver las instrucciones de contacto.
              También puede reportar un avistamiento desde la misma página.
            </li>
            <li>
              {/* Decía "el mapa de mascotas perdidas". /perdidas es un LISTADO
                  con filtros por provincia — no renderiza ningún mapa. El único
                  punto en un mapa vive dentro de la credencial individual, y
                  sólo si el dueño habilitó divulgar la ubicación. */}
              Consultá el{" "}
              <Link
                href="/perdidas"
                className="text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                listado de mascotas perdidas
              </Link>{" "}
              para ver reportes recientes.
            </li>
          </ol>
        </section>

        {/* Denuncias */}
        <section aria-labelledby="denuncias-heading" className="space-y-3">
          <h2 id="denuncias-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Cómo reporto un caso de maltrato o animal en riesgo?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Accedé a la sección{" "}
            <Link
              href="/denuncias"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              Denuncias
            </Link>{" "}
            y completá el formulario. No necesitás cuenta para denunciar. Podés indicar el tipo de
            situación (abandono, negligencia, maltrato físico, animal encadenado, sin refugio,
            acumulación, peleas, venta clandestina u otra), la gravedad estimada y la ubicación.
          </p>
          {/* Dos correcciones (auditoría 2026-08-12), las dos eran falsas:
              · "mordedura" NO es un tipo de denuncia. Los tipos reales son los 9
                de WELFARE_REPORT_KINDS (src/modules/welfare/domain/types.ts:12);
                la mordedura viaja por el circuito clínico/organizacional.
              · "Las denuncias son recibidas por las autoridades sanitarias
                pertinentes" contradecía a /denuncias, que aclara que la
                integración con canales estatales está en desarrollo. El código
                respalda a /denuncias: la gestión es interna. Esta era la
                contradicción con consecuencia física — alguien podía no llamar
                al 911 creyendo que ya había avisado a la autoridad. */}
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Tu denuncia queda registrada y llega a la bandeja del organismo de tu jurisdicción
            dentro de miMAR. La derivación automática a canales gubernamentales externos todavía
            está en desarrollo.{" "}
            <strong className="font-semibold text-[var(--color-ln-ink)]">
              Si hay un animal en peligro inmediato, llamá al 911
            </strong>{" "}
            además de dejar la denuncia acá.
          </p>
        </section>

        {/* Adoptions */}
        <section aria-labelledby="adopciones-heading" className="space-y-3">
          <h2 id="adopciones-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Cómo busco mascotas en adopción?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            Visitá la sección{" "}
            <Link
              href="/adoptar"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              Adoptar
            </Link>{" "}
            para ver los animales disponibles publicados por refugios registrados en miMAR. Podés
            filtrar por especie, tamaño, energía y ubicación. La postulación para adoptar llega
            directamente al refugio.
          </p>
        </section>

        {/* Shelters */}
        <section aria-labelledby="refugios-heading" className="space-y-3">
          <h2 id="refugios-heading" className="text-lg font-semibold text-[var(--color-ln-ink)]">
            ¿Dónde veo los refugios y organizaciones?
          </h2>
          <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed">
            En la sección{" "}
            <Link
              href="/refugios"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              Refugios
            </Link>{" "}
            podés explorar las organizaciones registradas, ver sus animales en adopción y encontrar
            su información de contacto pública.
          </p>
        </section>

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
