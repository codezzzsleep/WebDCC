/** Compare JSON values: object property order is immaterial, array order
 * and field presence remain significant. Inputs come from parsed JSON. */
export function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, i) => jsonValueEqual(value, right[i]));
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(right)) return false;
  const keys = Object.keys(left); const values = right as Record<string, unknown>;
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonValueEqual((left as Record<string, unknown>)[key], values[key]));
}
