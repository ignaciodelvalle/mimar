// Where a successful caretaker designation lands. A plain module so the client
// form and the route agree on one string.
//
// WHY A ROUTE (2026-10-06). DesignateCaretakerForm used to set `sentTo` and draw
// "Invitación enviada" in place. designateCaretakerAction revalidates, and in
// Next 15.5 any revalidation inside a server action re-renders the CURRENT
// route in the same response. `/cuidado` branches on the grant the action just
// created — with a pending invitation it renders the withdraw controls instead
// of the form — so the form, its `sentTo` and the success screen were unmounted
// before they showed. The route below reads the pending invitation from the
// database instead.
export function caretakerInviteSentPath(publicToken: string): string {
  return `/mis-mascotas/${publicToken}/cuidado/invitacion-enviada`;
}
