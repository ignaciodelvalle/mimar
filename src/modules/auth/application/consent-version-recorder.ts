// Where signup step 1 leaves the legal version it displayed, for step 2 to stamp.
//
// app_metadata, NOT user_metadata (review of 2cac7c2ff, 2026-09-24). The first
// cut put `tos_version` in user_metadata through `signUp({ options: { data } })`.
// user_metadata is writable by the user themself (`auth.updateUser({ data })`),
// so between step 1 and step 2 anybody could switch the value between the two
// KNOWN versions — i.e. forge having accepted the transfer clause. app_metadata
// is writable only with the service-role key, which is what this uses, so the
// value step 2 reads (`raw_app_meta_data->>'tos_version'` in
// complete-identity-for-user.ts) is one only the server could have put there.
//
// GoTrue MERGES app_metadata keys on an admin update, so this adds
// `tos_version` beside `provider`/`providers` without replacing them.
//
// Called by the signup use-case through an injected dep, by BOTH adapters (the
// web action and `POST /api/v1/auth/signup`). A failure here must never be
// turned into an over-claim: step 2 finds no value and records the PREVIOUS
// version. The use-case reports it and lets the signup succeed.

import type { LegalVersion } from "@/lib/reference/legal-version";
import { createAdminClient } from "@/lib/supabase/admin";

export async function recordConsentVersionWithAdmin(
  userId: string,
  version: LegalVersion,
): Promise<void> {
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: { tos_version: version },
  });
  if (error) throw error;
}
