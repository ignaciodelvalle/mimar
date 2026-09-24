// Standalone /cuenta/casos page removed (owner-ia-redesign P1 item 5).
//
// P5: the real index+inbox has landed on /mis-mascotas — open workflows AND the
// closed-cases history (fetchPreviousWorkflows) that this page used to render
// now live in the "Bandeja" section there. A direct URL fragment works fine
// here (no server branching needed, unlike /inicio's redirect), so this points
// straight at that section.

import { redirect } from "next/navigation";

export default function CasosPage() {
  redirect("/mis-mascotas#inbox");
}
