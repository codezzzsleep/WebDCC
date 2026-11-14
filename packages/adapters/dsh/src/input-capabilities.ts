/** Resolve current Host input declarations without interrogating a provider
 * endpoint or substituting local configuration for a remote profile. */
export type DshInputModality = 'text' | 'image';
export interface DshInputModel { id?: string; inputModalities?: readonly DshInputModality[] }
export interface DshInputCatalog { groups?: { id?: string; models?: DshInputModel[] }[]; models?: DshInputModel[] }
export interface DshInputCapability { inputModalities?: DshInputModality[]; source: string; reason?: string }
export type DshInputQuery = <T>(endpoint: string, args?: Record<string, unknown>) => Promise<T>;
export const dshInputRoute = (provider: string, model: string): string => JSON.stringify([provider, model]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function modalities(value: unknown): DshInputModality[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => item !== 'text' && item !== 'image')) return undefined;
  return [...new Set(value)] as DshInputModality[];
}

export async function dshInputCapabilities(catalog: DshInputCatalog, query: DshInputQuery): Promise<Map<string, DshInputCapability>> {
  const result = new Map<string, DshInputCapability>();
  for (const group of catalog.groups ?? []) for (const model of group.models ?? []) {
    if (typeof group.id !== 'string' || typeof model.id !== 'string') continue;
    const direct = modalities(model.inputModalities);
    result.set(dshInputRoute(group.id, model.id), direct === undefined ? { source: 'unavailable-in-native-modelCatalog', reason: 'Host model catalog did not declare input modalities' }
      : { inputModalities: direct, source: 'session/modelCatalog' });
  }
  if (result.size === 0 || [...result.values()].every(capability => capability.inputModalities !== undefined)) return result;
  const [directory, description] = await Promise.allSettled([
    query<{ provider: string; settingsNs: string; settingsPath: string[]; declared?: boolean; error?: string }[]>('llm/listConfigurableProviders'),
    query<{ namespaces: { ns: string; value: unknown; revision: number; secrets?: { path: string[]; set: boolean }[] }[] }>('settings/describe'),
  ]);
  if (directory.status !== 'fulfilled' || description.status !== 'fulfilled' || !Array.isArray(directory.value) || !Array.isArray(description.value.namespaces)) return result;
  const known = directory.value.filter(route => route.settingsNs === 'llm-pi-ai' && route.settingsPath.length === 2 && route.settingsPath[0] === 'providers' && route.settingsPath[1] === route.provider && route.error === undefined);
  const installed = await Promise.allSettled(known.map(async route => {
    // Native discovery labels this flag precisely: true means a hand-declared
    // route, which would interrogate a remote endpoint. Never take that path.
    if (route.declared !== false) return { route, models: [] as { id: string; inputModalities?: DshInputModality[] }[] };
    return { route, models: await query<{ id: string; inputModalities?: DshInputModality[] }[]>('llm/discoverModels', { settingsNs: route.settingsNs, request: { provider: route.provider } }) };
  }));
  for (let index = 0; index < known.length; index++) {
    const route = known[index]!;
    const namespaces = description.value.namespaces.filter(namespace => namespace.ns === route.settingsNs);
    if (namespaces.length !== 1) continue;
    const namespace = namespaces[0]!;
    const profile = object(object(namespace.value)['providers'])[route.provider];
    const configured = object(profile);
    if (!Array.isArray(configured['models'])) continue;
    if (namespace.secrets?.some(secret => secret.set && secret.path[0] === 'providers' && secret.path[1] === route.provider && ['models', 'modelOverrides'].includes(secret.path[2] ?? ''))) continue;
    const entries = configured['models'] as unknown[];
    if (entries.length === 0 && (configured['modelOverrides'] === undefined || typeof configured['modelOverrides'] !== 'object' || configured['modelOverrides'] === null)) continue;
    const discovery = installed[index];
    const baseModels = discovery?.status === 'fulfilled' && Array.isArray(discovery.value.models) ? discovery.value.models : undefined;
    for (const group of catalog.groups ?? []) {
      if (group.id !== route.provider) continue;
      for (const model of group.models ?? []) {
        if (typeof model.id !== 'string') continue;
        const key = dshInputRoute(route.provider, model.id);
        if (result.get(key)?.inputModalities !== undefined) continue;
        const matches = entries.filter(entry => object(entry)['id'] === model.id);
        if (entries.length > 0 && matches.length !== 1) continue;
        const entry = entries.length > 0 ? object(matches[0]) : object(object(configured['modelOverrides'])[model.id]);
        const explicit = modalities(entry['input']);
        const base = baseModels?.find(base => base.id === model.id);
        // A failed installed-catalog read cannot justify applying fallback to
        // a shipped model whose missing catalog declaration might differ.
        const fallback = route.declared === true || baseModels !== undefined && base === undefined ? modalities(configured['defaultInput']) : undefined;
        const inputModalities = explicit ?? modalities(base?.inputModalities) ?? fallback;
        if (inputModalities !== undefined) result.set(key, { inputModalities,
          source: explicit !== undefined ? 'settings/describe:resolved-model-input' : base !== undefined ? 'llm/discoverModels:installed-catalog+resolved-profile' : 'settings/describe:resolved-defaultInput' });
      }
    }
  }
  return result;
}
