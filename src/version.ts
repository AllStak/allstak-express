// SDK_VERSION is replaced at build time by tsup `define` (see tsup.config.ts)
// using the version from package.json. The fallback string below is only used
// when the source is imported directly (tests, ts-node) without that build
// step. Keep this in sync with package.json on every version bump.
declare const __ALLSTAK_EXPRESS_VERSION__: string;

export const SDK_NAME = '@allstak/express';
export const SDK_VERSION: string =
  typeof __ALLSTAK_EXPRESS_VERSION__ !== 'undefined' ? __ALLSTAK_EXPRESS_VERSION__ : '0.1.0';
