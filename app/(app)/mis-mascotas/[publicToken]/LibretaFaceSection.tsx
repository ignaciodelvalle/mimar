// The Libreta face (Face 2) of the owner pet profile, streamed by page.tsx
// inside its own <Suspense>. Lives in its own file because a page module may
// export nothing but the page, and the degraded branch below is rendered by a
// test (__tests__/degraded-hot-paths.test.tsx).

import {
  LibretaFace,
  type LibretaFaceEmergencyContacts,
} from "@/components/pet-profile/LibretaFace";
import { TabErrorState } from "@/components/pet-profile/PetDetailTabsPanel";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import type { PetAccessSuccess } from "@/lib/infra/pet-access";
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";

// ---------------------------------------------------------------------------
// Libreta face (Face 2) — server-rendered (perf audit 2026-07-19, PF3)
// ---------------------------------------------------------------------------
//
// Wrapped in its own <Suspense> below (see `documentNode`) so it streams
// independently of the eager, SSR'd Face 1 (CredentialFace never waits on
// this). Calls the tab-data use-case DIRECTLY with the access this page
// already resolved via requirePetAccess — no re-auth, and no client-trusted
// token crosses the wire. This replaces the old client mount-effect in
// PetDetailTabsPanel that called the `getLibretaFaceData` SERVER ACTION on
// every profile load: that action re-ran requirePetAccess's full auth +
// pet-access chain (a second getUser() + ownership query) for data the page
// had already authorized in the SAME request — wasted backend work on every
// view, not critical-path latency (the credential card paints without
// waiting for this).
export async function LibretaFaceSection({
  user,
  pet,
  accessPath,
  organization,
  holderRole,
  isOwner,
  emergencyContacts,
}: {
  user: PetAccessSuccess["user"];
  pet: PetAccessSuccess["pet"];
  accessPath: PetAccessSuccess["accessPath"];
  organization: PetAccessSuccess["organization"];
  holderRole: PetAccessSuccess["holderRole"];
  isOwner: boolean;
  emergencyContacts: LibretaFaceEmergencyContacts | null;
}) {
  // Bounded (2026-10): this section streams inside its own <Suspense>, so an
  // unbounded read here is a libreta skeleton that never resolves. On a
  // timeout or a rejection the face says so instead; Face 1 is unaffected.
  const load = await loadWithTimeout(
    getLibretaFaceData({ user, pet, accessPath, organization, holderRole }),
  );
  if (!load.ok) {
    return (
      <TabErrorState
        message={
          load.reason === "timeout"
            ? "La libreta está tardando más de lo normal. Recargá la página en unos segundos."
            : "No pudimos cargar la libreta. Recargá la página para reintentar."
        }
      />
    );
  }
  const result = load.value;
  if (!result.ok) return <TabErrorState message={result.error} />;
  return (
    <div className="op-fade-in">
      <LibretaFace
        data={result.data}
        petPublicToken={pet.publicToken}
        isOwner={isOwner}
        emergencyContacts={emergencyContacts}
      />
    </div>
  );
}
