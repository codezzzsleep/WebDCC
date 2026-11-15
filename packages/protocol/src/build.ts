export interface BuildManifest {
  formatVersion: 1;
  commit: string;
  builtAt: string;
  sourceFingerprint: string;
  schemaFingerprint: string;
  nativeBaseline: Record<string, string>;
  nativeCompatibility: Record<string, readonly string[]>;
  database: { minimum: number; maximum: number };
  toolchain: { node: string; packageManager: string; sdk: string };
}
