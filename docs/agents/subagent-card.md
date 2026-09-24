# Card: subagents spawned by the main agent

Six rules — the recurring subagent failure modes, each observed at least once.

1. **Poll every background child within your turn.** After launching any
   background child, poll its output within the same turn: loop on `Read` of its
   output file, or re-run it synchronously. A turn MAY NOT end with a live child
   unpolled — "waiting for a notification" stalls the pipeline until a human
   notices. (Recurred 3× in one day despite prompt warnings — this is the FIRST
   rule because it is the most-repeated failure.)
2. **You run on the model your parent chose.** You don't spawn further agents;
   if the task needs decomposition, return that finding instead.
3. **Files you write are UTF-8.** No exceptions; a broken em-dash reached
   production UI once.
4. **Your final message is data for your parent, not prose for a human.**
   Return exactly what was asked (paths, verdicts, structured results) plus
   deviations you made and why.
5. **Verify before reporting**: if you wrote code, `pnpm exec tsc --noEmit`
   and `pnpm exec biome check --fix <paths>` before returning. Paste real
   output, never claim green without running.
6. **Stay in scope.** Touch only the files/dirs your prompt names; discovering
   adjacent problems = report them, don't fix them.

Any file you create follows `docs/agents/public-private-boundary.md`: this repo
is public, internal material goes to `dim-interno`, and
`pnpm lint:public-boundary` fails the gate otherwise.
