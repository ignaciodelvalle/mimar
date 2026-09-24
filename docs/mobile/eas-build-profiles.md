# EAS build profiles — the commentary `eas.json` cannot carry

> Sibling document to `apps/mobile/eas.json`. Same split, same reason, as
> `apps/mobile/app.json` ↔ `apps/mobile/app.config.ts`: the file EAS reads is
> JSON, JSON has no comments, and every decision in it is one that could have
> gone the other way. This is where the "why" lives. Change one of them, change
> the other.

**Status as of 2026-09-03: the running tally under
[First-run order, when the PO logs in](#first-run-order-when-the-po-logs-in) is the
record — read it rather than a count in a sentence.** Every build recorded there
before `94ab653c…` errored, each one further along than the last (fingerprint,
then Metro, then the native C++ compiler), and each cause has its own section at
the end of this file. `94ab653c…` is the first to produce an artifact and the
first to reach Play — internal testing, 2026-08-27 — and Play answered it with
exactly one warning, which is
[its own section below](#the-play-warning-about-a-deobfuscation-file-and-why-there-is-nothing-to-upload).
`npx eas-cli whoami` answers the maintainer's personal Expo account and a team
account (the project lives under the team account).

**The round is not running. It is stopped, and has been since 2026-08-28.**
Build 6 shipped but predates "env in the profiles", so it has no
`EXPO_PUBLIC_SUPABASE_URL` and no tester can sign in. Build 7 carried the fix
and errored, which is
[the fifth failure](#the-fifth-failure--a-catch-block-that-never-runs-and-the-tester-round-that-stalled-behind-it).
Until a build after `972717c86` finishes, the newest installable artifact is one
that shows a configuration error instead of a login screen. Every build to date
has used the `production` profile; no `preview` APK existed before 2026-09-03.

One sentence is worth carrying out of the failures, and the fifth is the fifth
data point for it rather than an exception: **every one of them was a dependency
this repo did not declare**, resolved by accident on one machine and differently
— or not at all — on the worker. Four of them were packages the app's own code
imports. The fifth was a package only somebody else's *build script* executes,
which is why nothing that reads `import` statements could have caught it — but
the shape is identical, and so is the fix.

---

## The three profiles, and who each one is for

| Profile | Who installs it | Artifact | Distribution |
|---|---|---|---|
| `development` | The PO, on his own device | APK with the dev client embedded | `internal` |
| `preview` | The 12 testers | APK | `internal` |
| `production` | Everyone, via Play | Android App Bundle (`.aab`) | `store` |

### `development` — `developmentClient: true`

This is not "the debug build". It is a **different app**: one that ships the
`expo-dev-client` runtime instead of a fixed JS bundle, so it can be pointed at
a Metro server running on a laptop and reload the whole app on save. Everything
the PO would otherwise have to rebuild for — a copy change, a layout fix, a new
screen — becomes a save.

What it buys over `expo start` in Expo Go is the reason it exists at all: this
app has native modules Expo Go does not contain (`expo-secure-store`,
`expo-updates`, and every module a future SDK bump adds). Expo Go can only run
the subset of the SDK it was compiled with. A development build contains *this*
app's native runtime, so what the PO tests on the phone is the runtime that
ships.

`distribution: internal` because there is no Play track involved: EAS hosts the
artifact behind an install page and a QR, and the phone sideloads it.

### `preview` — an APK, deliberately, and not an App Bundle

An `.aab` is **not installable**. It is a publishing format: a container Google's
servers split into per-device APKs at download time. Handing a tester an `.aab`
hands them a file their phone cannot open.

So `preview` builds `buildType: "apk"` — one universal APK, every ABI and
density inside it, bigger than what Play would deliver and installable by
anyone with the link. That size penalty is the entire cost of the decision and
it is the right trade for 12 people who need to *have the app* more than they
need it to be small.

`distribution: internal` again: no Play review, no track, no wait. The 12 get a
URL.

### `production` — `app-bundle`, because Play does not accept anything else

New applications have been required to publish as App Bundles since August 2021.
There is no choice to document here; what is worth documenting is that this is
the ONLY profile that produces a format nobody can sideload, which is why the
other two do not inherit from it.

`autoIncrement: true` — see below.

---

## `cli.appVersionSource: "remote"` — the decision that costs something

`versionCode` (Android) and `buildNumber` (iOS) are **not** the user-facing
version. `version` in `app.json` (`0.0.1`) is what a human reads. `versionCode`
is an integer Play uses to order releases, and it carries one brutal rule:

> A `versionCode` is **burned the moment an artifact carrying it is uploaded** —
> to production, to internal testing, to a closed track, anywhere. Play will
> never again accept that number for this package, and it will never accept a
> number lower than the highest one it has seen. There is no undo, no support
> ticket, no reset.

`appVersionSource` decides who owns that counter.

- **`local`** — the number lives in the repo (`app.json` / `build.gradle`) and a
  human increments and commits it.
- **`remote`** — the number lives on EAS's servers, and `autoIncrement: true`
  bumps it there, once, per build.

### Why `remote` is correct for THIS repo

Because `local` makes a monotonic counter depend on a human remembering to
commit a number, and this repo's working norms actively break that assumption:

1. **Parallel writers run in git worktrees** (`CLAUDE.md`, "Parallel writers only
   in worktrees"). Two worktrees at the same base commit hold the *same*
   `versionCode`. Two builds, two identical numbers, and the second upload is
   rejected — after the first one has already burned the number, so the fix is
   to burn another.
2. **The PO is not the only one who can trigger a build.** A CI-triggered build
   and a laptop-triggered build read the same committed integer.
3. **A forgotten bump is silent until Play refuses the upload**, which is the
   worst possible moment to discover it: the artifact is built, the release is
   being cut, and the answer is "build it again".

`remote` replaces "everyone agrees to increment a file" with a single
authority that hands out each number exactly once. That is the same shape as
every other counter in this system that must not collide.

### What `remote` costs — and it is not nothing

**The number leaves the repo.** This project's default posture is that the tree
is the record; `git log` answers questions about what shipped. It cannot answer
"which commit is `versionCode` 7?" any more. Only `eas build:list` can. EAS does
record the git commit on each build, so the mapping exists — it just lives on a
server that a `git clone` does not bring with it, and that a lapsed subscription
takes away.

**Builds now need the network and a session to know their own version.** There
is no offline answer to "what is the next `versionCode`". This is a hard
dependency added to the release path.

**Local builds are numbered in a different universe.** `pnpm -C apps/mobile
android` (`expo run:android`) never talks to EAS, so it uses whatever the native
project says — `1`, forever. That is harmless *only* as long as no locally-built
artifact is ever uploaded to Play. That is a rule enforced by nobody. Write it
down here and do not upload local builds.

**Rollback is still not free.** `remote` fixes collisions, not burns. Shipping a
bad build and wanting the previous one back means a *new*, higher `versionCode`
carrying the old code — never the old number again.

---

### `cli.version: ">= 12.0.0"` — a floor, not a pin

eas-cli is not a repo dependency; it runs through `npx`, so whatever version the
machine resolves is the version that reads this file. `cli.version` is the only
thing that can refuse an old one, and 12.0.0 is where `remote` became the
default version source for new projects — i.e. the first release where the
behaviour this file depends on is the mainline path rather than an option.

It is a floor rather than a pin on purpose: pinning would mean a version bump in
this repo every time the CLI moves, for a tool nobody here installs. The
trade-off is real — a future CLI could change what these profiles mean and this
floor would not catch it. That is what the `release-config.test.ts` assertions
are for: they check the values, not the version that reads them.

---

## What is deliberately NOT in `eas.json`

**No `submit` block.** `eas submit` to Play needs a Google Play service-account
JSON key, which needs a Play Console account, which does not exist. An empty
`"submit": { "production": {} }` would read as configured and is worth less than
its absence.

**No `ios` blocks on any profile.** The app declares `ios` in `platforms` and
takes its bundle identifier from `@dim/contract/links`, but there is no Apple
Developer enrolment — the same blocker `app.config.ts` documents as the reason
Universal Links cannot be wired yet. An iOS `development`/`preview` build needs
an ad-hoc provisioning profile with each tester's device UDID registered against
a Team ID that does not exist. When the enrolment lands, the iOS defaults EAS
applies are the right starting point; guessing at them now would ship
configuration nobody can test.

**No `owner`, no `projectId`, no credentials.** `extra.eas.projectId` lives in
`app.config.ts` — written by hand on 2026-08-25 precisely so `eas init` would
never rewrite that heavily-commented file — and `owner` is deliberately absent
there for reasons that file explains. Credentials are generated by EAS on first
build and never enter the repo.

---

## The `channel` field, and where OTA fits

Each profile declares a `channel`, and each channel maps 1:1 to the profile
name. That mapping is what lets `eas update --channel preview` reach exactly the
builds the testers installed and nothing else.

**Channels are not a release mechanism here.** OTA is fenced to hotfixes by PO
decision, the fence is `runtimeVersion`, and the whole argument lives in
[`ota-policy.md`](./ota-policy.md). Read that before running `eas update`.

---

## First-run order, when the PO logs in

1. `npx eas-cli login`
2. `npx eas-cli build --profile development --platform android` — the first
   build generates the Android keystore, and **EAS holds it**. Run
   `eas credentials` and take a backup before the first *production* build.

   Being precise about the risk, because the folklore overstates it in one
   direction and understates it in another: under **Play App Signing** the key
   Play distributes with is Google's, and a lost *upload* key can be reset
   through Play Console support — so this is recoverable, not fatal. Without
   Play App Signing, or for any artifact distributed outside Play, the keystore
   is the only thing that can sign an update to this package and losing it ends
   the package. Take the backup either way; the two-minute version costs less
   than finding out which case you are in.
3. Install on device, `pnpm -C apps/mobile start`, scan.
4. `--profile preview` when there is something for the 12 to look at.
5. `--profile production` only after the Play Console exists — and note that the
   first production build burns `versionCode` 1 whether or not it is ever
   uploaded, because `autoIncrement` bumps the counter at build time.

   **That claim is no longer read from a contract; it was measured.** The build
   that failed on 2026-08-26 carried `versionCode` **2**, having never produced
   an artifact and never reached Play. One number was already gone before it
   started, and it took a second one on its way to erroring fifteen minutes in.
   A failed build costs a `versionCode`.

   The running tally, because the counter is monotonic and nothing gives a
   number back:

   | `versionCode` | Build | Outcome |
   |---|---|---|
   | 1 | — | consumed before the first recorded build |
   | 2 | `9900114a-c134-41cf-af38-6aaf789d2942` | errored — fingerprint mismatch, two causes |
   | 3 | `e2a89561-910b-4ad7-97fa-ab0f2a481db8` | errored — `Cannot find module 'babel-preset-expo'` in Gradle |
   | 4 | `9bdab7b8-b5e2-4aa5-8272-f8e990c0cce3` | errored — C++ compile: `no member named 'executeSync'` in `expo-modules-core` |
   | 5 | `94ab653c-7436-4334-b958-f08510222e93` | **shipped** — first artifact; uploaded to Play internal testing 2026-08-27 |
   | 6 | `371a2122-a333-4d24-8272-c64ed910d1da` | shipped — commit `47189da6f`, 2026-08-28. **Cannot log anyone in**: predates "env in the profiles", so no `EXPO_PUBLIC_SUPABASE_URL` is baked in |
   | 7 | `4a4f4dac-9bc3-4986-a5d2-25a083840c83` | errored — Gradle could not START `sentry-cli`; the path it guesses does not exist under pnpm |
   | 7 (again) | `3016d593-fc7c-4773-9351-43e4cb990e22` | finished — `preview` profile, commit `71f7b8ca0`, 2026-09-03. Same number because only `production` auto-increments; the PO installed it and validated the credential redesign on the phone |
   | 8 | `f18a4d30-7100-41bc-98d0-f14103e81789` | finished — `production`, commit `2d0b3f5d7`, 2026-09-03. AAB uploaded to Play internal testing and **held, not promoted**: the PO refused to publish a build without the brand mark ("no una a medias"); superseded by 9, then 10 |
   | 9 | `5704cf7c-a59d-4717-a8ff-7d374353dcab` | finished — `production`, commit `02db08408`, 2026-09-04. First artifact carrying the chamfered mark, the credential fixes from the 2026-09-03 review and the pull-to-refresh that keeps the document on screen. **Never uploaded**: superseded by 10 the same night, because its launcher label and three copy strings still spelled the brand `MiMAR` |
   | 10 | `dd049674-3c72-441a-a310-fc2e99667b88` | finished — `production`, commit `90f91ca96`, 2026-09-05. Brand spelled `miMAR` on the launcher and in copy (the brand fence does not cover `apps/mobile`, which is how 8 and 9 shipped otherwise); the identity-gate re-login fix; Sentry PII redaction; served by the same push that fixed the offering locality on confirmed turnos. Verified inside the AAB (Hermes string table and `resources.pb`), not from the config: label `miMAR`, no `MiMAR`, API `https://www.mimar.com.ar`, hosted Supabase, package `ar.mimar.app`. AAB handed to the PO for the manual Play upload |

   Every number above a failing row was spent for nothing, and Play will never
   see them — that is fine, the counter only has to increase, but it is the
   reason each failure earns a written-down cause rather than a retry. Those
   causes are the `##` sections at the end of this file: one per section, and the
   sections are the list, not this paragraph. They sit at four different LAYERS
   (fingerprint, Metro, native compile, and now a build-script path assumption)
   and share one shape, which the last of them names.

   **The two "reported rather than measured" caveats on the `94ab653c…` row are
   now closed, and the way they closed is worth keeping.** This paragraph used to
   say that "nothing on this machine can reach EAS to confirm either (`eas-cli`
   is deliberately not a repo dependency, per `cli.version` above, so there is no
   session and no `build:list` here)". That inference was wrong in one step:
   `eas-cli` not being a *dependency* does not mean it is unreachable — `npx
   eas-cli build:list --json` runs without installing anything into the repo, and
   the login persists in the user profile, not the project. On 2026-09-03 that
   command answered for every row above.

   And it confirmed the derivation. `appBuildVersion` in the EAS record is the
   `versionCode`, and the measured sequence is exactly 2, 3, 4, 5, 6, 7 against
   the ids in this table — so the rule this file invented, *a failed build costs
   a number*, was right, and rows 2–5 were never guesses after all. Keep the
   habit anyway: the rule earned its confidence by being checkable, not by being
   plausible.

   Rows 6 and 7 were never in this table before 2026-09-03, and that is the real
   cost recorded here. Build 7 failed on 2026-09-02 and sat unnoticed for a day
   while the tester round was assumed to be under way. It was not: build 6 is the
   newest artifact, and build 6 is the one that cannot sign anyone in. **A tally
   nobody updates stops being a record and becomes a reassurance.**

   **Store listing assets are not part of any build.** The Play feature graphic
   is generated from the brand mark by `pnpm mobile:icons` and committed at
   `apps/mobile/assets/store/feature-graphic.png`; upload it by hand in Play
   Console alongside the `.aab` — there is no `submit` block wiring this
   automatically (see "What is deliberately NOT in `eas.json`" above).

---

## Two ways to break a fingerprint, and the first real build found both

`app.config.ts` sets `runtimeVersion: { policy: "fingerprint" }`, and the long
comment there explains what that buys: an OTA update is only served to a build
whose native runtime hashes to the same value, so JS that calls into a native
module the installed binary lacks reaches zero phones instead of crashing all of
them. What that comment does not say — because nobody knew it yet — is what the
policy *costs*:

> **A fingerprint that hashes toolchain-generated paths is only reproducible if
> the toolchain is pinned.**

EAS Build enforces this directly. eas-cli computes the fingerprint on the
developer's machine, the worker recomputes it after installing dependencies and
prebuilding, and the build is refused when the two disagree:

```
Runtime version calculated on local machine: 732cfe13cadf6b2c60cca478dee63b824be6aa79
Runtime version calculated on EAS:           a178f73ce819f5ae3261f6bbb76c75d51f6a3c0c
```

Build `9900114a-c134-41cf-af38-6aaf789d2942` died there. The printed diff had two
distinct causes in it, and they are worth separating because the smaller one was
nearly written off as noise from the larger.

### Cause 1 — pnpm truncates its virtual store differently on Windows and Linux

~150 of the diff entries were the same package under two spellings of its own
directory name:

```
local: node_modules/.pnpm/@expo+dom-webview@57.0.1_ex_0f048bff0e42b7ac3ac0bc1ac9518370/…
EAS:   node_modules/.pnpm/@expo+dom-webview@57.0.1_expo@57.0.16_react-native@0.86.2_@babel+core@7.29.7_@react-nat_0f048bff0e42b7ac3ac0bc1ac9518370/…
```

Same trailing hash, different visible length, because pnpm's
`virtual-store-dir-max-length` **default depends on the platform**. From pnpm
11.1.1's own source:

```js
"virtual-store-dir-max-length": isWindows() ? 60 : 120,
```

60 on Windows because of its 260-character path limit, 120 everywhere else. And
`@expo/fingerprint` hashes the native dependency set **by path** — run
`npx expo-updates fingerprint:generate --platform android` and the source list is
full of `../../node_modules/.pnpm/<truncated-dir>/…` entries. Two platforms, two
truncations, two runtime versions, out of one lockfile.

There is no `.npmrc` in this repo, so both sides were sitting on their platform
default. The fix is one line in `pnpm-workspace.yaml`:

```yaml
virtualStoreDirMaxLength: 60
```

**60 rather than 120**, on purpose. 60 is what Windows already did, so the pin
changes nothing on the PO's daily machine — measured before the pin, the longest
directory name in the store was exactly 60 characters. 120 would instead push
every Windows checkout 60 characters deeper against a 260-character ceiling that
the repo path already spends part of, which trades a broken build for a broken
checkout. Truncation is not ambiguity: the 32-character suffix that survives it
is a hash of the *full* peer string. The whole argument sits in the comment above
that line.

Two consequences worth knowing before anyone changes the number again. pnpm
records it in `node_modules/.modules.yaml` and refuses to reuse a tree built with
a different one (`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF` — the cure is
`pnpm install`). And it moves the fingerprint, which means a new runtime version
and a fleet that no longer matches whatever was last published.

### One pnpm, everywhere — why `packageManager` is in the root `package.json`

The pin above has a precondition nobody had written down: **it is only read by a
pnpm that knows to read it.** Settings arrive from `pnpm-workspace.yaml` through
`addSettingsFromWorkspaceManifestToConfig`, which is a mechanism pnpm grew at a
particular version. A pnpm that predates it does not error and does not warn — it
ignores the file's settings, truncates at its own platform default, and lands
back in exactly the fifteen-minute mismatch above, with `virtualStoreDirMaxLength:
60` sitting in the repo the whole time looking like the problem was solved.

Which pnpm runs where was, until now, three different accidents:

| Where | Which pnpm ran | Decided by |
|---|---|---|
| The PO's Windows machine | whatever `npm i -g pnpm` last installed | nobody |
| GitHub Actions | `11` — a major, so any patch inside it | eleven copies of a workflow input |
| **The EAS Build worker** | **whatever its image ships** | **Expo, without telling us** |

The third one is the one that matters, because it is the side of the comparison
this machine cannot see. It is not hypothetical that images move: the SDK 57
Android image ships pnpm **11.9.0** today, and the image that runs next month's
build is not this one.

So the root `package.json` carries one line:

```json
"packageManager": "pnpm@11.1.1"
```

**This is not tidiness, and it is not Corepack.** pnpm enforces the field
*itself*, and reading pnpm 11.1.1's own bundled `lib/main.js` is what settles
what happens: a `packageManager` field with no explicit `onFail` is defaulted to
`"download"`, and then

```js
if (pm.name === 'pnpm' && pm.onFail === 'download' && !isExecutedByCorepack()) {
  await switchCliVersion(config, context)
}
```

— pnpm fetches the pinned version and re-executes as it, *before* it resolves a
single path. The pnpm that computes the paths `@expo/fingerprint` hashes is
therefore the same pnpm on all three machines, whatever the worker image happens
to ship. `switchCliVersion` returns immediately when the running version already
equals the pinned one (`pm.version === packageManager.version`), so the PO's
machine pays nothing: measured at 0.486s for `pnpm --version` and 360ms for a
no-op `pnpm install --frozen-lockfile`.

And if some future worker's pnpm is too old to know how to switch, it fails with
`ERR_PNPM_BAD_PM_VERSION` in the install step — thirty seconds in, naming the
version it wanted. That is a *strictly better* failure than the one this whole
section is about, which is why the pin is worth having even in the case where its
mechanism does not work.

**Corepack is deliberately not used.** `eas.json` has a `corepack: true` switch
and it is left `false`: under Corepack pnpm refuses to switch versions at all
(`main.js` says so in the error hint — "pnpm does not switch versions when
running under corepack"), and eas-cli issue #3148, still open, is a project that
turned it on and found EAS installing pnpm a second time on top of Corepack's
shim.

**The web deploy is not in the blast radius.** Vercel reads `packageManager`
*only* when a project sets `ENABLE_EXPERIMENTAL_COREPACK=1`; without it, Vercel
keeps detecting the package manager from the committed lockfile exactly as
before. So this line does not change how `dim-staging` installs. If a Vercel
build ever does report a surprising pnpm, that env var is the first thing to
look at.

#### Why `eas.json` does NOT also declare it

`eas.json` build profiles accept a `"pnpm": "<version>"` field. Adding it would
be a second number to keep in sync with the first, which is the class of drift
this repo writes fences against — and it would buy nothing, because it only
chooses what EAS puts on `PATH` before an install that then switches versions
anyway. It also does not travel: a local checkout and a CI runner never read
`eas.json`. `package.json` is the one declaration all three machines already
open. **One pin, in the file every machine reads.**

#### The eleven `version: 11` inputs had to go, and not for tidiness

`pnpm/action-setup@v4` compares its `version:` input against the `packageManager`
field **as raw strings**:

```js
if (packageManagerVersion && packageManagerVersion !== version) {
  throw new Error(`Multiple versions of pnpm specified: …`)
}
```

`"11.1.1" !== "11"`, so adding the field while leaving the input in place would
have failed *every job in every workflow* at the setup step — not subtly, and not
only on the mobile ones. The input is removed from all eleven steps; with no
input the action reads the field, which is the behaviour we want anyway. The
comment above each step says so, and
`apps/mobile/src/release/release-config.test.ts` fails if a `version:` input ever
comes back.

### Cause 2 — EAS prebuilds `android/`, and nothing was ignoring it

One line in the same diff had no story:

```json
{"op":"added","addedSource":{"type":"dir","filePath":"android","reasons":["bareNativeDir"]}}
```

`apps/mobile/android` does not exist locally. EAS's own prebuild creates it, and
then fingerprints it. This is **not** a second symptom of cause 1 — pinning the
store length would have left it standing.

The mechanism is in `@expo/fingerprint/build/ProjectWorkflow.js`. Before hashing,
fingerprint decides whether the project is CNG (`managed`) or has hand-maintained
native projects (`generic`): it looks for `android/app/build.gradle` and the
AndroidManifest, and if either **exists and is not ignored**, the project is
`generic`. Only `managed` appends `android/**/*` to the ignore list, and that is
what makes the directory hash to `null` and drop out of the fingerprint entirely.

The repo's root `.gitignore` deliberately did not list `android/` — the comment
there said the generated-or-committed question was "its own change". On an EAS
worker that reads as *generic*, and the entire prebuild output goes into the hash.

The remedy is `apps/mobile/.gitignore` carrying `/android/` and `/ios/`, and
**the location is load-bearing**. To answer "is this ignored", fingerprint needs
a VCS client; when `git rev-parse --show-toplevel` fails it falls back to a
NoVCSClient that globs `**/.gitignore` **from the Expo project root**. An EAS
worker unpacks an archive, not a git clone, so it takes that path — and a rule in
the repo root's `.gitignore` is out of its reach. The same rule inside
`apps/mobile/` is seen by both clients.

`.easignore` gained `apps/mobile/android/` and `apps/mobile/ios/` at the same
time, for a different reason: it replaces every `.gitignore` for upload purposes,
so without them a locally-run `expo prebuild` would be shipped to EAS and land on
top of the one EAS runs for itself.

### What was measured, and what is still unproven

Measured locally, on the fixed tree:

- `npx expo-updates fingerprint:generate --platform android` returns
  `8e47f6dbffad896a681a3fe56c5caf494c964c19` on three consecutive runs.
- With a stub `android/app/build.gradle` + AndroidManifest planted to imitate
  EAS's prebuild, and `apps/mobile/.gitignore` in place, the fingerprint is
  **unchanged** — `8e47f6db…`, with the `bareNativeDir` source present in the
  list carrying `"hash": null`. Null-hash sources are skipped by the hasher, so
  the entry may still appear in a source listing without touching the number.
- Move `apps/mobile/.gitignore` out of the way and the same tree fingerprints
  `a8ac6ea0728cc9c40d82003ab224f06525e6eb87`, with `bareNativeDir` carrying a
  real hash. That is cause 2, reproduced and then cured, on a Windows machine.
- The NoVCSClient path was replayed against the real `glob` and `ignore` packages
  fingerprint ships: rooted at `apps/mobile` it finds exactly one `.gitignore` —
  the new one — and reports all three workflow markers ignored.
- `npx expo-doctor`: 21/21 checks passed.

**Not proven, and not provable from here:** that the Linux fingerprint now equals
the Windows one. Nothing on this machine can compute EAS's side. The pin removes
the *known* divergence and the reasoning is mechanical, but the only evidence
that settles it is the next build's own runtime-version line.

### The dependency bump that came with it

The same build's `expo doctor` step failed a second check — nine packages behind
the SDK's expected patch versions — and doctor's exit code fails the build. They
were aligned with `npx expo install --fix`: `expo`, `expo-constants`,
`expo-dev-client`, `expo-linking`, `expo-router`, `expo-secure-store`,
`expo-updates`, `react-native` and `jest-expo`.

That was done **after** pinning the store length, deliberately: a dependency bump
changes the native dependency set and therefore *should* move the fingerprint,
and there is no point stabilising a number that is about to change. Pin first,
bump second, measure once.

It surfaced one thing nobody asked for. `expo-router@57.0.17` depends on
`@expo/metro-runtime@^57.0.14`, and the lockfile kept resolving it to `57.0.13` —
a version outside the declared range — through `pnpm update`,
`pnpm install --resolution-only` and `pnpm install --fix-lockfile` alike. A
throwaway project with `expo-router@57.0.17` as its only dependency resolved
`57.0.14` on the first try, which is how the lockfile was identified as the thing
at fault rather than the registry. `pnpm remove` followed by `pnpm add` on
`expo-router` dropped the stale resolution and it came back correct. If a doctor
run ever reports a version that contradicts a package's own declared range, that
is the shape of it: the lockfile is holding an old auto-installed peer, and only
removing the dependent forces a re-resolution.

### Two dead keys in `app.json`

The same doctor run failed the config-schema check on `newArchEnabled` and
`android.edgeToEdgeEnabled`. Both were removed. Both are **no-ops in SDK 57** —
the New Architecture and edge-to-edge are unconditional now, the keys were
vestigial, and the only thing they still did was fail the build.

**One sentence of the evidence for that was wrong, and is corrected here.** The
original write-up said a sweep of `@expo/prebuild-config@57.0.14` finds no reader
for either key. Two things were off. The sweep was run against `57.0.14`, and the
dependency bump described in the section above *replaced that version in the same
work unit* — so the claim was already unfalsifiable against the tree it shipped
in. And re-run against what is actually installed, it does not hold:

| Key | `@expo/config-types@57.0.2` | `@expo/prebuild-config@57.0.15` | `@expo/config-plugins@57.0.9` |
|---|---|---|---|
| `newArchEnabled` | absent | absent | absent |
| `edgeToEdgeEnabled` | absent | **1 reader** | absent |

The reader is `build/plugins/unversioned/edge-to-edge/withEdgeToEdge.js`:

```js
if ('edgeToEdgeEnabled' in (config.android ?? {})) {
  WarningAggregator.addWarningAndroid(TAG,
    '`edgeToEdgeEnabled` customization is no longer available - Android 16 makes ' +
    'edge-to-edge mandatory. Remove the `edgeToEdgeEnabled` entry from your ' +
    'app.json/app.config.js.');
}
```

It reads the key only to tell you to delete it; the behaviour it used to control
runs unconditionally either way. **So the conclusion survives intact — removing
the key is a no-op plus one fewer warning — but the reason it survives is not the
reason that was written down.** A conclusion that happens to be true is not the
same as a verified one, and this repo's rule is that the recorded evidence has to
hold against the committed tree.

> A note on how the correction was measured, because it nearly went the other
> way. The first sweep here was `rg -ril --no-ignore --hidden 'edgetoedge'` over
> the installed package, and it returned **zero** — a false zero, from the same
> family as the dotfile misses this repo already warns about. The settled answer
> came from a Node script that builds the needle with `String.fromCharCode` and
> reports **counts**, not echoed text: `edgeToEdgeEnabled` appears 3 times in
> that one file, `newArchEnabled` 0 times across all 356 files of the three
> packages. When a sweep's whole value is its exhaustiveness, prefer the
> instrument that returns a number you can check for non-vacuity over one that
> returns silence.

### Gate evidence for `6c0e0f607..a372510ad`, recorded late

Those four commits — the dependency bump, the two dead keys, the fingerprint fix
and the write-up above — were gated together, and the run that gated them was a
**third-signature red**. CLAUDE.md's rule for that signature is that it may be
committed only with **both** verdict lines quoted in the commit message. Their
messages carry neither, and they are already pushed, so the messages cannot be
corrected. The honest repair is not a rewritten history; it is putting the two
lines where anyone auditing that range will meet them:

```
run 1: reported 1425 file(s); 1425 discovered; 0 failing test(s); 1 broken file(s)
       victim __tests__/owned-pets-count-deceased.test.tsx — 2 tests pending,
       "Worker exited unexpectedly"
run 2: reported 1425 file(s); 1425 discovered; 0 failing test(s); 0 broken file(s)
```

That is the documented shape of the open worker defect and not of a real
failure: one clean re-run, and a victim — the owned-pets deceased-count test —
with no relationship whatsoever to a dependency bump and two ignore rules. The
rule was followed; only the *recording* of it was skipped, which is the part that
makes the rule worth anything a month later.

The lesson is procedural and it is the reason this section exists: **evidence
that lives only in a terminal has not been kept.** A commit message is the
cheapest durable place for it, and it is write-once — after the push, the only
remaining option is a paragraph like this one.

---

## The third failure — `MODULE_NOT_FOUND` inside a Metro phase

Build `e2a89561-910b-4ad7-97fa-ab0f2a481db8` (2026-08-26, production, commit
`f378d5f33`, `versionCode` 3) is the first one that got past everything above.
The fingerprint matched, `Configure expo-updates` passed, Gradle started. It then
died in `:app:createBundleReleaseJsAndAssets`:

```
> Task :app:createBundleReleaseJsAndAssets FAILED
Starting Metro Bundler
Failed to construct transformer: Error: Cannot find module 'babel-preset-expo'
Require stack:
- node_modules/.pnpm/@babel+core@7.29.7/node_modules/@babel/core/lib/config/files/plugins.js
code: 'MODULE_NOT_FOUND'
Android Bundling failed 5ms … expo-router/entry.js (1 module)
Execution failed for task ':app:createBundleReleaseJsAndAssets'.
> Process 'command 'node'' finished with non-zero exit value 1
```

`apps/mobile/babel.config.js` had returned `{ presets: ["babel-preset-expo"] }`
since the app was created, and **nothing in this repository declared
`babel-preset-expo`** — not `apps/mobile/package.json`, not the root
`package.json`. It was an undeclared dependency from day one, and it worked
locally every single time.

### Why it resolved locally: pnpm's bin shim exports `NODE_PATH`

The tempting explanation is "Node walked up into pnpm's store". That is wrong,
and it was worth disproving, because the wrong mechanism suggests the wrong
fence. Measured on the failing tree, before the fix:

```
require.resolve("babel-preset-expo", { paths: ["C:/dev/dim/apps/mobile"] })  → MODULE_NOT_FOUND
require.resolve("babel-preset-expo", { paths: ["C:/dev/dim"] })              → MODULE_NOT_FOUND
```

Both fail. So does the ESM path Babel prefers (`import-meta-resolve` rooted at
the same directory). And hiding pnpm's hidden hoisted store entry
(`node_modules/.pnpm/node_modules/babel-preset-expo`) changed nothing: the export
still succeeded, with a cleared Metro cache.

The actual carrier was found by hooking `Module._resolveFilename` through
`NODE_OPTIONS=--require` during a real `expo export`. The lookup Babel makes from
`plugins.js` — `require.resolve("babel-preset-expo", { paths: [<project root>] })`
— succeeded, and the reason is the *other* list Node consults for a bare
specifier:

```
globalPaths = [
  …/node_modules/.pnpm/expo@57.0.17_<hash>/node_modules/expo/node_modules,
  …/node_modules/.pnpm/expo@57.0.17_<hash>/node_modules,      ← babel-preset-expo lives here
  …/node_modules/.pnpm/node_modules,
  …
]
```

`Module.globalPaths` is `NODE_PATH`, and `NODE_PATH` was set by pnpm's own bin
shim. `apps/mobile/node_modules/.bin/expo` is not a symlink; it is a generated
script whose first act is:

```sh
if [ -z "$NODE_PATH" ]; then
  export NODE_PATH=".../.pnpm/expo@57.0.17_<hash>/node_modules/expo/node_modules:.../.pnpm/expo@57.0.17_<hash>/node_modules:.../.pnpm/node_modules"
else
  export NODE_PATH="…:$NODE_PATH"
fi
exec node "$basedir/../expo/bin/cli" "$@"
```

That middle entry is the virtual-store directory holding **expo's own
dependencies**, and `expo@57.0.17` depends on `babel-preset-expo: ~57.0.9`. So
every command run through the shim can resolve any of expo's transitive
dependencies by bare name, from any directory. EAS's Gradle task does not run the
shim — the log says `Process 'command 'node''`, not `expo`. No shim, no
`NODE_PATH`, no preset.

Reproduced locally, both directions:

```
# link removed, shim bypassed — the EAS environment
$ NODE_PATH= node node_modules/expo/bin/cli export --platform android
Failed to construct transformer:  Error: Cannot find module 'babel-preset-expo'

# link present, shim bypassed
$ NODE_PATH= node node_modules/expo/bin/cli export --platform android
Android Bundled 8586ms … (1617 modules)
Exported: dist
```

### The nightly export could not have caught this, and that correction matters

`.github/workflows/mobile-export-nightly.yml` exists precisely to catch bundling
regressions, and the obvious reading of this failure is "the fence existed but
had not reached the default branch yet, so it could not fire". That reading is
wrong. The workflow runs `pnpm -C apps/mobile export`, which resolves `expo`
through `node_modules/.bin` — **the shim** — and pnpm writes that shim on every
platform at install time, Linux runners included. Measured on the pre-fix state:

```
$ pnpm export        # exactly the nightly's command, babel-preset-expo unlinked
Android Bundled 8354ms … (1617 modules)
Exported: dist      → exit 0
```

Green. The nightly would have been green on the night of the failure and every
night before it. A gate that invokes the toolchain the convenient way cannot see
a defect that only appears when the toolchain is invoked the inconvenient way,
and "it hasn't merged yet" would have quietly closed this question with the wrong
answer. The job now invokes the CLI directly for that reason; the commentary in
the workflow file says so at the step.

### The fix, and the version

`babel-preset-expo` is now declared in `apps/mobile/package.json`:

```json
"babel-preset-expo": "~57.0.9"
```

**How that range was chosen, and why not the one `expo install` picks.** Running
`npx expo install babel-preset-expo` issues `pnpm add babel-preset-expo@~57.0.0`
— the SDK-compatible floor — and pnpm resolved that to **57.0.8**, one patch
below the **57.0.9** that `expo@57.0.17` already depends on. The result was a
*second copy* of the preset in the tree and 98 lines of lockfile churn
(`babel-preset-expo@57.0.8`, `@react-native/codegen@0.86.2`,
`@react-native/babel-plugin-codegen@0.86.2`). Two Babel presets compiling the
same app is not a fix; it is a new fingerprint input and a new class of bug.

So the authority used was the SDK's own declaration — `expo@57.0.17` requires
`babel-preset-expo: ~57.0.9` — and the range was written to match. That
deduplicates onto the exact instance already installed, and the lockfile moves by
**one importer entry, three lines, zero new resolutions**. `npx expo install
--check` still reports "Dependencies are up to date", because `~57.0.9` is inside
`~57.0.0`.

**`dependencies`, not `devDependencies`, and it is a judgement call.** The
package is a build-time tool that never ships inside the binary, which argues for
`devDependencies`. Three things argue the other way and won: `expo` itself
declares it as a `dependency`, so this changes nothing about the resolved graph;
`apps/mobile` is `private: true` and never published, so the split only affects
install pruning; and the failure being cured is *a package missing on a build
worker*, which is not the moment to make the cure depend on an install mode
nobody in this repo has verified.

### The sweep that came with it

One missing package is an incident; a config file naming a package nobody
declares is a *shape*. Every config file this app loads was swept for every
package name it names, and each name checked against
`apps/mobile/package.json` — `babel.config.js`, `metro.config.js`,
`jest.config.js`, `jest.setup.js`, `app.config.ts`, `app.json`, `tsconfig.json`,
`eas.json` and `package.json` itself (its `main` and its script binaries).

**12 distinct package names found, 11 already declared, 1 missing** — the one
above. In full: `@dim/contract`, `@react-native/jest-preset`, `babel-preset-expo`
(MISSING), `expo`, `expo-crypto`, `expo-router`, `expo-secure-store`,
`expo-splash-screen`, `jest`, `jest-expo`, `react-native-safe-area-context`,
`typescript`. Nothing was left undeclared deliberately.

Two near-misses are worth recording so nobody re-derives them. The three
`@expo-google-fonts/ibm-plex-*` packages `src/ui/fonts.ts` imports are all
declared — but `expo export` also bundles
`@expo-google-fonts/material-symbols`, which is **not** ours and not a fourth
miss: it arrives as a dependency of `expo-symbols`, itself pulled in under
`expo-router`. And the first pass of the sweep script missed
`require.resolve(…)` and `jest.mock(…)` call forms entirely, reporting 10 names
instead of 12; both recovered names turned out to be declared, but the count was
wrong until an independent `rg` pass over the same nine files listed every
quoted string and disagreed with it. When a sweep's whole value is its
exhaustiveness, run it twice by two instruments.

### What guards it now

`apps/mobile/src/release/release-config.test.ts` gained
`describe("babel toolchain declarations")`. It **calls** `babel.config.js`,
applies Babel's own name standardisation to every preset and plugin entry — so
`expo`, `@babel/typescript` and `@acme/thing` are compared as
`babel-preset-expo`, `@babel/preset-typescript` and `@acme/babel-preset-thing` —
and asserts each resulting package name is declared in
`apps/mobile/package.json`. It derives the names rather than pinning
`babel-preset-expo`, because the preset added next year is the one it is really
for. It carries a non-vacuity floor, in the shape this file already uses for the
workflow sweep.

Proven by mutation, four ways:

| Mutation | Result |
|---|---|
| declaration deleted from `package.json` | red — `["babel-preset-expo"]` |
| `presets: ["expo"]` shorthand, declaration present | green — standardisation works |
| `presets: ["expo"]` shorthand, declaration deleted | red — `["babel-preset-expo"]` |
| `presets: [require.resolve("babel-preset-expo")]` | red — the non-vacuity floor fires |

The last one is the interesting one: an absolute path is exactly the "fix"
somebody reaches for when a preset will not resolve, and it would silently
re-hide the dependency. The floor catches it.

A fifth mutation — emptying the preset list — is absent from the table because it
cannot be measured here: with no preset, Babel cannot transform the test files at
all and the runner reports `Tests: 0 total` before any assertion runs. That is
loud enough, but it is not this test catching it.

### If you hit `MODULE_NOT_FOUND` in a Metro phase

1. The message names a package. Check `apps/mobile/package.json` for it first —
   not `node_modules`, which will happily contain it either way.
2. Reproduce the strict environment locally, from `apps/mobile`:
   `NODE_PATH= node node_modules/expo/bin/cli export --platform android`. That
   bypasses the shim and is the closest thing to what Gradle does. Note you
   cannot get there by setting `NODE_PATH` in the environment — the shim
   overwrites an empty value and prepends to a non-empty one; you have to skip
   the shim.
3. If it reproduces, declare the package at the version the SDK already
   resolves — read it out of the depending package's `package.json`, not out of
   `expo install`'s floor — and confirm the lockfile moved by one importer entry.
4. Sweep the rest of the config surface before moving on.

---

## The fourth failure — a C++ compiler, nine and a half minutes in

Build `9bdab7b8-b5e2-4aa5-8272-f8e990c0cce3` (2026-08-27, production, commit
`d3237b654`, `versionCode` 4) got further than any before it. The fingerprint
matched, `Configure expo-updates` passed, Metro bundled the whole app, Gradle
started compiling native code, and 9m32s in:

```
> Task :expo-modules-core:buildCMakeRelWithDebInfo[arm64-v8a] FAILED
expo-modules-core@57.0.14/android/src/main/cpp/worklets/WorkletJSCallInvoker.cpp:27:21:
  error: no member named 'executeSync' in 'worklets::WorkletRuntime'
   27 |     workletRuntime->executeSync([func = std::move(func)](jsi::Runtime &rt) -> jsi::Value {
      |     ~~~~~~~~~~~~~~~~^
1 error generated.
ninja: build stopped: subcommand failed.
```

### The method exists, in a version this tree did not have

Measured, not inferred — both tarballs unpacked and the one header compared:

| `react-native-worklets` | `Common/cpp/worklets/WorkletRuntime/WorkletRuntime.h` |
|---|---|
| `0.10.1` | `jsi::Value executeSync(...)`, three overloads |
| `0.12.1` | no `executeSync` — the same operation is `runSync` / `runSyncAndDrainMicrotasks` |

`expo-modules-core@57.0.14` calls `executeSync`. The tree had worklets `0.12.1`.
That is the whole defect.

### Nobody chose 0.12.1, and nobody could have

`react-native-worklets` is **not declared anywhere in this repository** — not in
`apps/mobile/package.json`, not in the root one. Neither is
`react-native-reanimated`, and neither is `react-native-gesture-handler`. All
three arrive as auto-installed OPTIONAL PEERS, down a chain nobody wrote:

```
expo-router@57.0.17   peer  react-native-reanimated: '*'        (optional)
  react-native-reanimated@4.6.0   peer  react-native-worklets: 0.12.x
    react-native-worklets@0.12.1
```

pnpm's `auto-install-peers` is on by default and there is no `.npmrc` in this
repo, so each of those `*` peers resolved to `latest`. Nothing in the workspace
narrowed them, and `expo-modules-core`'s own peer range — which is
`^0.7.4 || ^0.8.0 || ^0.9.0 || ^0.10.0`, i.e. flatly excludes 0.12 — lost,
because it is declared `optional: true` and pnpm hands an optional peer whatever
the parent already resolved.

**That range is identical in 57.0.13 and 57.0.14**, checked against the registry.
So the dependency bump earlier in this saga did not move the declaration; it
moved the C++ that the declaration was always describing. The tree had been
wrong since before any build ran — it simply had not compiled native code yet.

### The authority used, and why it is this one

Expo ships `expo/bundledNativeModules.json`: the table `expo install` writes
versions from and `expo-doctor` validates declared versions against. Read out of
the installed `expo@57.0.17`:

```
react-native-worklets        => 0.10.1
react-native-reanimated      => 4.5.1
react-native-gesture-handler => ~2.32.0
expo-modules-core            => ~57.0.14
```

Consistent all the way down: reanimated `4.5.1` peers `react-native-worklets:
0.10.x`, worklets `0.10.1` peers `react-native: 0.83 - 0.86` (satisfied by
0.86.3), and `^0.10.0` is inside `expo-modules-core`'s range. The pair that was
installed — worklets `0.12.1` with reanimated `4.6.0` — is consistent only with
itself.

So all three are now declared in `apps/mobile/package.json` at the SDK's own
numbers. Same rule the `babel-preset-expo` section above landed on: **declare it
at the version the SDK already resolves, read out of the SDK's declaration and
not out of `expo install`'s floor.**

### The full sweep, because one drifted package is an incident and three is a shape

`bundledNativeModules.json` names 123 packages. **35 of them resolve into this
workspace; 30 matched the SDK's pin and 5 did not.** In full:

| Package | SDK 57 pins | Was resolved | Declared? |
|---|---|---|---|
| `react-native-worklets` | `0.10.1` | `0.12.1` | no |
| `react-native-reanimated` | `4.5.1` | `4.6.0` | no |
| `react-native-gesture-handler` | `~2.32.0` | `3.2.1` | no |
| `react` | `19.2.3` | `19.2.3` **and** `19.2.6` | yes, at `19.2.3` |
| `react-dom` | `19.2.3` | `19.2.6` | no |

The last two are the WEB app's and are not a native drift: `apps/mobile` declares
React at the pin exactly and Next.js resolves its own copy, and `react-dom` is
`expo-router`'s optional web peer, never autolinked and never compiled into an
`.aab`. The first three are the shape — **every drifting native module was
undeclared, and every declared one was correct.** That is not a coincidence, it
is the mechanism: `expo install --check` and `expo-doctor` both validate
DECLARED versions against this same table, which is exactly why both reported
"Dependencies are up to date" and 21/21 while three native modules sat past the
pin. Declaring a package is what makes it visible to the tools that check it —
and both tools say the same words after the fix, except that now the sentence
covers the three packages that mattered.

Only `react-native-worklets` could have produced THIS error. The other two were
fixed in the same commit because they are the same defect one build away:
gesture-handler was a full major ahead of the version SDK 57 was built against,
and a failed build costs a `versionCode` nobody gets back.

### It removed a second Metro nobody knew was there

The lockfile moved by **26 resolutions dropped and 10 added** — 33 packages
beyond the three that were the point. Every one of them is downstream of
worklets:

- **22 dropped, one island**: `metro@0.87.0` plus 13 `metro-*@0.87.0`,
  `ob1@0.87.0`, six `@react-native/*@0.87.0` (`babel-preset`,
  `babel-plugin-codegen`, `codegen`, `js-polyfills`, `metro-babel-transformer`,
  `metro-config`), `image-size@1.2.1` and `queue@6.0.2`.
  `react-native-worklets@0.12.1` peers `@react-native/metro-config: '*'`, which
  resolved to `0.87.0` — ahead of react-native `0.86.3`'s own — and dragged the
  entire Metro 0.87 tree in beside the `metro@0.84.5` this app actually bundles
  with. **The tree held two Metros.** It now holds one.
- **4 dropped, 3 added, gesture-handler's own dependency shape**: v3 dropped
  `@egjs/hammerjs`, `@types/hammerjs`, `hoist-non-react-statics` and
  `react-is@16.13.1`; v2.32.0 needs them.
- **3 added**: `@react-native/babel-preset`, `@react-native/metro-babel-transformer`
  and `@react-native/metro-config`, all at `0.86.3` — the 0.87.0 trio
  deduplicating onto react-native's own version.

Net: 44 packages added, 60 removed. A dependency fix that makes the tree
**smaller and more internally consistent** is the shape a correct one has; the
"two Babel presets compiling the same app" hazard the previous section warned
about was already here, one layer down, as two Metros.

### What could have caught it, and the answer is not "nothing"

It is tempting to write this one off as unobservable, and the tempting version is
half true: **there is no Android NDK on the machines this repo builds on, and
`expo export` only bundles JavaScript, so that C++ compiler never runs here.**
The error itself cannot be reproduced locally today and it would be dishonest to
imply otherwise.

But the error is not the defect. The defect is a native module resolved outside
the SDK's own pin, and **`pnpm peers check` named it — by package, by range, and
by the package that wanted it.** Measured by restoring the pre-fix
`package.json` and lockfile and reinstalling:

```
$ pnpm peers check          # BEFORE — 4 unmet peers
X unmet peer react-native-worklets
  Installed: 0.12.1
  Wanted:
    "^0.7.4 || ^0.8.0 || ^0.9.0 || ^0.10.0":
      expo-modules-core@57.0.14

X unmet peer @react-native/metro-config
  Installed: 0.87.0
  Wanted:
    0.86.3:
      @react-native/community-cli-plugin@0.86.3
```

```
$ pnpm peers check          # AFTER — 2 unmet peers, neither native
X unmet peer @react-native/jest-preset   (0.86.2 installed, jest-expo wants ^0.86.3)
X unmet peer react                       (19.2.3 installed, react-dom@19.2.6 wants ^19.2.6)
```

Both of the two that vanished are this failure: the first IS the C++ error stated
in npm's own vocabulary, and the second is the second Metro. Both remaining ones
are pre-existing, JavaScript-only, and touch nothing a native build compiles.

So the honest answer to "was there a local signal" is **yes, on every single
`pnpm install`, for free** — and it was collapsed into one line nobody expanded:

```
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.
```

That line was printed by the install that produced the tree this build failed on.
Three of the four failures in this saga are "something the local environment
resolves by accident that the worker does not". This one is worse and better at
the same time: the local environment did NOT resolve it by accident. It said so
out loud, and the summary was mistaken for noise.

### What guards it now

`apps/mobile/src/release/release-config.test.ts` gained
`describe("SDK-pinned native modules")`. It reads
`expo/bundledNativeModules.json` through `require.resolve` — so it is always the
table belonging to the resolved `expo` — and the `packages:` section of
`pnpm-lock.yaml`, and asserts every resolution of every bundled name satisfies
the SDK's pin.

**The lockfile and not `node_modules`, deliberately.** Under pnpm a package
nothing declares is invisible from `apps/mobile` — which is precisely the class
of package this exists to judge — while the lockfile lists every resolution in
the workspace whether or not anything can reach it by name. A fence over
declarations would have agreed with `expo-doctor` and reported green.

It carries no semver dependency: `~`, `^` and exact are the only three shapes the
table uses, they are implemented in eight lines, and **any other shape throws**
rather than being skipped. It carries the non-vacuity floor this repo's fences
use (at least 20 of the table's names must have been checked; 35 resolve today).
The two exemptions are `react` and `react-dom`, named with their reason, and the
second `it` asserts that whatever `apps/mobile` itself declares for an exempt
name still matches the pin — so the exemption cannot widen into "React is never
checked".

Proven by mutation, four ways:

| Mutation | Result |
|---|---|
| `react-native-worklets@0.10.1` restored to `0.12.1` in the lockfile | red — `"react-native-worklets@0.12.1 — SDK 57 pins 0.10.1"` |
| `packages:` renamed so the parse finds nothing | red — the floor fires (`Expected >= 20, Received 0`) |
| a pin shape the reader does not know | red — `Unreadable version pin` |
| an exempt name that is not in the table | red — the exemption's own non-vacuity check |

The first mutation is the real one: it reproduces exactly the tree that burned
`versionCode` 4, and the fence names the package and the number in one line, in
under five milliseconds, with no NDK anywhere.

### If a native compile fails on a symbol that "should" exist

1. The error names a class or method (`worklets::WorkletRuntime::executeSync`).
   The owner of the C++ that CALLS it and the owner of the header that should
   DEFINE it are two different packages. Find both.
2. Run `pnpm peers check` before anything else. It is free, it is local, and in
   this case it printed the answer.
3. Compare the defining package against `expo/bundledNativeModules.json` — the
   SDK's pin, not npm's `latest` and not `expo install`'s floor.
4. If it is not in `apps/mobile/package.json`, that is the bug. An undeclared
   package resolves to whatever the peer graph happens to want, and nothing that
   validates versions in this repo looks at it.
5. Fix the whole class, not the one that failed. Three native modules had
   drifted; one had compiled.

---

## The fifth failure — a `catch` block that never runs, and the tester round that stalled behind it

Build 7 (`4a4f4dac-9bc3-4986-a5d2-25a083840c83`, commit `d9c03dab3`, profile
`production`) ended `errored` with no artifact, and nobody noticed for a day.
That delay is the expensive part of this entry, so it goes first: **build 6 was
still the newest artifact, and build 6 cannot log anyone in.** It predates the
"env in the profiles" change, so it carries no `EXPO_PUBLIC_SUPABASE_URL`;
`authPlaneConfigured()` (`src/config/api.ts`) requires the URL *and* the anon
key, returns false, and `useGate.tsx` tells the tester to go complain to
whoever sent them the app. The native round was not running slowly. It was
stopped, and the dashboard was the only place that said so.

### What actually failed

```
> Task :app:createBundleReleaseJsAndAssets_SentryUpload_ar.mimar.app@0.0.1+7_7 FAILED

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:createBundleReleaseJsAndAssets_SentryUpload_…'.
> A problem occurred starting process 'command
  '/home/expo/workingdir/build/apps/mobile/node_modules/@sentry/cli/bin/sentry-cli''
```

Gradle is not reporting that `sentry-cli` ran and returned non-zero. It is
reporting that it could not **start** it. The path does not exist. Under pnpm
it never did.

### Why the path is wrong, and why the guard against that is dead code

`@sentry/react-native`'s `sentry.gradle` locates the CLI in
`resolveSentryCliPackagePath()`:

```groovy
def resolvedCliPath = null
try {
    resolvedCliPath = new File(["node", "--print",
        "require.resolve('@sentry/cli/package.json')"].execute(null, rootDir).text.trim())
        .getParentFile();
} catch (Throwable ignored) {   // ← the pnpm fallback lives in here
    …reads NODE_PATH out of node_modules/@sentry/react-native/node_modules/.bin/sentry-cli…
}
def cliPackage = resolvedCliPath != null && resolvedCliPath.exists()
    ? resolvedCliPath.getAbsolutePath()
    : "$reactRoot/node_modules/@sentry/cli"
```

Two independent things have to go wrong together, and both do:

1. **`require.resolve` genuinely fails here.** `@sentry/cli` is a TRANSITIVE
   dependency — `@sentry/react-native` declares it, this workspace did not — so
   pnpm's isolated layout puts it in `node_modules/.pnpm/@sentry+cli@2.58.4/…`
   and links it only where a declared dependent can see it. It is not
   resolvable from `apps/mobile/android`, which is the `rootDir` that `execute`
   is handed.
2. **The `catch` that exists to handle exactly this NEVER RUNS.** Groovy's
   `execute()` does not throw when the child exits non-zero; it returns a
   `Process` whose `.text` is the empty stdout. So `new File("").getParentFile()`
   yields `null`, no `Throwable` is ever constructed, and the carefully written
   pnpm branch is unreachable. Control falls to the ternary, `resolvedCliPath`
   is null, and `cliPackage` becomes the flat-`node_modules` guess
   `$reactRoot/node_modules/@sentry/cli` — which is the path in the error.

A failure the library anticipated, wrote a fallback for, and then could not
reach. Worth remembering the shape: **a `try/catch` around a call that reports
failure by return value instead of by exception is not a guard, it is
decoration.**

### Why it fired now and not in build 6

Sentry entered the tree on 2026-09-01 in `6939838cb`, **after** build 6
(`47189da6f`, 2026-08-27). Build 7 is the first build that carried it at all.

But carrying Sentry was not sufficient either, and this is the part that makes
the timing look mysterious until you see it. `app.config.ts` used to state, as
settled fact, that the upload was inert:

> …which also needs a `SENTRY_AUTH_TOKEN` that EAS does not hold yet — the
> plugin skips upload with a warning when the token is absent…

That stopped being true when the token was added to the `production` and
`preview` EAS environments. Adding a secret is not usually thought of as a code
change, and it is not usually reviewed like one — but it is what switched the
upload task on and walked the build straight into a path bug that had been
sitting there, harmless and invisible, since the day pnpm and `@sentry/cli` met.
**A comment describing a configuration is a claim with an expiry date, and
nothing in the build tells you when it expired.**

### The fix, and why it is a dependency rather than a patch

`apps/mobile/package.json` now declares:

```json
"@sentry/cli": "2.58.4",
```

pinned to the **exact** version `@sentry/react-native@7.11.0` already pins, so
pnpm links the same store entry rather than resolving a second copy — the
lockfile diff is five lines and nothing is downloaded. The point is not that
the app needs the CLI at runtime; it does not. The point is that declaring it
makes pnpm create `apps/mobile/node_modules/@sentry/cli`, which is *precisely
the path Gradle already guesses*. The library's broken resolver stops mattering
because its fallback becomes correct.

Three alternatives were considered and rejected:

| Alternative | Why not |
|---|---|
| Pin `cli.executable` in `android/sentry.properties` | `apps/mobile/android/` is gitignored (`apps/mobile/.gitignore:42`) and regenerated by prebuild on every EAS run. Anything written there is erased before Gradle reads it. And the real path contains a pnpm content hash that differs per platform and per lockfile change — pinning it would break on the next `pnpm install`. |
| `SENTRY_DISABLE_AUTO_UPLOAD=true` on EAS | Works in one minute and throws away the reason Sentry was wired. Crash reports from testers arrive with minified frames, which is the state the D2 handback set out to leave behind. A shortcut that removes the feature is not a fix for the feature. |
| Patch `sentry.gradle` via a patch file | Correct diagnosis, wrong leverage. It pins us to one upstream version, silently rots on the next bump, and the one-line dependency gets the same result without owning a fork of someone else's build script. |

### What guards it now

Nothing automated, and that should be stated plainly rather than implied. No
local gate can see this: `pnpm verify` and `pnpm test:verified` never invoke
Gradle, and the failure needs a real EAS worker with a real pnpm store to
reproduce. The guard is the comment block above `plugins:` in `app.config.ts`,
which now says why the dependency exists and what removing it breaks — a
tidy-up commit that deletes an "unused" dependency is the exact way this
regresses.

### If a Gradle task fails with "A problem occurred starting process"

1. Read the **path in the quotes**, not the task name. Gradle is telling you it
   could not exec that file, and the overwhelmingly common reason is that the
   file is not there.
2. Check whether the package is a DIRECT dependency of the workspace whose
   `node_modules` the path names. Under pnpm, transitive packages are not in a
   sibling's `node_modules`, and any tool that builds a path by string
   concatenation assumes they are.
3. If a third-party build script "supports pnpm", read the support. In this
   case it existed, was correct, and was unreachable.
4. Ask what changed OUTSIDE the repo. Build 7's diff does not contain this bug.
   An environment variable added on a dashboard does.

### Reading an EAS build log without the dashboard

`eas build:list --platform android --limit 8 --json` gives the status, profile,
commit and `error.errorCode` per build, and `logFiles[0]` is a signed URL to the
full worker log. Two things about that file cost time on 2026-09-03 and are
worth writing down:

- **It is brotli, not gzip.** `gunzip` says `not in gzip format` and `file`
  gives nothing useful; `zlib.brotliDecompressSync` reads it.
- **It is newline-delimited JSON**, one object per line with `phase`, `msg` and
  `time`. Grep against the raw file works, but parsing the lines and filtering
  on `phase` is what makes the `SPIN_UP_BUILDER` env dump and the `RUN_GRADLEW`
  failure legible next to each other.

That dump is also how the OTHER suspect was cleared without a build: build 7's
`SPIN_UP_BUILDER` phase lists `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_API_BASE_URL` all injected
correctly. The env was never the problem. One failure, one cause — and the
handoff note that suspected the env was reasoning from build 6's symptom, which
is a different build with a different disease.

Note while you are in there: `eas env:list` takes the environment as a
POSITIONAL argument (`eas env:list production`), and `--non-interactive` is not
one of its flags.

---

## The Play warning about a deobfuscation file, and why there is nothing to upload

The upload of `94ab653c…` produced exactly one warning:

> There is no deobfuscation file associated with this App Bundle.

The tempting reading — the one this section exists to refuse — is: *Android
release builds run R8, so the stack trace in a tester's crash report is minified,
so we must start uploading `mapping.txt`.* Every clause of that is true of a
generic Android project and the **first one is false here**, which makes the rest
of it a pipeline nobody needs.

### This app does not minify, and the default is not Android's

`minifyEnabled` for the release build type is not AGP's default in this project;
it is a property Expo's prebuild template reads, and the template defaults it
OFF. From the template EAS unpacks — `expo@57.0.17`'s own `template.tgz`,
`package/android/app/build.gradle`:

```groovy
/**
 * Set this to true in release builds to optimize the app using [R8](…).
 */
def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()
…
        release {
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
```

`?: false` is the whole answer, provided nothing sets the property. Nothing does,
and the check is one sweep rather than a claim:

```
$ rg --hidden --sort path -n \
    'enableMinifyInReleaseBuilds|enableProguardInReleaseBuilds|enableShrinkResourcesInReleaseBuilds|expo-build-properties|minifyEnabled' \
    --glob '!node_modules' .
docs/mobile/ota-policy.md:123:- The build settings a plugin writes — `expo-build-properties`, a
```

One hit, and it is prose. The other two places that could have set it are empty
for structural reasons this file already documents: the template's own
`package/android/gradle.properties` never mentions the property (extract it with
`tar -xzOf …/expo/template.tgz package/android/gradle.properties` and read it —
`hermesEnabled`, `newArchEnabled` and `reactNativeArchitectures` are there;
`android.enableMinifyInReleaseBuilds` is not), and there is no
`apps/mobile/android/` to hand-edit, because EAS prebuilds it on the worker and
`apps/mobile/.gitignore` keeps it out of the fingerprint
([Cause 2](#cause-2--eas-prebuilds-android-and-nothing-was-ignoring-it)).
`app.json` loads no `expo-build-properties` plugin either.

So R8 never runs, **no `mapping.txt` is ever produced**, and there is nothing to
upload. The warning is accurate, expected, and cosmetic: Play is reporting the
absence of a file that does not exist, and the Java/Kotlin frames it would have
deobfuscated are already carrying their real names.

### There was never an `eas.json` line to add, in either world

This matters because "one `eas.json` setting" is the shape the fix was expected
to take, and it does not exist on either branch of the question.

With minification off there is no map to upload. With minification **on**, there
is still nothing to configure: since AGP 4.1 a minified App Bundle carries its
own map inside the artifact, at
`BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map`, and Play
reads it from there — the mapping travels *with* the `.aab` rather than beside
it. That second half is **read from AGP's contract and not measured here**: this
repo has never produced a minified bundle to open, and until it does, the claim
carries the same status as everything else in this file marked that way.

The load-bearing conclusion does not depend on it. Even if the AGP behaviour were
different, the first half stands on its own: with `minifyEnabled false` there is
no input to any upload mechanism.

### What was rejected

| Option | Why not |
|---|---|
| Add a mapping-upload setting to `eas.json` | No such setting, and no file for it to carry — see above. |
| Turn minification on so a map exists | It buys readable Java frames that are *already* readable, and it is not free: it changes the native build inputs, so it moves the `runtimeVersion` fingerprint and orphans every installed build from the next OTA (`app.config.ts`), and finding out costs a `versionCode`. If it is ever done it must be done as a size/performance decision with its own measurement, not as a way to silence a warning. |
| Build and upload a mapping by hand | There is nothing to build one from. |

### The gap the warning does NOT name, and it is the one a tester will hit

`mapping.txt` maps **Java and Kotlin**. The crash a tester of a React Native app
is most likely to produce is a **JavaScript** one, and no deobfuscation file has
ever had anything to say about those. Two measurements on the shipping bundle,
so that nobody assumes the JS side is fine just because this section closed the
Java side:

**1. Function names survive the bundle only sometimes.** Against
`apps/mobile/dist/_expo/static/js/android/entry-….hbc` — the Hermes bytecode
`pnpm -C apps/mobile export` produces — six plain, non-exported, non-component
local functions from this app's source were searched for by name, with a
nonexistent name as the negative control:

```
sessionEndingReason    -> 1        modulesToPath          -> 0
applyMeResult          -> 1        unreadableWeight       -> 0
pressedOpacity         -> 1        formatIsoDateTime      -> 0
zzzNotARealSymbolXYZ   -> 0   ← negative control
```

Three of six are present verbatim. Non-exported and non-component was the point
of the sample: an exported name survives as an object property key whatever the
minifier does to the function, so it would have proved nothing. **What this does
not settle is which layer decides** — inlining and mangling both produce a
missing name and this measurement cannot tell them apart. What it settles is the
only thing this section needs: a JS frame may or may not carry a real name, and
`mapping.txt` has no bearing on either outcome.

**2. No source map ships inside the bundle.** `find dist -name '*.map'` returns
nothing; `dist/_expo/static/js/android/` holds exactly one file, the `.hbc`. So a
JS frame that *does* carry a name still carries no file and no line *on the
device*.

> **Superseded, and kept so the history reads true.** When this section was
> measured, `rg 'sentry|bugsnag|crashlytics|firebase'` over the package
> manifests returned nothing and the paragraph said "there is no reporter". That
> is no longer the case: **the app ships Sentry** (`@sentry/react-native`,
> entered in `6939838cb` on 2026-09-01). The config plugin wires the native crash
> layer at prebuild, `src/observability/sentry.ts` initialises the JS side when
> the build carries a DSN (`extra.sentryDsn` in `app.config.ts`), and EAS
> `production`/`preview` builds upload the source maps to Sentry rather than
> into the bundle — see the build-7 section above for why `@sentry/cli` is a
> direct dependency. What a report may contain is governed by
> `src/observability/redact.ts`, which scrubs personal data before an event
> leaves the phone.

**It is written down here, in the section about the warning, precisely so that
"we handled the deobfuscation warning" is never mistaken for "we can read a
tester's crash"** — the second is Sentry's job, not R8's.
