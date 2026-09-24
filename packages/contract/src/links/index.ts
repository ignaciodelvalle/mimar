// `@dim/contract/links` — where a logical destination lives.
//
// One table, consumed by the web app (QR payloads, share sheets, invitation
// e-mails, notification CTAs) and, from M2 on, by the native router. See
// deep-link-map.ts for what belongs in it and what deliberately does not.
//
// THE `.ts` SUFFIX BELOW IS LOAD-BEARING, and this barrel is where it was
// discovered. `apps/mobile/app.config.ts` imports this entry point, and
// `expo config` — which every EAS build runs first — loads that file through
// NODE's ESM resolver, not through a bundler. Node guesses no extensions:
// `"./deep-link-map"` was ERR_MODULE_NOT_FOUND and blocked the entire
// dev-client path, while resolving fine in Next, Vitest, Metro and tsx. The
// whole package now spells its relative imports out, `pnpm lint:contract`
// rule 8 keeps it that way, and `pnpm verify:mobile` runs `expo config`
// so the next regression is caught by a gate instead of by a build attempt.
export {
  ANDROID_PACKAGE_NAME,
  APP_PATH_NAMES_NO_SCREEN,
  APP_SCHEME,
  DEEP_LINK_MAP,
  IOS_BUNDLE_IDENTIFIER,
  type DeepLinkAccess,
  type DeepLinkDestination,
  type DeepLinkName,
  type DeepLinkParams,
  appRoutePath,
  deepLinkAppUrl,
  deepLinkPath,
  deepLinkUrl,
  matchWebPath,
  pathParamNames,
} from "./deep-link-map.ts";
