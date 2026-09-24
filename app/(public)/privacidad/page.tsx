import { LEGAL_VERSION, LEGAL_VERSION_LABEL } from "@/lib/reference/legal-version";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Política de privacidad — miMAR",
  description:
    "Cómo miMAR recopila, usa y protege tus datos personales, en cumplimiento de la Ley 25.326.",
};

export default function PrivacidadPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-10">
        <header className="space-y-2">
          <h1
            className="text-4xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Política de privacidad
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            Última actualización: {LEGAL_VERSION_LABEL}{" "}
            <span className="text-[var(--color-ln-mute)]">(v{LEGAL_VERSION})</span>
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Marco legal aplicable
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR trata los datos personales de sus usuarios conforme a la{" "}
            <strong>Ley 25.326 de Protección de Datos Personales</strong> de la República Argentina
            y su decreto reglamentario 1558/2001.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Datos que recopilamos
          </h2>
          <ul className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc list-inside">
            <li>
              <strong>Datos de cuenta:</strong> correo electrónico y nombre visible, necesarios para
              autenticar tu sesión.
            </li>
            <li>
              <strong>Datos de mascota:</strong> nombre, especie, raza, foto, microchip y eventos
              sanitarios que vos ingresás voluntariamente.
            </li>
            <li>
              <strong>Datos de ubicación:</strong> tu cuenta no guarda una provincia ni una
              localidad. Las denuncias se enrutan por la ubicación del hecho que reportás, no por la
              de tu cuenta ni por la de una mascota; la jurisdicción registrada en cada mascota es
              la que alimenta las estimaciones de cobertura. En los formularios de mascota perdida,
              avistajes, denuncias y mordeduras podés indicar una ubicación exacta (GPS del
              dispositivo, un pin en el mapa o una dirección geocodificada) — siempre por una acción
              tuya explícita (tocar &quot;Usar mi ubicación&quot; o marcar el mapa), nunca de forma
              automática ni en segundo plano. Esas coordenadas quedan asociadas al evento
              correspondiente y se conservan mientras la mascota permanezca registrada, como parte
              de su historial; desde tu cuenta podés{" "}
              <Link
                href="/cuenta/privacidad"
                className="underline underline-offset-4 hover:text-[var(--color-ln-azul)] transition-colors"
              >
                solicitar la eliminación de tu cuenta y sus datos asociados
              </Link>{" "}
              en cualquier momento (ver &quot;Tus derechos&quot; más abajo). Si alguien escanea el
              código QR de una mascota marcada como perdida, puede compartir su ubicación GPS de
              forma voluntaria para ayudar a encontrarla; ese dato no identifica a quien escanea y,
              a diferencia de los eventos anteriores, se purga automáticamente a los 90 días.
            </li>
            <li>
              <strong>Denuncias anónimas:</strong> las denuncias de maltrato pueden enviarse sin
              sesión. Si dejás un contacto de seguimiento, se asocia únicamente al código de la
              denuncia y no a ningún perfil de usuario.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Finalidad del tratamiento
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Los datos se usan exclusivamente para operar el servicio: gestionar credenciales de
            mascotas, facilitar el reencuentro de animales perdidos, enrutar denuncias de maltrato a
            la autoridad jurisdiccional competente y emitir recordatorios sanitarios. No
            comercializamos ni cedemos datos personales a terceros con fines publicitarios.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Con quién se comparten tus datos
          </h2>
          <ul className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc list-inside">
            <li>
              <strong>Credencial pública:</strong> cualquier persona que escanee el código QR de tu
              mascota ve los datos públicos de su credencial (nombre, especie, raza y estado). La
              información médica de Nivel 2 se muestra únicamente si vos la habilitás desde el
              perfil de la mascota, y podés desactivarla en cualquier momento.
            </li>
            <li>
              <strong>Buscadores y copias de terceros:</strong> la credencial pública es una página
              web abierta, así que los buscadores pueden encontrarla e indexarla. Eso es
              intencional: es lo que ayuda a que aparezca una mascota perdida. Le pedimos a los
              buscadores que no guarden copias ni muestren fragmentos del contenido, pero es un
              pedido, no un control nuestro. Mientras algo está publicado, cualquiera puede verlo,
              copiarlo o archivarlo. Si después lo desactivás, la página deja de mostrarlo al
              instante, y las copias que ya existan fuera de miMAR no las podemos borrar.
            </li>
            <li>
              <strong>Enlaces de libreta compartida:</strong> los enlaces de libreta sanitaria que
              generás los compartís vos con quien decidas (por ejemplo, un veterinario). Quien
              recibe el enlace puede ver el contenido de la libreta mientras el enlace esté vigente.
            </li>
            <li>
              <strong>Autoridades competentes:</strong> los funcionarios habilitados pueden buscar
              credenciales por DNI del responsable en el ejercicio de sus funciones, y las denuncias
              se derivan a la autoridad jurisdiccional que corresponde según la ubicación reportada.
            </li>
            <li>
              <strong>Datos abiertos:</strong> publicamos estadísticas agregadas en el marco de la
              Ley 27.275 de Acceso a la Información Pública. Antes de publicar se suprimen los
              grupos pequeños (k-anonimato), de modo que ningún dato publicado permita identificarte
              a vos ni a tu mascota.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Tus derechos (Art. 14 Ley 25.326)
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Tenés derecho a acceder, rectificar, actualizar y suprimir tus datos personales. Desde
            tu cuenta podés{" "}
            <Link
              href="/cuenta/privacidad"
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)] transition-colors"
            >
              descargar una copia de tus datos o solicitar la eliminación de tu cuenta
            </Link>
            . Para otros ejercicios de derechos, escribinos a la dirección de contacto indicada más
            abajo. Respondemos dentro de los plazos que establece la ley.
          </p>
        </section>

        {/*
          HOW TO DELETE — the section a Google Play reviewer opens this page to find.

          Play's data-deletion requirement asks for two reachable things from an
          app that offers account creation: an in-app route (apps/mobile/src/
          account/AccountDeletionCard.tsx) and a WEB URL that explains the
          request, which is what the Data safety form takes. Until now this page
          linked twice to /cuenta/privacidad and never said what happens there —
          and /cuenta/privacidad is behind `requireUserOrRedirect`, so a reviewer
          following the link without an account lands on a login screen. A link
          into a login wall is not an explanation; a reviewer cannot tell it from
          a dead end, and neither can a user deciding whether to sign up.

          THE COPY IS MIRRORED, NOT REWRITTEN. What survives an erasure is stated
          in app/(app)/cuenta/privacidad/page.tsx, and that wording is the
          product of a correction (2026-08-17): the retention of sanitary events
          is a PRODUCT decision, not a legal obligation, and may not be presented
          as one — see the ERRATA at the top of src/modules/auth/application/
          subject-rights/erase-subject-data.ts, which found the SENASA / Ley
          14.072 / Ord. 41.831 citations in the migrations to be false. A second,
          looser paraphrase here would be a second version of a promise whose
          whole value is that there is one, so this section says the same thing
          in the same terms and links onward for the rest.

          WHY LEGAL_VERSION IS NOT BUMPED. It records WHAT a user consented to,
          and there is no re-acceptance flow (lib/reference/legal-version.ts).
          This section adds no collection, no sharing and no retention — it
          documents a right the page already granted and a mechanism that already
          shipped. Bumping would put every existing profile's stored consent
          version behind the current one, with nothing able to resolve the gap,
          in exchange for recording a clarification as a substantive revision.
        */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Cómo eliminar tu cuenta
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            La baja la hacés vos, desde tu cuenta, sin escribirnos y sin esperar una respuesta:
          </p>
          <ol className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-decimal list-inside">
            <li>Ingresá con tu correo electrónico y contraseña.</li>
            <li>
              Entrá a{" "}
              <Link
                href="/cuenta/privacidad"
                className="underline underline-offset-4 hover:text-[var(--color-ln-azul)] transition-colors"
              >
                Mi cuenta → Privacidad y datos personales
              </Link>
              .
            </li>
            <li>
              Tocá &quot;Quiero eliminar mi cuenta&quot;, escribí el motivo y confirmá el borrado.
            </li>
          </ol>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            En la app de Android el camino es <strong>Ajustes → Eliminar mi cuenta</strong>, que
            abre esa misma página en el navegador: la baja se hace en un solo lugar. Si no podés
            ingresar a tu cuenta, escribinos a la dirección de contacto de más abajo y la tramitamos
            nosotros.
          </p>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            <strong>Qué pasa cuando se elimina una cuenta.</strong> La supresión es un soft-delete
            con hash de PII: nombre, teléfono, DNI, contactos de emergencia, veterinario de cabecera
            y foto de perfil quedan anonimizados o borrados, y la cuenta sale de las consultas
            habituales. Se borran también los mismos datos cargados en cada mascota —contacto de
            emergencia, veterinario y seguro—, las invitaciones de cuidado temporal que hayas
            enviado o recibido, tu inscripción como hogar de tránsito, tus dispositivos con
            notificaciones y el contenido de los mensajes que le hayas escrito a una organización.
            Las credenciales públicas de tus mascotas dejan de resolver. Los eventos sanitarios de
            esas mascotas (libreta, vacunas, observaciones antirrábicas) se conservan por una razón
            práctica: son el historial de salud del animal, y ese historial lo acompaña aunque
            cambie de responsable. Dentro de esos eventos, el texto libre que hayas escrito vos se
            reemplaza por un aviso de contenido eliminado. Si querés que borremos también esos
            registros sanitarios, pedínoslo:{" "}
            <strong>no invocamos ninguna obligación legal de conservación</strong> para negarte ese
            borrado.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">Contacto</h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Para consultas sobre privacidad o ejercicio de derechos de los titulares, podés
            escribirnos a{" "}
            <a
              href={mailtoHref(CONTACT_EMAILS.privacy)}
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)] transition-colors"
            >
              {CONTACT_EMAILS.privacy}
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
