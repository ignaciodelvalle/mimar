// The Expo app config — deep-link seam (M5 placeholder).
//
// The static values live in `app.json`; Expo hands them to this file as
// `config` and takes what this returns. The split is not decoration: the ONE
// thing this layer adds is the deep-link declaration, and that declaration
// needs paragraphs of explanation that JSON cannot carry. Anything with no
// commentary to attach belongs in `app.json`.
//
// ---------------------------------------------------------------------------
// WHAT IS WIRED TODAY: THE CUSTOM SCHEME
// ---------------------------------------------------------------------------
// `mimar://` (declared in app.json, filtered below). It is enough for what M1
// through M4 need — an OAuth/Supabase redirect back into the app, and a link
// from the app to itself — and it needs no coordination with anyone: the app
// claims the scheme by installing.
//
// It is NOT enough for the thing this product actually wants, which is invariant
// #1: the pet IS the credential, and a `DIM-XXXX-XXXX` token resolves to a
// QR-verifiable page. Today scanning that QR opens the browser at
// `https://…/p/{token}`. A custom scheme cannot change that — no phone camera
// will follow `mimar://p/{token}` from a QR it finds in the street, and it must
// not: any app could have claimed the scheme.
//
// ---------------------------------------------------------------------------
// WHAT IS NOT WIRED, AND WHY IT CANNOT BE WIRED IN THIS WORK UNIT (M5)
// ---------------------------------------------------------------------------
// Verified App Links / Universal Links — the mechanism that lets the INSTALLED
// app open `https://mimar.ar/p/{token}` directly while everyone else still gets
// the web page. That is the correct end state for the QR, and it is blocked on
// something no code in this repo can produce:
//
//   Android needs `https://{domain}/.well-known/assetlinks.json` to publish the
//   SHA-256 fingerprint of the certificate the APK is signed with. Under Play
//   App Signing that key is Google's, not ours — the fingerprint only exists
//   after the app is uploaded to a Play console that does not exist yet. (The
//   EAS account does now — the first build ran on 2026-08-26 — but Play is a
//   separate enrolment and is still the blocker.) Publishing a fingerprint we
//   control instead would verify a build Play will never ship, and the link
//   would silently fall back to the browser on every real install: the failure
//   mode of App Links is not an error, it is a page that quietly opens in
//   Chrome.
//
//   iOS needs `https://{domain}/.well-known/apple-app-site-association` carrying
//   the Team ID, which likewise does not exist before the Apple enrolment.
//
// So M5 is: enrol, read the Play-signed fingerprint out of the console, serve
// both well-known files from the web app, THEN add the `autoVerify` filter
// below. Writing the filter first would ship a claim we cannot honour.
//
//   android: {
//     intentFilters: [
//       {
//         action: "VIEW",
//         autoVerify: true,                       // ← requires assetlinks.json
//         data: [{ scheme: "https", host: "mimar.ar", pathPrefix: "/p" }],
//         category: ["BROWSABLE", "DEFAULT"],
//       },
//     ],
//   },
//   ios: { associatedDomains: ["applinks:mimar.ar"] },   // ← requires Team ID
//
// The host is a placeholder too: the credential currently lives at
// `dim-staging.vercel.app`, and a verified link must point at the production
// domain, not at a preview host whose `.well-known` any Vercel deploy can move.
//
// ===========================================================================
// THE SECOND DECLARATION THAT NEEDS PARAGRAPHS: expo-updates
// ===========================================================================
// The header above says the ONE thing this layer adds is the deep-link
// declaration. That stopped being true here, and for the same reason: the
// update configuration is three keys whose meaning is entirely in what they
// FORBID, and JSON cannot say what a key forbids.
//
// THE POLICY, WHICH IS NOT "WE HAVE OTA NOW"
// ---------------------------------------------------------------------------
// Over-the-air updates are fenced to HOTFIXES by PO decision. OTA is not a
// release channel here; it is a way to un-break a build that is already on
// somebody's phone, between store releases. The full argument, the class of
// change that may never go out this way, and the procedure live in
// `docs/mobile/ota-policy.md`. Read it before running `eas update`.
//
// WHAT `runtimeVersion: { policy: "fingerprint" }` ACTUALLY DOES
// ---------------------------------------------------------------------------
// It is the only part of that policy that is a MECHANISM rather than a promise,
// and it is the reason this policy is enforceable at all.
//
// An OTA update replaces the JavaScript bundle. It cannot replace the native
// runtime that bundle runs against — the compiled Android/iOS binary with its
// linked native modules. Ship JS that calls into a native module the installed
// binary does not contain and the app does not degrade: it CRASHES, on launch,
// on every phone that took the update, and the fix cannot itself be shipped
// over the air because the broken build is the one that would have to download
// it. That is the failure mode OTA is famous for, and it bricks a fleet.
//
// `runtimeVersion` is the compatibility key: expo-updates only serves an update
// to a build whose runtime version matches. The `fingerprint` policy computes
// it by HASHING the things that determine the native runtime — the native
// dependency set, the config plugins, the app config that feeds prebuild. So:
//
//   Add expo-camera, change a plugin, bump the Expo SDK → the fingerprint
//   changes → the update is published under a runtime version no installed
//   build has → nobody receives it. The mistake becomes a delivery that reaches
//   zero devices instead of a crash that reaches all of them.
//
// The alternatives were considered and are worse HERE:
//
//   `appVersion` — ties the runtime version to `version` in app.json. Two
//       builds carrying THE SAME `version` but different native modules would
//       share a runtime version, so the crash above is fully available. (The
//       example used to name the literal `0.0.1`, which stopped being this
//       app's version the day the first store build was cut; a rationale that
//       cites a moving value ages into a lie. The argument never depended on
//       which string it was.) It only works if a
//       human remembers to bump `version` on every native change, which is the
//       same "a rule enforced by nobody" shape `appVersionSource: remote`
//       exists to get rid of (see docs/mobile/eas-build-profiles.md).
//   `nativeVersion` / a hand-written string — same class, more typing.
//
// The cost of `fingerprint` is real and worth stating: the runtime version is
// an opaque hash nobody can read, computed rather than declared, so "why did
// this phone not get the update?" is answered by `eas update:list` and
// `npx expo-updates fingerprint:generate`, not by looking at a file. It also
// means a change that is genuinely JS-only but happens to touch the config can
// silently orphan the fleet from a hotfix. That is the correct direction to
// fail in.
//
// AND ONE COST THAT WAS NOT ANTICIPATED, learned from the first real build
// (9900114a-c134-41cf-af38-6aaf789d2942, 2026-08-26, errored):
//
//   A fingerprint that hashes toolchain-generated paths is only reproducible
//   if the toolchain is pinned.
//
// @expo/fingerprint hashes the native dependency set BY PATH, and those paths
// run through `node_modules/.pnpm/<dir>`, whose names pnpm truncates at a
// length that DEFAULTS DIFFERENTLY PER PLATFORM (60 on Windows, 120 elsewhere).
// So the same lockfile fingerprinted to two different values on the PO's
// machine and on an EAS worker, and EAS — which recomputes the fingerprint and
// compares — refused the build. The pin now lives in `pnpm-workspace.yaml`
// (`virtualStoreDirMaxLength: 60`) and is part of this policy, not part of the
// package manager's configuration: change it and every installed build stops
// matching the next update. The same failure carried a second, unrelated cause
// in `apps/mobile/.gitignore`. Both are written up in
// docs/mobile/eas-build-profiles.md, "Two ways to break a fingerprint".
//
// WHY `fallbackToCacheTimeout: 0`, i.e. NEVER BLOCK THE LAUNCH
// ---------------------------------------------------------------------------
// The alternative is to hold the splash screen while the app asks the update
// server whether anything is new. That taxes 100% of cold starts — including
// every start on the 4G-in-a-veterinary-waiting-room network this app is
// actually used on — to make a rare hotfix arrive one launch sooner.
//
// With 0, the update downloads in the background and applies on the NEXT
// launch. A hotfix therefore reaches a user on their second open after
// publication. That is the trade, stated plainly: slower hotfix propagation,
// bought with a launch that never waits on a network it may not have.
//
// WHAT IS NOT HERE
// ---------------------------------------------------------------------------
// No `channel`. It is not an app-config value — each build profile in
// `eas.json` declares its own, and that is what keeps a preview update from
// reaching a production install. Writing one here would apply to every build.
//
// Nothing has been PUBLISHED. As of 2026-08-26 `npx eas-cli whoami` answers
// the maintainer's Expo account and one production build
// has been attempted — and failed, on the fingerprint check described above —
// so the project now exists on EAS, but no `eas update` has ever run: no
// channel and no runtime version has ever been served to anything. The
// `updates` block is still a declaration whose runtime half has never
// executed.

