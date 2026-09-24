// Metro, taught to read a pnpm workspace.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------------------------------------------------------
// A default Expo app resolves everything from its own `node_modules` and
// watches only its own directory. This app does neither: it lives at
// `apps/mobile` inside a pnpm workspace, imports `@dim/contract` from
// `packages/contract`, and gets most of its dependency tree through symlinks
// into the root `node_modules/.pnpm` store. Three separate assumptions in the
// default config are wrong here, and each one is corrected below with the
// reason, because the next person to hit a "module not found" needs to know
// which of the three failed.
//
// THE LINKER IS NOT NEGOTIABLE (the constraint that shaped this file)
// ---------------------------------------------------------------------------
// The usual internet answer to "React Native + pnpm" is `node-linker=hoisted`
// in `.npmrc`. That is not available here: this repo's `.npmrc` and node-linker
// are shared with a live Next.js app, and flipping the linker moves EVERY
// package in the web app's install layout — a change whose blast radius is the
// production web build, to fix a bundler in a spike. So this file adapts Metro
// to pnpm instead of adapting pnpm to Metro. It worked; nothing in the repo's
// install layout moved. See the WU-C report for what fought back.

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

// 1. WATCH THE WORKSPACE, NOT JUST THIS APP.
//
// `packages/contract` ships TypeScript SOURCE (its package.json `exports` map
// points at `./src/**/*.ts`, there is no build step). Metro therefore compiles
// contract files itself, and it will only do that for files inside a watched
// root. Without this, editing a wire type would not even trigger a reload —
// and on a cold start the file would resolve to a path Metro refuses to serve.
//
// The root is the whole workspace rather than a two-entry list of
// `packages/contract` + root `node_modules`, because the pnpm store
// (`node_modules/.pnpm/...`) is where the REAL files live: every dependency
// under `apps/mobile/node_modules` is a symlink into it, and Metro follows the
// symlink to its realpath before deciding whether the file is watchable.
config.watchFolders = [workspaceRoot];

// 2. LOOK IN BOTH `node_modules` DIRECTORIES, AND ONLY THOSE.
//
// `nodeModulesPaths` is where Metro looks up a bare specifier. Both entries are
// needed: this app's own deps (expo, react-native, react-native-svg) are linked
// into `apps/mobile/node_modules`, while a handful of things — anything the
// root install hoisted — are only reachable from the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// 3. HIERARCHICAL LOOKUP STAYS ON — and this is the one that cost a build.
//
// Every "React Native + monorepo" guide reaches for
// `config.resolver.disableHierarchicalLookup = true` at this point. It was set
// here, and it broke the bundle immediately:
//
//   Unable to resolve module expo-modules-core from
//   node_modules/.pnpm/expo@57.0.16_.../node_modules/expo/src/Expo.ts
//   expo-modules-core could not be found within the project or in these
//   directories: node_modules, ../../node_modules
//
// That advice is written for the HOISTED layout, where every package is a
// direct child of one root `node_modules` and the upward walk finds nothing but
// duplicates. pnpm's isolated layout is the exact inverse: a package's
// dependencies are its SIBLINGS inside its own virtual-store directory
// (`.pnpm/expo@57.0.16_.../node_modules/expo-modules-core`), and the only way
// to reach them from `.../node_modules/expo/src/Expo.ts` is to walk up one
// level. Disabling the walk deletes the mechanism the whole layout is built on,
// and `nodeModulesPaths` cannot substitute for it — those two roots are exactly
// the two directories the error message lists as already searched.
//
// So the setting is left at its default (enabled). Under pnpm the walk is not a
// source of duplicate instances the way it is under hoisting, because each
// virtual-store directory contains exactly the versions its own package
// declared — the isolation is in the directory layout, not in a resolver flag.
//
// Recorded rather than deleted: a future reader hitting a resolution failure
// will find the same advice on the internet and try the same thing.

// 4. DO NOT CRAWL WHAT THE BUNDLE CAN NEVER IMPORT.
//
// Watching the workspace root (1.) means Metro's file map crawls EVERYTHING
// under it, and on Windows there is no Watchman: it is node's own recursive
// fs.watch plus a full crawl on every cold start. Measured 2026-09-04: the dev
// server wedged twice in one day at 1.6-4 GB RSS with `/status` gone silent,
// and the crawl included nine agent worktrees under `.claude/worktrees/`,
// eight of them with their own `node_modules`, plus `docs/` (84 MB of review
// screenshots), `.next/`, the web test suites and the session scratch. None
// of that can ever be imported by this app. Anchored at the workspace root so
// a package's own `docs/` folder inside the pnpm store is still crawled.
const rootPattern = workspaceRoot.replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/[\\/]/g, "[\\\\/]");
const neverImported = [
  "\\.claude[\\\\/]worktrees",
  "\\.git",
  "\\.next",
  "docs",
  "scratchpad",
  "e2e",
  "__tests__",
  "gate-[^\\\\/]*",
  "\\.playwright-(mcp|cli)",
].join("|");
const crawlExclusion = new RegExp(`^${rootPattern}[\\\\/](${neverImported})([\\\\/]|$)`);
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = Array.isArray(defaultBlockList)
  ? [...defaultBlockList, crawlExclusion]
  : defaultBlockList
    ? [defaultBlockList, crawlExclusion]
    : [crawlExclusion];

module.exports = config;
