<!--
Outside pull requests are not accepted at this time (see CONTRIBUTING.md);
security reports go through SECURITY.md, never through a PR.

Short PR template — answer the five questions below. Delete the comments.
For details, see CONTRIBUTING.md.
-->

## What does this change, in one sentence?



## Which event types, cases, or tables does it touch?

<!-- If none, write "none". If you added or significantly changed an event type, name it AND confirm you walked through docs/event-design-checklist.md. -->

## New or modified RLS policies

<!-- List them or write "none". If a policy changed, paste the before/after. -->

## New tests, and what they cover

<!-- Pre-existing tests still green is a separate checkbox at the bottom. -->

## Linked spec under `docs/superpowers/`?

<!-- Path to the spec file, or "no spec — please push back if one is needed". -->

---

## Test plan

- [ ] `pnpm verify` green (typecheck, Biome, every `lint:*` fence, `next build`)
- [ ] `pnpm test:verified` green — paste the verdict line (`reported N file(s); N discovered; 0 failing test(s); 0 broken file(s)`), not `pnpm test`
- [ ] `pnpm test:e2e:smoke` if this touches public or lost-mode surfaces
- [ ] Manual smoke for affected user-facing flows

## Public repository

- [ ] Nothing internal added: no review results, handoffs, plans, pilot/outreach material or deploy/incident runbooks (`docs/agents/public-private-boundary.md`; `pnpm lint:public-boundary` checks it)
- [ ] No personal data, real credentials or `.env` values — and if a secret was ever committed, it has been ROTATED (removing the file does not remove it from history)
- [ ] Commits are Conventional Commits in Spanish, with no AI attribution