import { ANDROID_PACKAGE_NAME, IOS_BUNDLE_IDENTIFIER } from "@dim/contract/links";
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  // `name`/`slug` come from app.json and are required by the ExpoConfig type;
  // the spread cannot prove that to TypeScript, so they are restated.
  name: config.name ?? "miMAR",
  slug: config.slug ?? "mimar",
  // THE IDENTIFIERS COME FROM THE CONTRACT, not from app.json.
  //
  // `/.well-known/assetlinks.json`, served by the web app, publishes this exact
  // package name; Android's verifier compares it to the installed APK's and
  // rejects the association on any mismatch — silently, with the links simply
  // opening in Chrome forever. Two hand-maintained copies of a string in two
  // programs that never import each other is the drift `packages/contract`
  // exists to prevent, so the string has one home and both sides read it.
  // The EAS project this app builds under, created by the PO on 2026-08-25.
  //
  // Written by hand rather than by `eas init`, which needs interactive auth and
  // would rewrite this file — the one file here whose value is its commentary.
  // The result is identical: `eas build` reads `extra.eas.projectId` and nothing
  // else from the config to identify the project.
  //
  // `owner` is deliberately ABSENT. It names the account the project belongs to,
  // and `eas build` run by a logged-in member resolves the owner from the
  // session, so the PO's first builds work without it. A CI or robot build has
  // no session to resolve from and WILL need `owner: "<account slug>"` added
  // here — at the first such build, when the slug is actually known, rather than
  // guessed now.
  //
  // The spread of `config.extra` is not decoration: the expo-router plugin puts
  // its own `extra.router` there during config resolution, and replacing the
  // object instead of merging it would drop that silently.
  //
  // `sentryDsn` RIDES `extra` BECAUSE THE EAS VARIABLE HAS NO EXPO_PUBLIC_
  // PREFIX. Expo inlines only EXPO_PUBLIC_* env vars into the JS bundle, so
  // `process.env.SENTRY_DSN` is undefined at runtime — but THIS file runs in
  // Node at build time, where EAS injects the project's env, so the value is
  // read here once and carried into the manifest. A DSN is a publish address,
  // not a secret (every shipped app exposes its own), so `extra` is an
  // appropriate home. Local dev has no SENTRY_DSN and gets `null`, which
  // `src/observability/sentry.ts` treats as "do not init".
  extra: {
    ...config.extra,
    eas: { projectId: "db4bebed-67f3-49a7-acf7-63c9f19ad511" },
    sentryDsn: process.env.SENTRY_DSN ?? null,
  },
  // The Sentry config plugin wires the NATIVE crash layer during prebuild
  // (Android/iOS init before the JS engine exists — a startup crash never
  // reaches `Sentry.init` in _layout). Deliberately bare: the org/project
  // options only parameterize SOURCEMAP UPLOAD, and SENTRY_ORG/SENTRY_PROJECT
  // reach the build as EAS environment variables instead, which is what the
  // plugin's "Missing config for organization, project" build warning is
  // reporting — it is expected, not a defect.
  //
  // THE UPLOAD IS NOW LIVE, AND THAT IS WHAT BROKE BUILD 7. This comment used
  // to say EAS "does not hold" a SENTRY_AUTH_TOKEN yet, so the plugin skipped
  // the upload and the whole path was inert. The token was added to the
  // `production` and `preview` EAS environments, the upload switched on, and
  // the first build to carry it failed in Gradle — not on anything Sentry did,
  // but on WHERE IT LOOKS FOR ITS CLI. `sentry.gradle` resolves `@sentry/cli`
  // by shelling out to `require.resolve`, and when that fails it falls back to
  // `<project>/node_modules/@sentry/cli` — a flat-node_modules assumption pnpm
  // never satisfies for a TRANSITIVE dependency. Its own pnpm fallback is dead
  // code: Groovy's `execute()` returns empty stdout on a non-zero exit instead
  // of throwing, so the `catch` holding that fallback never runs.
  //
  // That is why `@sentry/cli` is a DIRECT dependency in this package's
  // `package.json`, pinned to the exact version `@sentry/react-native` already
  // pins. It buys nothing at runtime and adds nothing to the store — pnpm
  // symlinks the same entry — it exists so the path Gradle guesses is a path
  // that is there. Removing it puts the upload task back on that dead branch
  // and the store build fails again. See `docs/mobile/eas-build-profiles.md`.
  //
  // ===========================================================================
  // THE THIRD DECLARATION THAT NEEDS PARAGRAPHS: expo-image-picker
  // ===========================================================================
  // It is HERE and not in `app.json` — where the other three plugins live and
  // where this file's header sends anything without commentary — because two of
  // its three options are BLOCKS rather than settings, and a block is exactly
  // the kind of key whose meaning is entirely in what it forbids. The same
  // reason `updates` is not in app.json, and the arrangement
  // `docs/mobile/camera-modules-handback.md` already specified.
  //
  // `photosPermission` — the iOS `NSPhotoLibraryUsageDescription`, in es-AR,
  // because the UI-language invariant covers the dialogs the OS draws too. It
  // answers the question the dialog actually raises ("why does an app about
  // pets want my photos?") with the use and not with a policy: the photo is the
  // credential's face. It is written as a reason, not as a request, which is
  // the tone the rest of this app's copy uses.
  //
  // WHY `cameraPermission: false` AND `microphonePermission: false`, WHICH ARE
  // NOT "we did not need to set them"
  // ---------------------------------------------------------------------------
  // Read in `expo-image-picker/plugin/build/withImagePicker.js` (57.0.16): with
  // no options at all this plugin ADDS `android.permission.RECORD_AUDIO` to the
  // manifest, and writes `NSCameraUsageDescription` and
  // `NSMicrophoneUsageDescription` into Info.plist with its own ENGLISH default
  // strings. It does that because the same module can also drive
  // `launchCameraAsync`, which records video.
  //
  // This app calls `launchImageLibraryAsync` and nothing else — the adapter's
  // `IMAGE_LIBRARY_OPTIONS` is the whole surface. So the defaults would put a
  // microphone permission in the Play listing of a pet app that records no
  // audio, and two English purpose strings in an es-AR binary, for capabilities
  // that are never invoked. `false` on each is the plugin's own way of saying
  // "and make sure nothing else adds it either": it maps to
  // `withBlockedPermissions`.
  //
  // THAT BLOCK IS A TRIPWIRE FOR THE NEXT COMMIT, and it is deliberate. The
  // handback doc's step 3 installs `expo-camera` for the chip scan, whose own
  // plugin needs `android.permission.CAMERA`. Whoever lands expo-camera must
  // REMOVE `cameraPermission: false` from this block in the same commit and give
  // the key the es-AR camera string instead. `microphonePermission: false`
  // stays: a barcode scan records no audio either.
  //
  // BOTH HALVES OF WHY, read in @expo/config-plugins 57.0.9, because the
  // first draft of this comment got the shape of the danger wrong twice.
  //
  //   · ANDROID — AND PLUGIN ORDER CANNOT SAVE YOU. `withBlockedPermissions`
  //     does not merely decline to add the permission; it writes
  //     `<uses-permission android:name="android.permission.CAMERA"
  //     tools:node="remove"/>` into OUR manifest, and the manifest merger reads
  //     `tools:node="remove"` as an instruction to delete that element wherever
  //     any library contributed it. expo-camera cannot put it back by running
  //     later. `withPermissions`' own `isPermissionAlreadyRequested` sees the
  //     blocked entry and does not even try. The result is an APK whose camera
  //     is denied at runtime with no build error anywhere.
  //   · iOS — WHICH THE FIRST DRAFT MISSED ENTIRELY, and where the failure is
  //     harder. `applyPermissions` DELETES `NSCameraUsageDescription` from
  //     Info.plist when the value is `false`. Today this plugin is last in the
  //     array so a later-appended expo-camera would win the key back; insert
  //     expo-camera BEFORE this entry and it does not. An iOS app that touches
  //     the camera without that key is TERMINATED by the OS — not denied, not
  //     degraded. Killed, on the tap.
  plugins: [
    ...(config.plugins ?? []),
    "@sentry/react-native/expo",
    [
      "expo-image-picker",
      {
        photosPermission:
          "miMAR usa tus fotos para ponerle imagen a la credencial de tu mascota. Elegís vos cuál y cuándo.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  // See "THE SECOND DECLARATION THAT NEEDS PARAGRAPHS" at the top of this file
  // for why each of these keys is the value it is, and for the one thing this
  // block does NOT declare (the channel — that is per build profile).
  //
  // THE PROJECT ID APPEARS TWICE IN THIS FILE and the second copy is here,
  // inside the URL, because Expo's update server addresses a project by id in
  // its path and takes no other form. The two cannot be allowed to drift: a URL
  // pointing at a project that does not exist produces an app that polls
  // forever, finds nothing, logs nothing and can never be hotfixed. Held
  // together by an assertion in src/release/release-config.test.ts rather than
  // by a comment asking nicely.
  updates: {
    url: "https://u.expo.dev/db4bebed-67f3-49a7-acf7-63c9f19ad511",
    enabled: true,
    // Ask on every cold start, but see `fallbackToCacheTimeout` — asking is
    // not the same as waiting for the answer.
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  // The fence. An update whose fingerprint differs from a build's is not served
  // to that build, which is what makes "no native changes over the air" a
  // property of the system rather than a line in a document.
  runtimeVersion: { policy: "fingerprint" },
  ios: { ...config.ios, bundleIdentifier: IOS_BUNDLE_IDENTIFIER },
  android: {
    ...config.android,
    package: ANDROID_PACKAGE_NAME,
    // THE ONE KEY PUSH ON ANDROID NEEDS. Landed 2026-09-15, together with the
    // file it points at.
    googleServicesFile: "./google-services.json",
    //
    // IT IS ONLY EVER WRITTEN WITH THE FILE PRESENT. `expo config` and
    // `expo prebuild` both READ the path and fail on a missing file, so writing
    // this key hopefully turns a missing credential into a broken build —
    // including `pnpm verify:mobile`, which runs `expo config`. If the file ever
    // has to leave this directory, this line leaves with it.
    //
    // WHAT IT IS. `google-services.json` comes from the Firebase console for the
    // project that owns `ar.mimar.app` (`mimar-57482`), and it is what lets the
    // compiled app ask FCM for a token. It carries public-facing identifiers, not
    // secrets, which is why it is COMMITTED — Expo's own guidance says so.
    //
    // ITS OTHER HALF IS NOT HERE AND MUST NEVER BE. The Firebase SERVICE ACCOUNT
    // key (Project settings → Service accounts → Generate new private key) is
    // what lets Expo broker deliveries on this project's behalf. That one is a
    // private key: it was uploaded once with `eas credentials` (FCM V1) and it is
    // excluded by BOTH `.gitignore` and `.easignore` — the second matters more,
    // because a credential kept off a public repo but riding inside every build
    // archive has been moved, not protected. Two files, one console, opposite
    // rules.
    //
    // WHAT HAPPENS WITHOUT IT, stated here so nobody has to discover it. The
    // build compiles, the app runs, the OS permission dialog appears and can be
    // granted — and then the token read rejects with `E_REGISTRATION_FAILED`,
    // which from a log reads like a network problem. The visible symptom is
    // "push works on iOS and not on Android", with a diagnostic pointing at the
    // wrong thing. `src/native/expo-push-adapter.ts` turns that rejection into a
    // sentence that names this key, this file and where it comes from, which is
    // the whole mitigation available from this side.
    //
    // NO `expo-notifications` PLUGIN ENTRY EITHER, and that is an absence rather
    // than an oversight. The plugin exists to set a notification ICON, a colour
    // and custom SOUNDS; this app has no monochrome notification asset and no
    // sound of its own, so an entry with no options would add a fingerprint
    // change and configure nothing. The native module is autolinked by the
    // dependency alone — including the `POST_NOTIFICATIONS` permission its own
    // manifest declares — so nothing about delivery depends on it. Whoever adds
    // the icon adds the entry in the same commit, and inserts it AFTER the
    // `expo-image-picker` block for the ordering reason recorded above it.
    intentFilters: [
      // The custom scheme, declared explicitly rather than left to the implicit
      // filter Expo generates from `scheme`. When the verified `https` filter
      // above lands it becomes a SECOND entry in this same array, and a reader
      // comparing them should be able to see that one carries `autoVerify` and
      // the other cannot.
      {
        action: "VIEW",
        category: ["BROWSABLE", "DEFAULT"],
        data: [{ scheme: "mimar" }],
      },
    ],
  },
});
