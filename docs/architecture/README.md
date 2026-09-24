# `docs/architecture/` — index

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer D (sonnet subagent) · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

## Purpose

This directory is the living, code-linked engineering reference — Layer A of
the 2026-09 doc pack. English, identifiers verbatim, one claim per path (and
line where the claim is a specific guard). Its companion, Layer B, is
`dim-interno:docs/presentation/2026-09-oficiales/` — one spec per diagram Claude Cowork
draws for the municipal-official presentation. Layer A is where a diagram's
claims are checked; Layer B is what gets drawn. The map between the two is
in §3.

## The header contract

Every file in this directory (and the pack's numbered `NN-*.md` files) opens
with:

```
> Snapshot: `<sha>` (`main`) · Facts: `docs/architecture/facts.json` generated <date>
> Verified against code on <date> by <writer> · Status: draft
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.
```

`Status: draft` stays until a reviewer who did not write the file reads it
and flips it to `reviewed`. A file whose Status line still says `draft` has
been verified once, by its own author, not independently checked.

## How `facts.json` works

`docs/architecture/facts.json` is the single source every repo-count NUMBER
in this directory (and, once it exists, `dim-interno:docs/presentation/`) must cite
through — never as a bare literal. `pnpm facts:write` (`scripts/architecture-facts.ts`)
**regenerates** the file by recomputing every fact from the tree (file
counts, array lengths imported from source, canon JSON row counts) and
overwriting `facts.json`. `facts.json`'s own `sha` field is the commit at
which `pnpm facts:write` last ran, and it can legitimately TRAIL the
`Snapshot:` SHA in a doc header when the commits in between moved no fact —
that gap is not staleness by itself, only a fact whose generated value
disagrees with the marker in a doc is. `__tests__/architecture-facts.test.ts` **checks,
never rewrites**: it re-runs the same generator in-process and asserts the
result equals the committed `facts.json` exactly (no floor, no tolerance —
a silent upward drift is exactly the failure this fence exists to catch), and
separately asserts every marker (an opening `<!-- fact:key -->`, the value,
then the closing `/fact` comment — the fence does not skip code blocks, so
this README spells the pair apart on purpose) in the scanned docs states the
generated value for a key that actually exists. A
doc author never edits `facts.json` by hand and never invents a key: an
unknown key fails the fence, a stale value fails the fence, and a number
that has no key at all must stay prose ("a dozen") or cite the file holding
the constant without a literal.

The same fence also asserts every backticked repo path under
`docs/architecture/**` (and `dim-interno:docs/presentation/**`, once that root exists)
resolves on disk — with a small, individually-listed allowlist for paths a
doc cites ON PURPOSE as historical (a migration narrated, not a live path).

## File list

**Existing:**

| File | What it covers |
|---|---|
| `hexagonal-lite.md` | The four-layer module shape (`domain`/`application`/`infrastructure`/`actions.ts`), the dependency rule, the strangler migration status, and Pattern B (population-level aggregates in `lib/metrics/`). |
| `rls-coverage.md` | The two-layer authz contract (action edge primary, RLS as PostgREST backstop), the table-by-table inventory, and the backstop-gap assessment. |
| `api-invariants.md` | The `/api/v1` merge checklist: throttles, the response envelope, the error vocabulary, cache-control, per-section degradation, and the fences that check each line. |
| `privacy-known-limitations.md` | Privacy findings the PO reviewed and deliberately accepted instead of fixing, each with the attack, the reasoning, and the triggers that would reopen it. |
| `retention-policy-pending-decision.md` | The open legal decision on `retention_until` periods — which tables, what anchor events, what the decision must produce. |
| `client-error-sink-pending-decision.md` | The open PO decision on a web/mobile error-telemetry vendor — the engineering seam is done, the vendor choice is not. |
| `conventions-canon.md` (+ `conventions-canon.json`, generated) | Every convention this repo states about itself, classified ENFORCED / PARTIAL / UNENFORCED against a real enforcer. Generated — not edited by hand, not this pack's territory. |

**New (this doc pack):**

| File | What it covers |
|---|---|
| `system-context.md` | Deployment topology, the portal surfaces, and the runtime boundary. |
| `data-model.md` | The event spine, the dual-write caches and their drift detection, and the schema shape. |
| `authorization.md` | The `requireLiveUser` chain, roles × account types, org capabilities, jurisdiction scope, RLS as backstop. |
| `public-credential.md` | The public token lifecycle, disclosure tiers, the lost/found handshake, the throttle families. |
| `privacy-controls.md` | DNI hashing, k-anonymity, signed buckets, subject rights (Ley 25.326 art. 14/16). |
| `government-views.md` | `/gob` sections, narrow-only scope, the KPI contract and its presentation guards. |
| `mobile-contract.md` | The DATA plane (`/api/v1` + bearer) vs the AUTH plane (GoTrue direct), and `packages/contract` as the wire truth. |
| `quality-pipeline.md` | `pnpm verify`, `pnpm test:verified` vs `pnpm test`, CI workflows, deploy, and the doc fences (this file's own kind). |
| `integrations.md` | Every external system this codebase reaches, with an honest STATUS per one: live, export-only, stub, planned, or none. |

## Diagram → doc map

Layer B's twelve `NN-*.md` files each carry one reference Mermaid diagram for
the presentation. Each diagram's claims are checked against one or more
Layer A files:

| Diagram | Layer B file | Layer A file(s) |
|---|---|---|
| D1 — contexto-sistema | `01-contexto-sistema.md` | `system-context.md` + `integrations.md` |
| D2 — topología-portales | `02-topologia-portales.md` | `system-context.md` |
| D3 — ciclo-credencial | `03-ciclo-credencial.md` | `public-credential.md` |
| D4 — espina-eventos-y-caches | `04-espina-eventos-y-caches.md` | `data-model.md` |
| D5 — modelo-datos | `05-modelo-datos.md` | `data-model.md` |
| D6 — autorización | `06-autorizacion.md` | `authorization.md` |
| D7 — privacidad | `07-privacidad.md` | `privacy-controls.md` |
| D8 — crisis-perdida-y-denuncias | `08-crisis-perdida-y-denuncias.md` | `public-credential.md` + `government-views.md` |
| D9 — vistas-gobierno | `09-vistas-gobierno.md` | `government-views.md` |
| D10 — contrato-móvil-web | `10-contrato-movil-web.md` | `mobile-contract.md` |
| D11 — despliegue-runtime | `11-despliegue-runtime.md` | `system-context.md` |
| D12 — calidad-y-auditoría | `12-calidad-y-auditoria.md` | `quality-pipeline.md` |

Pack files that are not one diagram's spec live alongside the numbered ones
in `dim-interno:docs/presentation/2026-09-oficiales/`: `00-guion.md` (the presentation
script), `glosario.md` (identifier → es-AR label), `limites-honestos.md`
(the pack-wide "do not claim" list), `README.md` (the pack's own index), and
`assets/README.md`. Those five are written by other writers in this doc pack,
in parallel with this file.

## Related

- `AGENTS.md` — the deeper knowledge base (data model, event catalog, legal
  framework); this directory is architecture-focused and code-linked, not a
  restatement of `AGENTS.md`.
- `dim-interno:docs/reviews/README.md` — the audit-generation index; `dim-interno:docs/reviews/2026-09-fresh/`
  is the current one, and several files in this directory quote its findings
  rather than paraphrasing them softer.
