// /admin/chapas — physical-tag batch issuance (physical-tag-lifecycle D9,
// minimal scope).
//
// Admin generates a lote of blank (unactivated) tags and downloads the ONE
// artifact that ever carries the plaintext activation codes: the issuance CSV
// (`serial,activation_code,url`) handed to the engraving provider. The DB
// stores only the peppered HMAC hash of each code.
//
// Authz: the /admin layout gates the segment (requireAdminOrRedirect) and the
// writer re-verifies the admin role inside its transaction.

import { IssueTagBatchForm } from "./IssueTagBatchForm";

export const dynamic = "force-dynamic";

export default function AdminChapasPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ln-op-ink">Chapas físicas</h1>
        <p className="mt-1 text-sm text-ln-op-mute">
          Emisión de lotes de chapas sin activar. El CSV con los códigos de activación se genera una
          única vez: guardalo en el circuito del proveedor — el sistema no puede volver a
          mostrarlos.
        </p>
      </div>
      <IssueTagBatchForm />
    </div>
  );
}
