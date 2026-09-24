// /cuenta/transitos hub was folded into /cuenta's "Rol y organizaciones"
// group (owner-ia-redesign P1 item 5). The child routes (propuestas, activos,
// historial, ofrecerme-como-transito) survive; this thin redirect keeps old
// bookmarks and deep links from 404ing — same treatment /cuenta/editar and
// /cuenta/casos received.
import { redirect } from "next/navigation";

export default function TransitosHubRedirect() {
  redirect("/cuenta");
}
