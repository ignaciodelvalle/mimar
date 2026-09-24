# Agent contracts — who are you, and which page governs you

One page per role, ≤10 rules each, every rule verifiable. Long prose does not
get followed (audited 2026-07-04: every contract violation that week traced to
either a missing role contract or a rule buried in a long document; the two
short role docs in this repo were followed on first use).

> Rows whose contract reads `dim-interno:docs/…` point at the private companion
> repository **dim-interno** (mostly the same relative paths — see `docs/README.md`): prompts, handoffs, boards and
> recommendations moved there on 2026-09-18. The standing contracts stay here.

| You are… | Your contract |
|---|---|
| The main coding agent (Claude Code session) | `/CLAUDE.md` (repo root) |
| A read-only auditor / critique agent | `dim-interno:docs/design/handoffs/README.md` |
| A QA or data agent that MUTATES the local DB | `docs/agents/qa-mutation-contract.md` |
| A subagent spawned by the main agent | `docs/agents/subagent-card.md` |
| A collaborating agent joining to WRITE code | `docs/agents/collaborating-writer.md` — ten rules, then a reading order and a first task. The board it points at (milestones, open work, declared debts, what is PO-gated) is `dim-interno:docs/agents/open-work.md` |
| A human newcomer | `/README.md` → `AGENTS.md` slim index |
| Anyone (human or agent) writing a file to this repo | `docs/agents/public-private-boundary.md` — what is public, what goes to `dim-interno`, and how `pnpm lint:public-boundary` enforces it. Every contract below that writes files cites it |
| Cowork, haciendo el clickthrough de staging | `dim-interno:docs/agents/prompt-cowork-clickthrough-staging.md` (+ el guion `master-test-ciudadano-multiagente.md`) |
| Cowork, recorriendo lo que nunca se recorrió | `dim-interno:docs/agents/prompt-cowork-clickthrough-territorio-nuevo.md` — el complemento del anterior: las 115 rutas que ningún guion ni spec nombró nunca |
| Cowork, verificando arreglos + explorando | `dim-interno:docs/agents/prompt-cowork-clickthrough-verificacion-y-nuevo.md` — A verifica con el resultado esperado escrito, B explora lo no recorrido, C pregunta si el servidor rechaza lo que la UI esconde, D toma seis tiempos. Lleva las tres reglas de método que salieron de los 5 falsos positivos de TN0813, y una segunda vuelta de la parte A a las dos semanas |
| Un revisor externo auditando el código | `dim-interno:docs/agents/prompt-cowork-review-codigo.md` |
| The PO, running the adversarial review of the 2026-08-29→30 range | `dim-interno:docs/agents/handoff-2026-08-30.md` — the attack map: where to aim first, what changed per area with hashes, the decisions to ratify or revert, what was left undone, and the one-run validation recipe with its measured traps |
| The PO or a maintainer, deciding what to change about how this repo is worked | `dim-interno:docs/agents/recommendations-2026-08-30.md` — what the same session revealed about the repo itself, each claim with the measurement that produced it: the fences that exit 0 without measuring, the floors that loosen in silence, the two red signatures beyond the documented three, and the defect class that lives in the stub rather than the assertion |
| La sesión que ejecuta el loop **"Rumbo al piloto"** (el modelo que implementa el plan de 2026-09-18) | `dim-interno:docs/agents/prompt-loop-rumbo-al-piloto.md` — el prompt de arranque, para pegar tal cual empezando por `/loop`. El contrato es `dim-interno:docs/handoff/rumbo-al-piloto.md`: decisiones ya tomadas con su default, las ocho compuertas de "listo de nuestro lado", las cinco tandas con archivo y criterio de terminado por ítem, el protocolo de iteración y qué es del PO. La página para el PO es un espejo, no el contrato |
| Quien tome la unidad de trabajo de **notificaciones push** | `dim-interno:docs/agents/prompt-loop-push-notifications.md` — el prompt de arranque, para pegar tal cual en una sesión nueva. El contrato en sí es `dim-interno:docs/handoff/push-notifications.md`: 497 líneas con las once decisiones ya cerradas, cero abiertas. El prompt existe porque el handoff venció en dos puntos el 2026-09-11 — la build que su sección 3.9 nombraba se cortó sin push — y porque alguien de afuera necesita que le digan qué leer primero y dónde para |
| Un agente escribiendo material de onboarding para usuarios externos (funcionario, vet, refugio, dueño, vecino) | `dim-interno:docs/agents/prompt-cowork-onboarding-externos.md` |
| El PO o cualquiera que vaya a LEVANTAR el stack local y recorrer la app | `dim-interno:docs/agents/walkthrough-findings-2026-08-31.md` — seis hallazgos que sólo aparecen corriendo la cosa (el CSP que deja la web local sin hidratar, la denuncia móvil que llega siempre "sin verificar", ocho rutas nativas sin título, el cierre de denuncias sin motivo en la semilla, el build de Android que ponía `pnpm verify` en rojo permanente, y que `pnpm seed:demo` deja la base en un estado que `pnpm verify` rechaza), más la receta del emulador y las cuentas de cada rol |

