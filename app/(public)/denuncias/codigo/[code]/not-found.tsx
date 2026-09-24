import { BrandedNotFound } from "@/components/BrandedNotFound";

// Not-found for an unknown denuncia reference code.
//
// WHY THIS FILE EXISTS. `notFound()` here used to fall through to the (public)
// group's shared not-found, which answers "No encontramos esa credencial" and
// offers "Ver mascotas perdidas" — a page about pets. Someone who typed a
// DEN-XXXX-XXXX code is looking for the cruelty report they filed, often the
// only handle they have on it, and the app replied by talking about something
// else entirely. Not a trap (the links work) but a disorienting one at a moment
// where the person is already unsure whether their report exists at all.
//
// Next resolves the NEAREST not-found, so co-locating this one scopes the copy
// without touching the shared fallback every other public route relies on.
//
// It deliberately does NOT confirm or deny that any given code exists — the
// whole reporter-access design refuses to be an existence oracle
// (see actions.ts). This screen is reached only when the code does not resolve,
// and it says the neutral thing: check the code, or go ask with it in hand.
export default function DenunciaCodigoNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos ese código"
      body="Revisá que esté completo y bien tipeado — tiene la forma DEN-XXXX-XXXX. Si lo copiaste de una constancia y aun así no aparece, presentalo ante el organismo que recibió la denuncia: con ese número pueden informarte el estado."
      primary={{ href: "/denuncias/buscar", label: "Probar con otro código" }}
      secondary={{ href: "/denuncias", label: "Volver a Denuncias" }}
    />
  );
}
