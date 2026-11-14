export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationForm =
  | { kind: 'form'; serverName: string; schema: Record<string, unknown> }
  | { kind: 'url'; serverName: string; url: string; elicitationId: string };

export function elicitationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function schemaHasSecrets(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (value === null || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return object['isSecret'] === true || object['writeOnly'] === true || object['format'] === 'password' || Object.values(object).some(child => schemaHasSecrets(child, depth + 1));
}
