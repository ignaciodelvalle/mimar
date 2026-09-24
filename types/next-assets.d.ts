// Static asset module types (StaticImageData for .jpg/.png/.svg/…), committed.
//
// Next generates next-env.d.ts with this same reference, and create-next-app
// gitignores that file — so it exists on every developer's disk (any past
// build or dev run wrote it) and on no clean checkout. `pnpm typecheck` runs
// BEFORE `pnpm build` in both `pnpm verify` and CI, so on a fresh clone the
// first thing that happens is a type error for an import that is perfectly
// correct:
//
//   components/landing/BondBand.tsx: error TS2307
//   Cannot find module '@/public/landing/portada.jpg'
//
// It went unnoticed because CI had not run since 2026-06-12 and no local
// checkout is ever truly fresh. Found 2026-07-27, the first time CI ran again.
//
// This is a reference, not a re-declaration: it points at the very file
// next-env.d.ts points at, so having both changes nothing — TypeScript
// includes it once. Deleting next-env.d.ts leaves typecheck green; that is
// the property this file exists to give.
/// <reference types="next/image-types/global" />