`AGENTS.md` is the knowledge base (data model, event catalog, legal framework)
— load its anchored sections on demand. It is context, not a contract.

## The recipe every agent brief starts with

**Poll every background child within your own turn.** After launching any
background child, poll its output within the same turn: loop on `Read` of its
output file, or re-run it synchronously. A turn may not end with a live child
unpolled. This is a STRUCTURAL rule, not a reminder — it recurred 3× in one day
despite prompt warnings, so it leads every brief as a positive recipe rather
than a buried "don't".

**Verify worktree freshness before touching anything.** Worktree provisioning
can hand an agent a copy that is many commits behind the integration tip it
was told to work from — `git log --oneline -1` on the target integration
branch, compare against the worktree's own `HEAD`, and `git reset --hard` to
the tip if they diverge, before making a single edit. This is not
hypothetical: an agent briefed against "expect SHA `bab941de` or newer" found
its worktree 2,009 commits behind (`git rev-list --left-right --count
HEAD...integration/all-20260703` → `0  2009`) despite a clean `git status`. A
clean tree proves nothing about freshness — only a direct comparison against
the named tip does.

## Working-norm methodology (validated 2026-07-11)

- **A fresh-context reviewer is a standard pre-push step.** Before pushing a
  commit range, run a read-only adversarial pass over the range with a reviewer
  that did NOT write the code. Independent judgment on the diff, not token
  saving — it catches what the writer's context normalized away.
  - **Instrument (PO decision 2026-08-08):** a read-only subagent, spawned per
    commit range. This replaces cursor-agent, which the project no longer has.
    Point it at the range and at the specific claims the writer is least able to
    audit — its own new tests and fences.
  - `/code-review ultra` stays available for a deeper pass, but it is billed and
    only Ignacio can launch it, so it is a pre-deploy step and not this one.
  - The gate is not a substitute. `pnpm verify` + the suite prove the code does
    what its author believed; they cannot tell you the author's belief was
    wrong. Three of the fences in this repo were written and validated by the
    same agent in the same session — exactly the case this step exists for.
- **Parallel-writer model.** N read-only agents in parallel is free and
  encouraged. A SECOND writer runs ONLY in its own git worktree with disjoint
  file territory + its own targeted tests (local Supabase is shared, so schema/
  data writes must not collide), and lands through a serial integration merge
  gate: full `pnpm verify` + parity checks where applicable. No parallel writers
  in the same tree.
- **Spec-conflict rule: validated code beats design-handoff tables.** When a
  tested constant disagrees with a design handoff's token table, the code wins.
  Case study: the v2C README's divergent teal `#0d9488` was already replaced in
  `packages/contract/src/viz/viz-scales.ts` (`@dim/contract/viz`) by `#0c866b` (`COLOR_DIVERGENT_ABOVE`) over a
  ΔE deuteranopia-margin violation — building from the table would have silently
  reintroduced a fixed CVD accessibility bug. Treat `viz-scales.ts` (and other
  test-pinned constants) as the source of truth; flag the handoff, don't follow it.
- **Audit date filters are ARGENTINE calendar days, not UTC (PO 2026-07-16).**
  `lib/ui/audit-filters.ts` and `/gob/historial` anchor a `YYYY-MM-DD` filter
  at AR midnight (fixed `-03:00`, no DST): "2026-07-18" spans 03:00Z–03:00Z.
  This is intentional — do not "fix" the boundaries back to UTC midnights.
- **No self-referential assertions.** A test must assert `f(x)` against an
  independently-stated expected value, never against a value derived from the
  same code path under test — e.g. re-deriving the expected string from the
  same template the production code uses to build it, so a broken template and
  a "passing" test agree with each other and nothing else. Found by a
  theater-audit sweep (suite came back under 0.5% theater overall, but this
  pattern was the recurring false-green shape). Applies to every new or edited
  test, not just tests written for this repo's own agents.

Machine-enforced rules (no memory required): `pnpm verify` lints,
`__tests__/cron-registry-parity.test.ts`, `__tests__/pet-cache-rederivation.test.ts`
(cache↔events drift), `__tests__/encoding-fitness.test.ts` (mojibake),
`.cursorignore` (stale-state reads). Prefer adding a check over adding a rule.
