# OTA updates — hotfixes only

> **PO decision 5.** Over-the-air updates are not a release channel for this
> app. They are a way to un-break a build that is already installed, between
> store releases. Everything below follows from that one sentence.
>
> Governing document for `eas update`. The keys it describes live in
> `apps/mobile/app.config.ts` (`updates`, `runtimeVersion`) and
> `apps/mobile/eas.json` (`channel`, per build profile).

**Status as of 2026-08-26: nothing has been published.** `npx eas-cli whoami`
now answers the maintainer's Expo account and one
production build has been attempted — it failed on the fingerprint check, see
[eas-build-profiles.md](./eas-build-profiles.md) — but no `eas update` has run.
No channel, no update and no runtime version exists on the server. This document
describes the rules the first update will be held to, not a mechanism anyone
here has watched run.

---

## What OTA actually replaces

The JavaScript bundle, and nothing else. The compiled native binary — the
Android/iOS app with its linked native modules, its permissions, its icon, its
intent filters — is fixed at build time and only a store release replaces it.

That asymmetry is the whole subject. Everything that makes OTA useful and
everything that makes it dangerous is downstream of "the JS moved and the native
runtime did not".

---

## Why it is fenced to hotfixes

Four reasons, and only the first is technical.

### 1. A JS bundle can call into a native runtime that isn't there

Ship JS that reaches for a native module the installed binary does not contain
and the app does not degrade — it crashes on launch, on every phone that took
the update. The fix cannot itself be shipped over the air, because the app that
would download it is the app that crashes before it gets that far.

**This one is mechanically fenced.** `runtimeVersion: { policy: "fingerprint" }`
hashes the things that determine the native runtime, and expo-updates refuses to
serve an update to a build whose fingerprint differs. A native change therefore
becomes an update that reaches *zero* devices instead of a crash that reaches
all of them. The full reasoning, and the cost of the fingerprint policy, is in
the header of `apps/mobile/app.config.ts`.

The other three reasons have no fence. They are why this document exists.

### 2. An update the store review never saw is still an update the store review never saw

Both stores permit JavaScript updates to an already-reviewed app. Neither
permits using that to change what the app *is* — Apple's guidelines and Google's
Device and Network Abuse policy both reserve the right to treat a materially
different app as an unreviewed one. The line is not "did you change native
code"; it is "would the reviewer have needed to see this".

A feature shipped over the air is exactly the thing that line is drawn around.
And the consequence of being wrong is not a rejected update — it is a suspended
listing, which takes the whole app down for everyone, including the people who
never got the update.

### 3. The version number stops identifying the behaviour

This project's default posture is that the tree is the record. Once OTA is a
release channel, "I'm on 0.0.1" no longer answers what a user is running:
0.0.1 with the store bundle, 0.0.1 with hotfix A, and 0.0.1 with hotfix B are
three different programs wearing one number. Every bug report, every support
conversation and every "works on my phone" gets an extra unknown in it,
permanently.

Fenced to hotfixes, the damage is bounded: the difference between a store
artifact and what is running is always a small, listed, deliberately-recorded
set of fixes — and the *next* store release erases it.

### 4. The fleet becomes heterogeneous, and you cannot make it homogeneous again

An update reaches a device when that device next opens the app and has a
network. There is no push, no deadline and no way to make everyone take it.
Ship an OTA change that assumes a server contract, and the server must keep
serving *both* contracts for as long as any un-updated install exists — which is
forever, because "the user who opened it once in March" never checks in again.

---

## What may go out over the air

A **hotfix**: a JS-only change that makes an already-shipped build stop being
wrong, and adds nothing.

- A crash or an incorrect result in JS-only code — a view model, a parser, a
  formatter, a guard.
- Copy that is wrong in a way that matters: a wrong phone number on the lost
  poster, a mislabelled dose, a screen that tells the user the opposite of what
  the system did.
- A hardcoded endpoint or constant that changed underneath the app.
- A client-side guard that is wrong **in the direction of exposure** — showing
  something to someone who should not see it.

The test is subtractive, and it is one question: **after this update, can the
app do anything it could not do before?** If yes, it is not a hotfix.

---

## What may never go out over the air

### Anything that changes the native runtime

Mechanically blocked by the fingerprint policy, listed here anyway because
knowing *why* an update reached nobody should not require reading a hash:

- Adding, removing or upgrading a native module (`expo-*`, any library with
  native code).
- Bumping the Expo SDK or React Native.
- Any config-plugin change, or any `app.json` / `app.config.ts` change that
  feeds prebuild.
- Permissions, the app icon, the adaptive icon, the splash screen.
- The URL scheme, intent filters, associated domains — including the verified
  App Links work that M5 is waiting on.
- The build settings a plugin writes — `expo-build-properties`, a
  `minSdkVersion` bump, anything else that changes how the binary is compiled.
  `newArchEnabled` used to be the example on this line; SDK 57 removed the key
  from the config schema entirely, because the New Architecture stopped being
  optional. It was still sitting in `app.json` on 2026-08-26 and failed the
  build's own config-schema check — see docs/mobile/eas-build-profiles.md.

### Anything the store review would have needed to see

Not fenced by anything. This is the list that requires judgement, so it is
written down before it is needed:

- **A new feature, or a new user-facing surface.** A new screen, a new tab, a
  new action on an existing screen. Even one that is "small".
