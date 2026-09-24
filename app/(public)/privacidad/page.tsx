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

        {/*
          PROVIDERS AND THE INTERNATIONAL TRANSFER — finding S-2, PO decision 6A
          (2026-09-24). Ley 25.326 art. 6 requires telling the holder who
          receives the data; art. 12 forbids a transfer to a country without
          adequate protection unless the holder consents expressly. Brazil and
          the US are not on the AAIP adequacy list (Disposición 60/2016). Google
          Play's Data safety form must also match this list.

          EVERY LINE WAS CHECKED AGAINST THE CODE, and each is scoped to what the
          code sends, not to what the vendor could in principle receive:
            · Sentry is the ANDROID app only. The web's client errors go to this
              app's own /api/telemetry/client-error (components/
              ErrorSinkBootstrap.tsx), i.e. to Vercel, never to Sentry. What
              Sentry gets is scrubbed on the phone (apps/mobile/src/
              observability/redact.ts); sendDefaultPii and attachScreenshot are
              off (./sentry.ts), and nothing calls Sentry.setUser.
            · Expo / FCM see a push token and a lock-screen text that names no
              person and no pet (LOCK_SCREEN_SAFE_NOTIFICATION_TYPES and the
              generic fallback in lib/infra/expo-push.ts), plus data.url.
            · Web Push is end-to-end encrypted to the browser (lib/infra/
              web-push.ts), so the browser vendor's push service cannot read it.
            · OpenStreetMap: tiles are fetched by the BROWSER (middleware.ts CSP,
              components/LocationMap.tsx) — it sees the IP; geocoding is a
              SERVER-side proxy (lib/infra/geocoding.ts) — it sees the query only.
          No contract, certification or standard clause is claimed, because
          none is on file in this repo. Do not add one without the document.

          WHY LEGAL_VERSION WAS BUMPED FOR THIS (and not for the deletion section
          below): this section discloses a sharing and a transfer the page never
          named, and the signup sentence now consents to it by name. That is a
          substantive revision, and tos_version is how a profile proves which
          text it accepted. The bump only changes what NEW acceptances record,
          and only for a client that DISPLAYED this version: signup step 1 puts
          the version the client showed in app_metadata (server-only), and
          complete-identity-for-user.ts stamps it (known versions only; absent
          = 2026-07-23, e.g. an old Android bundle). Nothing compares a stored
          version against the current one, so existing accounts keep theirs and
          are not asked anything — see the PO-DECISION note below.
        */}
        <section id="proveedores" className="space-y-3 scroll-mt-6">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Proveedores que procesan datos por cuenta de miMAR
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR funciona sobre servicios de otras empresas. Procesan tus datos solamente para
            prestarle su servicio a miMAR, y varias están fuera de la Argentina. Estas son todas,
            con lo que hace cada una, qué datos recibe y dónde está:
          </p>
          <ul className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed space-y-2 list-disc list-inside">
            <li>
              <strong>Supabase</strong> — Brasil (región São Paulo). Base de datos, inicio de sesión
              y almacenamiento de archivos. Guarda todo lo que cargás en miMAR: tu cuenta, tus
              mascotas, sus eventos y las fotos y documentos que subís.
            </li>
            <li>
              <strong>Vercel</strong> — empresa de Estados Unidos; los servidores de miMAR corren en
              São Paulo, Brasil. Aloja el sitio web: por ahí pasa cada pedido que hace tu navegador
              o la app, con tu dirección IP, y quedan sus registros técnicos, incluidos los reportes
              de error del sitio. Su red de distribución entrega las páginas desde nodos en
              distintos países.
            </li>
            <li>
              <strong>Sentry</strong> — Estados Unidos. Reportes de fallas de la app de Android (el
              sitio web no le envía nada). Recibe el error, el modelo del teléfono, la versión de
              Android y de la app, y los pasos previos dentro de la app. Antes de que el reporte
              salga del teléfono le quitamos correos, números de DNI y de teléfono, códigos de
              credencial y tokens de sesión; no se envían capturas de pantalla ni tu cuenta de
              usuario.
            </li>
            <li>
              <strong>Expo</strong> (650 Industries) — Estados Unidos. Entrega las notificaciones de
              la app y sus actualizaciones. Recibe el identificador de notificaciones de tu teléfono
              y el texto del aviso, que no nombra a personas ni a mascotas, más un enlace interno de
              la app. Para actualizarse, la app le consulta a Expo si hay una versión nueva.
            </li>
            <li>
              <strong>Google Firebase Cloud Messaging</strong> — Estados Unidos. Es el canal por el
              que Android recibe esas notificaciones: recibe el identificador que Firebase le asigna
              a tu teléfono y el mismo aviso.
            </li>
            {/* Account mail (confirmation, password recovery) is GoTrue's, and
                it goes out through Resend because the HOSTED Supabase project's
                Auth SMTP settings point at Resend — a dashboard setting, NOT
                `supabase/config.toml`, whose [auth.email.smtp] block is the
                commented-out local default. Verified by the orchestrator
                2026-09-24. The rest (MFA notice, denuncia follow-up, operator
                digest, exports) calls the `resend` SDK directly. */}
            <li>
              <strong>Resend</strong> — Estados Unidos. Envía los correos del servicio: los de tu
              cuenta (confirmación, recuperación de contraseña, avisos de seguridad), el seguimiento
              de denuncias y los resúmenes para funcionarios. Recibe la dirección de destino y el
              contenido del correo. También recibe los correos que nos escribís a nuestras casillas
              (como la de privacidad), con tu dirección y lo que escribiste, para hacérnoslos
              llegar: una copia se reenvía a la casilla de la persona que atiende tu consulta.
            </li>
            <li>
              <strong>OpenStreetMap Foundation</strong> — Reino Unido. Mapas y búsqueda de
              direcciones. Cuando un formulario te muestra un mapa, tu navegador descarga las
              imágenes del mapa directamente de OpenStreetMap, que ve tu dirección IP y la zona que
              mirás. Cuando buscás una dirección o marcás un punto, nuestro servidor le consulta ese
              texto o esas coordenadas, sin tu IP ni tu identidad.
            </li>
            <li>
              <strong>El servicio de notificaciones de tu navegador</strong> — Google, Mozilla o
              Apple, según el navegador que uses; las tres son empresas de Estados Unidos. Solo si
              activás las notificaciones del sitio web: el aviso viaja cifrado y ese servicio no
              puede leer su contenido.
            </li>
          </ul>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            <strong>Transferencia internacional.</strong> Brasil y Estados Unidos no figuran entre
            los países que la Agencia de Acceso a la Información Pública considera con un nivel de
            protección adecuado (Disposición AAIP 60/2016). Por eso pedimos tu consentimiento
            expreso para enviar tus datos a estos proveedores (art. 12 de la Ley 25.326): lo das al
            crear tu cuenta, cuando aceptás esta versión de la política. Si usás miMAR sin cuenta
            —por ejemplo, para escanear un código QR o hacer una denuncia anónima—, lo que envíes
            también pasa por estos proveedores. En todos los casos podés ejercer tus derechos ante
            miMAR, como se explica a continuación.
          </p>
          {/* PO-DECISION: the express consent above exists ONLY for accounts
              whose signup sentence named the transfer (profiles.tos_version >=
              2026-09-24). Three groups have NO art. 12 consent on record and the
              page must not pretend otherwise: (1) accounts created before
              2026-09-24 (tos_version 2026-07-23 or NULL); (2) institutional
              accounts an admin creates (create-institutional-account.ts), which
              never see a consent sentence; (3) people using miMAR without an
              account (QR scans, anonymous denuncias, sightings), whose data still
              reaches Vercel, Supabase and OpenStreetMap. Options: (a) a
              re-consent step at next login for (1) and (2) — a screen and a
              write that do not exist yet; (b) a different legal basis for some
              or all of the flows (e.g. art. 12.2 exceptions, or processors bound
              by a contract with adequate safeguards — none is on file in this
              repo); (c) both. Until the PO decides, the public text names the
              consent only for new accounts and promises no flow. */}
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

          WHY LEGAL_VERSION WAS NOT BUMPED FOR THIS SECTION (the providers
          section above WAS a bump, 2026-09-24 — its comment says why the two
          differ). It records WHAT a user consented to,
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
