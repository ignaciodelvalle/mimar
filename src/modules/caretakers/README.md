# `caretakers` — cuidador temporal

A titular hands someone they trust a **bounded, scoped grant** over one of their
pets: medical events, notes, photos and lost/found for a fixed period. Not a
transfer. Not co-ownership. The titular loses nothing and can end it at any
moment without asking.

Vocabulary is closed (PO 2026-08-19): **"cuidador temporal"**, never "custodia
temporal" — that label already belongs to an organisation's `shelter_custody`
role, and two arrangements sharing one word on one screen is how a vocabulary
rots.

---

## Layout

```
domain/          pure rules: validateDesignation, the (status, action) table,
                 the copy that carries a promise. No DB, no Next, no clock.
application/     use-cases against a declared PORT (ports.ts) + read models.
infrastructure/  caretakers-repository.ts — the only file that knows Drizzle.
actions.ts       "use server" controllers: guard → parse → use-case → map.
```

Everything under `application/**` runs in the FAST `unit` vitest project,
because the port keeps Drizzle out of its import graph. Do not import `@/db`
there — one import moves ~70 tests into the serial `db` project.

---

## THE THREE RULES THAT ARE NOT STYLE

### 1. Nothing may import this module. The PAGE imports it.

The owner cockpit needs caretaker state, and `pets` must never import
`caretakers`. The tempting shortcut is a `pets` use-case that fetches it — that
import is precisely the edge that inverts the dependency fence.

The resolution: `app/(app)/mis-mascotas/[publicToken]/page.tsx` calls
`getCaretakerStateForPet` **directly**. `app/**` sits outside the module graph
(`scripts/check-dependency-direction.ts`), so no edge is created. This module
added **ZERO** entries to `ALLOWED_EDGES` and must keep it that way.

Same reasoning, same answer, for two things that look like they belong here and
do not:

- `requireTitularAccess` lives in `lib/infra/pet-access.ts`. Putting the guard
  in the module would force every writer in the app to import the module.
- `resolveLostPetAlertRecipients` and `notifyTitularOfCaretakerDeath` live in
  `lib/infra/`. Same argument; `origin-shelter-alert.ts` is the precedent and
  says so in its own header.

`NewNotification` and `UseCaseResult` are **mirrored** in
`application/types.ts`, not imported from a sibling module. That is the
documented convention in the `ALLOWED_EDGES` comment itself and what eight other
modules already do.

### 2. A repository method name MUST equal its port method name.

Measured, not stylistic — and this module is where it was found, because it is
the first one with a declared PORT between use-case and repository.

`scripts/check-titular-gate.ts` propagates "this function reaches a titular-only
effect" along call edges matched **by name**. The use-cases call
`repo.insertAcceptGrant(...)`, the port's name. While the concrete method was
called `insertAcceptGrantForToken`, the fence indexed the effect on a name
nothing in the tree called, the taint stopped dead at the repository, and **the
entire accept chain was invisible to the fence — which reported itself clean.**

Renaming the method to match the port restored the edge.
`__tests__/check-titular-gate.test.ts` pins it, so a future rename cannot
silently re-open the blind spot. Sibling modules get this right by accident:
they have no port to diverge from.

### 3. Titular-only is a DENY, enforced twice, and the UI is the second half.

The deny-list lives in `lib/domain/titular-only.ts` (one declaration, two
consumers: the CI fence and the SQL mirror in migration 0190/0191). A caretaker
may not transfer, publish for adoption, change jurisdiction, mint a libreta
share link, edit identity fields, or designate a sub-caretaker.

Two uncorrelated layers, on purpose:

- **App** — `requireTitularAccess` denies a Path-1 holder whose `holderRole` is
  `caretaker`.
- **RLS** — `public.has_titular_write_access()` (migration 0190) denies the same
  writes to a bearer token hitting PostgREST directly, which the app-layer guard
  cannot see at all.

And a third thing that is not a layer but matters as much: **the caretaker must
never SEE the control.** A permission wall discovered by pressing a button
teaches a person the product is broken, not that the boundary is deliberate. See
`deriveMasSheetItems` and `components/pet-profile/NotTitularNotice.tsx`.

---

## Things that will bite you

- **`profiles` has no email column.** Emails live in `auth.users`, unreachable
  by Drizzle. `findUserIdByEmail` / `findEmailByUserId` go through the admin API
  and swallow failures — an unresolvable email is a legitimate outcome (the
  invitee has no account yet), not an error the titular can act on.
- **The invitation has NO spine representation.** There is no
  `caretaker_proposed` event: a pending invite is workflow state, not a fact
  about the animal. `caretaker_designated` is emitted **at accept**, and the
  name means "the arrangement became active".
- **`caretaker_ended.outcome`, never `reason`.** `erase_subject_data`
  sentinel-redacts the key `reason` across every event type; naming it that
  would destroy the enum on erasure.
- **`expired` does not mean the animal came back.** It means access lapsed. Every
  piece of copy about the end of a period has to keep those apart — see
  `domain/grant-copy.ts`, whose tests pin the sentences verbatim.
- **Dates are Argentine days, not UTC instants.** A bare `<input type="date">`
  value parsed with `new Date()` is midnight UTC = 21:00 ART of the day BEFORE.
  Use `parseArDateStartOfDay` / `parseArDateEndOfDay`
  (`lib/utils/date-input-ar.ts`); a period ends at the LAST instant of its last
  Argentine day, because "hasta el 15/09" promises the whole 15th.
- **The 180-day cap is DOMAIN-only** (`MAX_GRANT_DURATION_DAYS`), deliberately
  not a SQL CHECK: a forward-only migration is an immutable commitment to a
  product number. The form's picker bound comes from `caretakerEndDateBounds`,
  the same helper the rule is boundary-tested against, so the widget can never
  offer a date the action refuses.
- **A caretaker cannot read cases** (v1 non-capability, design F2). Accepted, but
  it must be an explicit state — `components/casos/CaseNotForCaretaker.tsx` —
  never a 404 discovered by clicking.

---

## Open, not decided here

`pet_caretaker_grants` appears in NEITHER subject-rights RPC
(`export_subject_data`, `erase_subject_data`). It carries `caretaker_email` — a
third party's PII — and the titular's free-text `note`. What erasure means when
the subject is the CARETAKER rather than the grantor is a legal/PO call, and the
fix amends two SECURITY DEFINER functions. See AGENTS.md § Privacidad 6b.
