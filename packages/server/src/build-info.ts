import type { BuildManifest } from '@webdcc/protocol';

declare const __WDCC_BUILD_MANIFEST__: BuildManifest | undefined;
/** Replaced with an immutable literal by esbuild; development has no build claim. */
export const buildManifest = typeof __WDCC_BUILD_MANIFEST__ === 'undefined' ? undefined : __WDCC_BUILD_MANIFEST__;
