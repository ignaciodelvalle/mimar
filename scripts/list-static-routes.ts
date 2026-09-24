// List every STATIC app route (no dynamic segments), one per line.
//
// Feeds the load sweep: "does every screen actually render for the role that
// owns it?". Dynamic routes ([publicToken], [id], …) are excluded because they
// need a real subject; they are swept separately from real IDs.
//
// Route-group folders — (app), (public), (auth), … — are path-invisible in the
// Next.js App Router, so they are stripped.
//
// Run: pnpm tsx scripts/list-static-routes.ts

import { globSync } from "node:fs";

export function listStaticRoutes(): string[] {
  const files = globSync("app/**/page.tsx").map((f) => f.replaceAll("\\", "/"));
  const routes = files
    .map((f) => f.replace(/^app/, "").replace(/\/page\.tsx$/, ""))
    .filter((r) => !r.includes("["))
    // Route groups are organisational only — they never appear in the URL.
    .map((r) => r.replaceAll(/\/?\([a-z-]+\)/g, ""))
    .map((r) => (r === "" ? "/" : r));
  return [...new Set(routes)].sort();
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("list-static-routes.ts");

if (isMain) {
  const routes = listStaticRoutes();
  console.log(routes.join("\n"));
  console.error(`${routes.length} static route(s)`);
}
