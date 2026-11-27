const beforeUpdate = new Set<() => Promise<void>>();
export function beforeAppUpdate(save: () => Promise<void>): () => void {
  beforeUpdate.add(save); return () => { beforeUpdate.delete(save); };
}
export async function updateApp(): Promise<void> {
  await Promise.all([...beforeUpdate].map(save => save()));
  window.location.assign(`/api/app?to=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}
