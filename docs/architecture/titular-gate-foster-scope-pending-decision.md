# `isTitularHolder` admits a foster — pending PO decision

> Status: PENDING PO DECISION as of 2026-09
> Raised: 2026-09-23, from the security review of the Tanda 4 tail (T4-I1 / issue #753)
> **No engineering action until decided.** The change is one line; its blast radius is not.

## The observation

`isTitularHolder` (`lib/infra/pet-access.ts`) is a DENY of exactly one role:

```ts
export function isTitularHolder(
  accessPath: PetAccessPath | null,
  holderRole: OwnershipRole | string | null,
): boolean {
  return !(accessPath === "owner" && holderRole === "caretaker");
}
```

A person-path **foster** therefore passes every titular-only gate, including the
new PPP attestation gate — and the justification written for that gate covers a
foster identically. The registries inscribe the **propietario**: Ley CABA 4078 +
Res. 93/APRA/2021 has the owner file at APrA with the RC policy and their own
course; Ley PBA 14.107 has the owner file at a Delegación Municipal. A person
holding an animal in tránsito is not the propietario, and an attestation they
file asserts a legal fact about someone else exactly as a caretaker's would.

So on the merits of #753 alone, a foster should be denied too.

## Why it was not changed with #753

`isTitularHolder` is the single predicate behind **every** titular-only effect —
`requireTitularAccess` calls it, and the bearer surfaces mirror it. Adding
`foster` to the deny moves all of them at once:

| Effect | What a foster loses |
|---|---|
| transfer-initiation | (already denied by `findActiveOwnerOwnership`, role-filtered) |
| adoption-eligibility-publishing | publishing / withdrawing a listing |
| jurisdiction-change | recording a move |
| caretaker-sub-designation | naming a caretaker |
| tier2-public-toggle | opening the public credential window |
| libreta-share-minting | issuing a libreta link |
| identity-field-edits | name, species, breed, date of birth |
| ppp-attestation | the PPP attestation (the one this note is about) |

The header of the predicate already states the current position out loud —
"`foster` passes. Today's behaviour, byte for byte." — so this is a decision
that was taken once, deliberately, and is being reopened by a new effect
joining the list rather than by anything about fosters changing.

Two of those rows look wrong for a foster on the same reasoning as PPP
(identity edits, jurisdiction change); at least two look right (a foster running
a `buscar-hogar` listing is the product's own design, and `canSeeFindHome` gates
a foster row IN on purpose). That split is what makes this a product decision:
the predicate is one lever and the effects want different answers.

## The three options

1. **Leave it.** A foster keeps every titular-only effect including the PPP
   attestation. Cheapest, and wrong on #753's own argument.
2. **Add `foster` to the deny.** One line, and it changes eight behaviours at
   once. Needs a pass over each row and over `canSeeFindHome`, which would
   otherwise offer a foster a control the write then refuses.
3. **Split the predicate per effect** — `isTitularHolder` stays the general
   gate, and titular-only effects that are specifically about LEGAL TITULARIDAD
   (PPP attestation, identity, jurisdiction) get a narrower one. Most faithful,
   most work, and it turns one lever into two that can drift.

## Recommendation

Option 3 for correctness, option 1 until the PO says otherwise. The exposure
while it waits is bounded and worth stating plainly: a foster filing a PPP
attestation is a person the system deliberately gave broad custody to, writing a
record that is visible, attributed to them, and (since #753) only counts toward
compliance if it cites the registry's own inscription number — which a foster
filing a false one would have to invent, and an authority can check.

## Where the decision lands

- `lib/infra/pet-access.ts` — `isTitularHolder`, and the docblock above it that
  states the current position.
- `lib/domain/titular-only.ts` — `TITULAR_ONLY_DENY_LIST`, whose rows are the
  per-effect argument option 3 would need.
- `apps/mobile/src/pets/owner-face-view-model.ts` — `ownerFaceGates`, so a
  denied foster is not offered the control.
