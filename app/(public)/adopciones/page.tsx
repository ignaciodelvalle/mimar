// /adopciones — public alias for the natural-language URL (cursor citizen UX
// O3, verified 2026-07-24): the route never existed (the public surface is
// /adoptar; owner applications live under /mis-mascotas/postulaciones), but
// the word is guessable enough that a typed URL 404'd the citizen loop.
// Permanent redirect, params preserved.
import { permanentRedirect } from "next/navigation";

export default function AdopcionesAliasPage() {
  permanentRedirect("/adoptar");
}
