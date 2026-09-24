# Petition Prerequisites Pattern

## Concept

Every petition (a user-initiated request that produces an `approval_request` or a significant
side-effect) must validate its prerequisites before doing anything else. If a prerequisite is
missing, the writer returns a structured error with a CTA URL so the UI can guide the user to
fix the missing step and then resume the original action.

This avoids cryptic errors ("internal error") and avoids half-committed state (e.g., creating
an approval_request for a user whose identity hasn't been verified).

---

## Return type contract

Writers that can surface a missing prereq extend their `*FormState` type with two optional fields:

```ts
type PetitionFormState = {
  error: string | null;
  ok?: boolean;
  // Both set when a prereq is missing. The UI renders a CTA card instead of the
  // generic error paragraph.
  missingPrereq?: "dni";  // open enum — add values as new prereqs appear
  prereqUrl?: string;     // server-validated safe path (must start with /, no // or ://)
};
```

The UI pattern:

```tsx
if (state.missingPrereq === "dni" && state.prereqUrl) {
  return <PrereqBanner url={state.prereqUrl} label="Verificar DNI" />;
}
// ... normal form
```

---

## Writer flow

1. Load profile (single SELECT at the top of the writer).
2. Check each declared prereq in order. Return early with `{ error, missingPrereq, prereqUrl }`
   on the FIRST miss. Do not proceed to validation or DB writes.
3. Continue with normal business logic.

```ts
if (!profile.dniVerified) {
  return {
    error: "Necesitás verificar tu DNI antes de enviar esta solicitud.",
    missingPrereq: "dni",
    prereqUrl: "/cuenta/verificar-dni?next=/cuenta/upgrade",
  };
}
```

---

## Current prerequisites table

| Petition | Prereq | prereqUrl |
|---|---|---|
| `requestVetUpgradeForUser` | `profiles.dniVerified = true` | `/cuenta/verificar-dni?next=/cuenta/upgrade` |
| `createOrganizationForUser` | `profiles.dniVerified = true` | `/cuenta/verificar-dni?next=/cuenta/upgrade` |

---

## The `?next=` parameter

The `prereqUrl` always includes `?next=<return-path>` so the user lands back on the original
petition page after completing the prerequisite.

**Open-redirect prevention (MANDATORY in every wrapper that reads `?next=`):**

```ts
function sanitizeNext(raw: string | null): string {
  if (!raw) return "/cuenta";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return "/cuenta";
  if (trimmed.includes("//") || trimmed.includes("://")) return "/cuenta";
  return trimmed;
}
```

This validation must appear in BOTH the server action wrapper AND the page component that reads
`searchParams.next`.

---

## DNI verification placeholder

`/cuenta/verificar-dni` is a **placeholder** form where the user types their DNI manually.
This exists because the real Mi Argentina OAuth integration does not exist yet.

**TODO(mi-argentina)**: When the Mi Argentina integration lands:
- Replace `verifyDniForUser` body with the OAuth-verified assertion callback.
- The outer shape stays the same: `userId` in → `{ ok: true }` or `{ ok: false, error }` out.
- The page becomes the OAuth redirect landing, not a manual input form.
- The `method: "placeholder_form"` audit payload becomes `method: "mi_argentina_oauth"`.
- The seed's `syncDniVerified` helper can be replaced with a real `verifyDniForUser` call.

The `DniVerifyForm` component carries a `TODO(mi-argentina)` comment pointing to this doc.

---

## Adding a new prerequisite

1. Add the new prereq literal to the `missingPrereq` union type in the relevant `*FormState`.
2. Add the prereq check to the writer (after profile load, before business logic).
3. Create or extend the prerequisite completion page (e.g., `/cuenta/matricula-pendiente`).
4. Add a `sanitizeNext` guard in the new page's `searchParams` handler.
5. Add the new row to the prerequisites table above.
6. Add test cases: one for the writer returning `missingPrereq`, one for the happy path after
   the prereq is satisfied.

---

## Seed bypass

The seed (`scripts/seed-test-users.ts`) calls `syncDniVerified(userId)` after every
`ensureAuthUser(...)` instead of going through `verifyDniForUser`. This is intentional:

- The seed exercises real writers (approval flows, org creation, etc.) but the DNI verification
  is a placeholder. The bypass keeps the seed focused on the flows it was designed to exercise.
- `syncDniVerified` is idempotent and leaves `dni_number=NULL` (avoiding the partial unique index).
- Remove this bypass once the real Mi Argentina OAuth flow is available and the seed can
  exercise it end-to-end.
