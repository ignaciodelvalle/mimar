# DIM — Org portal permissions

> **Last updated: 2026-06-24.** Corrected to match the live implementation.
> Previous version described 37 fine-grained capabilities and a `lib/org-permissions.ts` module
> that do not exist. The real system uses 16 coarse capabilities and `authz-resolver.requireCapability`.

Single source of truth for what a user can do inside an organization based on their membership role and capability grants.

## Capability catalogue

Capabilities are the verbs used by the authorization system. There are **16 coarse capabilities** defined in `ORGANIZATION_CAPABILITIES` in `db/schema.ts`:

```ts
export const ORGANIZATION_CAPABILITIES = [
  "pet.read_held",
  "intake.create",
  "foster.assign",
  "foster.end",
  "adoption.review",
  "adoption.finalize",
  "custody.transfer",
  "event.write",
  "member.invite",
  "capability.grant",
  "service_offering.create",
  "appointment.manage",
  "bite.report",
  "adoption.listing.manage",
  "org.transfer.propose",
  "org.transfer.accept",
] as const;
```

> **Note:** There is no `lib/org-permissions.ts`. Permission resolution lives in
> `src/modules/organizations/infrastructure/authz-resolver.ts` and the pure domain layer
> `src/modules/organizations/domain/capabilities.ts`.

## Grant model

Authorization is **grant-based**: capabilities are approved grants stored in `organization_capability_grants`. Some roles receive implicit grants (no DB row needed):

- `admin` — implicit grant of ALL capabilities universally.
- `coordinator` — implicit grant of a coordinator baseline set (`COORDINATOR_IMPLICIT_CAPS` in `domain/capabilities.ts`).
- `vet_individual` — implicit `VET_INDIVIDUAL_BASELINE_CAPS` (`appointment.manage`) always; `VET_CREDENTIAL_CAPS` (`pet.read_held`, `event.write`, `intake.create`, `bite.report`) only while the member's own matrícula is verified. Clinical capabilities are never granted to a `vet_individual` — approved rows for them are ignored while the matrícula is not valid, and none of the five writers (grant, request, event-write toggle, invite acceptance, and approving an old pending request) creates or approves one. Other approved grants apply as usual.
  - **Accepted privacy tradeoff.** Because `appointment.manage` is baseline, an invited vet whose matrícula is not yet verified can open the agenda (`app/org/[orgToken]/agenda/page.tsx`), which shows each booking owner's first name and phone. That is the same exposure a receptionist holding `appointment.manage` already has, bounded to the member's own organization and to an authenticated, active membership; no clinical data is reachable without the verified matrícula. Recorded in the AGENTS.md privacy checklist (§6e).
- `member`, `volunteer`, `foster` — only explicit `status='approved'` grants from `organization_capability_grants`.

## API

```ts
// src/modules/organizations/infrastructure/authz-resolver.ts

export async function requireCapability(
  capability: OrganizationCapability,
  organizationId?: string,
): Promise<RequireCapabilityResult>;
// Returns { user, membership, organization, granted, error: null } on success
// Returns { ..., error: string } on failure — caller must check error before using the result.
// Does NOT throw. Caller decides how to handle errors (typically: redirect or return early).
```

Server actions call it like:

```ts
const auth = await requireCapability("adoption.finalize");
if (auth.error) return { error: auth.error };
// ... proceed with auth.organization, auth.membership
```

The resolution order (per module JSDoc):
1. Supabase session → no user → "Sesión expirada."
2. `getActiveMemberships(userId)` ordered by `joinedAt ASC`
3. `organizationId` provided → find matching membership; omitted → take `memberships[length-1]`
4. No matching/active membership → "No pertenecés a ninguna organización activa."
5. `getGrantedCapabilities(membership)` → delegates to `domain/capabilities.resolveGrantedCaps` + DB
6. Granted set lacks capability → "No tenés permiso para esta acción. Pedile el alta a un administrador."
7. Success → `RequireCapabilitySuccess`

## Membership roles

From `organization_membership_role` enum in `db/schema.ts`:

- `admin` — full control. Implicit all-capabilities.
- `coordinator` — operational lead. Coordinator implicit baseline + explicit grants.
- `member` — generic staff. Explicit grants only.
- `volunteer` — field volunteer. Explicit grants only.
- `foster` — temporary caregiver. Explicit grants only; foster scope is per-pet via the active `Ownership(role=foster)` row.
- `vet_individual` — individual vet working under org banner. Vet implicit baseline + explicit grants.

## Routes

The org portal lives at `/org/[orgToken]/*` (not `/refugio/[orgToken]`).

## Tests

Permission resolution is tested in `__tests__/org-permissions.test.ts` (or equivalent under `src/modules/organizations/`).
