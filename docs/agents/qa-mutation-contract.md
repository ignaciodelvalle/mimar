# Contract: QA / data agents that WRITE to the local DB

Eight rules. Each exists because its violation caused a real incident
(2026-07-02/04: 5 direct-insert death events bypassed the death use-case and
left pets alive-and-dead for two days; untagged rows cost hours of forensics).

1. **Domain facts enter through flows, never raw INSERTs.** Use the UI, a
   server action, or an event-emitting script. If you believe a raw INSERT is
   unavoidable, STOP and hand the need to the main agent instead.
2. **If you insert events anyway, you own the projection.** Invariant #3:
   every table is a projection of events. `pnpm vitest run
   __tests__/pet-cache-rederivation.test.ts` must be green after your work.
3. **Tag everything you create**: `payload.source = "<your-run-id>"` on events,
   recognizable tokens/names elsewhere. Untagged residue is treated as
   corruption and deleted.
4. **Never touch the curated demo set**: owner@dim.test's pets
   (DIM-9HAK-D5Z4, DIM-4SUZ-U2HT, DIM-VT3V-SEA3, DIM-DEMO-0001), the demo-beat
   tokens in the active handoff, or `Refugio Esperanza Animal` /
   `Clínica Veterinaria Recoleta` fixtures. Create your own subjects.
5. **Local only.** Refuse to run against any non-127.0.0.1 DATABASE_URL.
6. **UTF-8 or nothing.** Configure your editor/writer before touching files;
   the encoding fitness test will fail your PR otherwise.
7. **One writer per handoff file.** If the file already has fresh content from
   another session, append an `## Addendum — <who> <when>` section; never
   rewrite others' findings.
8. **Report with branch + short SHA + the commands you ran** (see
   `dim-interno:docs/design/handoffs/README.md`). Claims without reproduction commands
   are discarded.

Whatever you write to disk — reports, findings, fixtures — follows
`docs/agents/public-private-boundary.md`: QA findings and run reports are
review results and belong in `dim-interno`, never in this public tree
(`pnpm lint:public-boundary` enforces it).