- **A change to what data is collected, transmitted or stored**, or to where it
  goes. This app handles DNI-derived identity and custody records; the Play Data
  Safety form and the App Privacy declaration are review artifacts, and a change
  that makes them wrong is a change the review needed to see.
- **A change to the app's stated purpose, content or audience.**
- **Anything that would change the answer on a store questionnaire** — payments,
  ads, user-generated content, location background use, account deletion.
- **Anything the PO would want to announce.** If it is worth telling users
  about, it is worth a release.

### Anything that assumes a server contract not already deployed

Because of reason 4 above. The server must be compatible with the *oldest*
install that still opens, not with the newest bundle. An OTA that requires a
server change ships after the server change, never with it.

---

## Channels

One channel per build profile, named after it. Declared in `eas.json`, never in
the app config — an app-config channel would apply to every build and collapse
the separation this table exists to create.

| Channel | Reaches | Used for |
|---|---|---|
| `development` | The PO's dev build | Nothing. A dev client loads from Metro; updates are irrelevant to it. |
| `preview` | The 12 testers' APKs | **Every hotfix, first.** This is the rehearsal. |
| `production` | Play installs | The same hotfix, after `preview` confirmed it. |

---

## Procedure

An `eas update --channel production` reaches real installs and cannot be
recalled from a device that already took it. That puts it in the same class as a
production migration: **an agent prepares it; Ignacio presses the button.**

1. **The fix lands normally.** Through the branch, through `pnpm verify` and
   `pnpm test:verified`, through review. There is no "OTA-only" code path and no
   patch that exists solely on a channel — an update that is not in the tree is
   an update nobody can find later.
2. **Prove it is JS-only.** `eas fingerprint:compare` against the build being
   patched. Do not infer it from the diff; the fingerprint covers things a diff
   does not obviously touch. If the fingerprints differ, this is not a hotfix,
   and publishing it would silently reach nobody.
3. **Prove the bundle points at the right backend.** Export it and read the
   emitted JavaScript. See "Why the export step exists" below — the fingerprint
   does *not* cover this, and the failure is silent.

   ```bash
   # From apps/mobile, with the SAME environment the publish will use.
   npx expo export --platform android --output-dir /tmp/ota-check
   rg -l "dim-staging\.vercel\.app" /tmp/ota-check   # must print NOTHING for production
   rg -o "https://[a-z0-9.-]*mimar[a-z0-9.-]*" /tmp/ota-check --no-filename | sort -u
   ```

   The first search must find nothing before a `production` publish. The second
   is the positive control: it must print the production origin, so "found
   nothing" is a fact about the bundle rather than about the search.
4. **Confirm it is subtractive.** Ask the one question from "What may go out"
   above, out loud, and answer it in the update message.
5. **`eas update --channel preview`**, with a message carrying the commit sha
   and one line of what it fixes. Install on a device, open it twice — see
   `fallbackToCacheTimeout` below for why twice — and confirm.
6. **`eas update --channel production --environment production`**, same message.
   Ignacio-gated. The `--environment` flag is not optional: it is what decides
   which `EXPO_PUBLIC_*` values get inlined, and step 3 is what proves it worked.
7. **The next store release must contain the same commit.** An OTA is never the
   final home of a fix; it is a bridge to the release that carries it properly.
   A hotfix that is still only on a channel three releases later is a fork.

### Why the export step exists

`eas update` **re-inlines every `EXPO_PUBLIC_*` variable** — it does not reuse
the values the installed binary was built with. Under Expo these are substituted
by babel as literals at bundle time (see the header of
`apps/mobile/src/config/api.ts`), so the origin the app talks to is baked into
the JavaScript an update ships, and an update published from an environment that
does not define them takes the code's fallbacks instead.

That matters here because the fallbacks are not neutral:

- `API_BASE_URL` falls back to **`https://dim-staging.vercel.app`** — so a
  production OTA published without `EXPO_PUBLIC_API_BASE_URL` silently repoints
  the whole fleet's data plane at staging.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` have **no fallback at all**, so the same
  publish leaves `authPlaneConfigured()` false and nobody can refresh a session.

**Neither is covered by anything already in this list.** `eas fingerprint:compare`
hashes what determines the NATIVE runtime; env inlining is JavaScript, so a
bundle pointed at the wrong backend has an identical fingerprint and publishes
cleanly. And the failure is silent on the device: the app starts, the screens
render, and the data is somebody else's.

`eas env:list --environment production` answers a different question — what the
project HAS — and step 3 answers the one that matters: what this bundle GOT.
Read the artifact, not the configuration.

### Why "open it twice"

`fallbackToCacheTimeout: 0` means the app never blocks its launch waiting on the
update server. It downloads in the background and applies on the *next* launch.
So a published hotfix reaches a user on their second open after publication, and
a tester who opens the app once and sees the old behaviour has not found a bug.

That trade — slower propagation, bought with a cold start that never waits on a
network the user may not have — is argued in `app.config.ts`.

---

## Rollback, and its limit

`eas update:republish` puts a previous update back at the head of a channel.
Devices pick it up the same way they picked up the bad one: next launch, next
launch after that to apply.

**The limit is the shape of the failure.** A device only checks in if the app
runs long enough to check in. expo-updates does carry an error-recovery path
that can fall back to the bundle embedded in the binary after a fatal launch
error, which is the mechanism that makes a bricked fleet survivable — but it is
recovery, not a guarantee, it does not cover every crash shape, and it has never
been exercised in this project.

Which is the real reason step 4 exists. `preview` is not a formality; it is the
only place a bad bundle is cheap.
