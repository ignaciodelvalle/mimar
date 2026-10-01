import { LEGAL_VERSION, LEGAL_VERSION_LABEL } from "@/lib/reference/legal-version";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Términos de uso — miMAR",
  description: "Condiciones de uso del servicio miMAR — Mi Mascota Argentina.",
};

export default function TerminosPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-10">
        <header className="space-y-2">
          <h1
            className="text-4xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Términos de uso
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            Última actualización: {LEGAL_VERSION_LABEL}{" "}
            <span className="text-[var(--color-ln-mute)]">(v{LEGAL_VERSION})</span>
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Descripción del servicio
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR (Mi Mascota Argentina) es una plataforma digital que permite a dueños de mascotas
            gestionar la credencial sanitaria de sus animales, reportar pérdidas, denunciar maltrato
            y conectar con refugios. El uso del servicio implica la aceptación de estos términos.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Registro y uso de la cuenta
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Podés registrarte gratuitamente como dueño, veterinario, refugio o representante de un
            organismo público. Sos responsable de la veracidad de los datos que ingresás y de
            mantener la confidencialidad de tu contraseña. Las cuentas institucionales (gobierno,
            veterinarios, refugios) son habilitadas por miMAR previa verificación.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Registro de mascotas y credencial pública
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Al registrar una mascota generás una credencial con QR de acceso público. Sos
            responsable de que los datos ingresados sean correctos. Podés controlar qué información
            aparece en el perfil público desde la configuración de cada mascota.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Denuncias de maltrato animal
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Las denuncias se envían a la autoridad sanitaria jurisdiccional competente. miMAR actúa
            como intermediario técnico; no investiga los hechos ni tiene facultades sancionatorias.
            Las denuncias falsas o maliciosas pueden comprometer recursos de las autoridades. La
            plataforma opera en el marco de la <strong>Ley 14.346</strong> (penalización del
            maltrato animal).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">Responsabilidad</h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            miMAR pone a disposición la infraestructura técnica pero no garantiza la resolución de
            ningún caso (pérdida, denuncia, adopción). La plataforma puede tener interrupciones de
            servicio. En ningún caso seremos responsables por daños indirectos derivados del uso o
            imposibilidad de uso del servicio.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Modificaciones y contacto
          </h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            Podemos actualizar estos términos. Los cambios relevantes se notificarán por correo a
            los usuarios registrados. Para consultas, escribinos a{" "}
            <a
              href={mailtoHref(CONTACT_EMAILS.general)}
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)] transition-colors"
            >
              {CONTACT_EMAILS.general}
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
