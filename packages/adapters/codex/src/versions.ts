/** The schema baseline stays frozen; runtime compatibility is reviewed separately. */
export const PINNED_VERSION = '0.167.0';
export const SUPPORTED_CODEX_VERSIONS = ['0.167.0', '0.168.0', '0.169.0'] as const;

export function isSupportedCodexVersion(version: string | undefined): boolean {
  return version !== undefined && SUPPORTED_CODEX_VERSIONS.some(supported => supported === version);
}

export const CODEX_COMPATIBILITY_LABEL = '0.167.0–0.169.0';
