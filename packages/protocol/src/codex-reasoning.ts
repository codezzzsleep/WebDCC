/** A native contentIndex identifies a body part independently of summaryIndex. */
export interface NativeReasoningPart { index: number; text: string }

export function validNativeReasoningParts(value: unknown): value is NativeReasoningPart[] {
  if (!Array.isArray(value)) return false;
  const indices = new Set<number>();
  return value.every(part => {
    if (part === null || typeof part !== 'object' || !Number.isSafeInteger(part.index) || part.index < 0
      || typeof part.text !== 'string' || indices.has(part.index)) return false;
    indices.add(part.index); return true;
  });
}

/** Existing flat ThreadItem rows are readable without a storage migration. */
export function nativeReasoningContent(event: { kind: string; data?: unknown; native?: unknown }): NativeReasoningPart[] {
  if (event.kind !== 'reasoning') return [];
  const data = event.data as { nativeContent?: unknown } | null;
  if (validNativeReasoningParts(data?.nativeContent)) return data.nativeContent;
  const native = event.native as { type?: unknown; content?: unknown } | null;
  if (native?.type !== 'reasoning' || !Array.isArray(native.content)) return [];
  return native.content.flatMap((text, index) => typeof text === 'string' ? [{ index, text }] : []);
}
