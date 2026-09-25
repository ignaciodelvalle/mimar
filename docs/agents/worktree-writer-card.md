# Card: a writer working in its own git worktree

For a subagent that WRITES code in parallel with the integrator. Read
`docs/agents/subagent-card.md` first — its six rules still apply. These are the
ones a worktree writer broke at least once; each costs a full gate when missed.
Your brief supplies three machine-specific values: your WORKTREE path, the
GATE FLAG file, and the NODE path to prepend.

1. **Your worktree only.** Every command is `git -C <WORKTREE>` or an absolute
   path. Never `cd` into the main checkout: the shell's cwd persists and one
   stray `pnpm` or `git commit` lands on the integrator's branch. Start from a
   clean tree on a fresh branch off `main`; if the tree is dirty, stop and
   report.
2. **The gate flag.** While the GATE FLAG file exists, a gate is running on the
   shared machine and database: read and edit only — no vitest, jest, tsc,
   pnpm, build or db command. Poll it within your turn; never end the turn
   waiting on it.
3. **Targeted tests, never the whole suite.** The local Supabase is shared.
   Name the files; never pass an empty file list (vitest then runs
   everything). Never `pnpm build`: it overwrites `.next` under the live
   server.
4. **Prepend the pinned Node** (from the brief) for every node/pnpm command.
   The shell's default Node is not the repo's, and a green run on the wrong
   one means nothing.
5. **Mirror the web; don't reinvent it.** An API or app feature that the web
   already has calls the SAME use case with the SAME authorization. Report the
   web guard's `file:line` next to yours. Anything the web does not have, or
   a rule the server does not enforce (only a UI hides it), is a finding —
   report it.
6. **The census follows the files.** A new test FILE (or route) moves
   `docs/architecture/facts.json`: run `pnpm facts:write && pnpm canon:render`,
   then sync every `<!-- fact:KEY -->N<!-- /fact -->` marker under `docs/` to
   the `.value` in facts.json. A canon row that cites `file:line` moves when
   that file shifts — re-anchor it.
7. **Every commit compiles on its own.** A contract change and the fixtures
   that satisfy it go in the same commit; root `pnpm typecheck` and the mobile
   typecheck pass at every SHA, not just the tip.
8. **Commit shape.** Conventional commits with ONE scope and no commas
   (`feat(mobile): …`, never `feat(api,mobile): …`), subject in Spanish
   without accents, the repo's noreply author and committer, NO AI
   attribution of any kind (no Co-Authored-By, no "Generated with"). Commit
   with explicit pathspecs. Never push.
9. **Code and comments in English**, UI copy in es-AR, tokens instead of raw
   hex, rate limits for every new `/api/v1` bucket with the hand-summed
   paragraph in `__tests__/api-v1-rate-limit-families.test.ts`.
10. **The report is data.** Under 300 words: SHAs, what changed per surface,
    the web-parity evidence, the exact test and lint output lines, and
    anything you chose not to do and why.
