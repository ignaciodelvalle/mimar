// Standalone /cuenta/editar page removed (owner-ia-redesign P1 item 5) — the
// same EditProfileForm already mounts as a sheet on /cuenta via
// CuentaSheetMounter's `?sheet=editar-perfil` (verified: CuentaSheetMounter.tsx
// handles that sheet id). This route now just forwards deep links/bookmarks.
// EditProfileForm.tsx itself is untouched — CuentaSheetMounter still imports
// it from this folder.

import { redirect } from "next/navigation";

export default function EditarCuentaPage() {
  redirect("/cuenta?sheet=editar-perfil");
}
