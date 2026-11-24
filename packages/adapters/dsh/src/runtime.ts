import { createHash } from 'node:crypto';
import baseline from '../../../../fixtures/dsh/host-api-catalog.json' with { type: 'json' };
import rc5 from '../../../../fixtures/dsh/compatibility-0.2.2-rc.5.catalog.json' with { type: 'json' };
import alpha2 from '../../../../fixtures/dsh/compatibility-0.2.3-alpha.2.catalog.json' with { type: 'json' };

export const DSH_BASELINE_VERSION = '0.2.2-rc.1';
export const SUPPORTED_DSH_VERSIONS = ['0.2.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.2'] as const;
export type DshRuntimeVersion = typeof SUPPORTED_DSH_VERSIONS[number];
export interface DshEndpointDescriptor {
  package?: string;
  kind?: string;
  mode?: string;
  parameters: { name: string; jsonSchema?: object; acceptsUndefined?: boolean }[];
  result?: object;
}
export interface DshRuntimeContract {
  version: DshRuntimeVersion;
  schemaHash: string;
  endpoints: Readonly<Record<string, DshEndpointDescriptor>>;
  experimental: boolean;
  cardIdentity: 'callId' | 'cardId';
  pluginEvents: 'sse' | 'mux';
  systemMessages: 'whole' | 'sections';
}

const catalogs = { '0.2.2-rc.1': baseline, '0.2.2-rc.5': rc5, '0.2.3-alpha.2': alpha2 };
const contracts = new Map<string, DshRuntimeContract>();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isSupportedDshVersion(version: string | undefined): version is DshRuntimeVersion {
  return version !== undefined && SUPPORTED_DSH_VERSIONS.some(value => value === version);
}

/** Version chooses independently captured official declarations. Traits come
 * from that contract, rather than release ordering or migration-guide prose. */
export function dshRuntimeContract(version: string = DSH_BASELINE_VERSION): DshRuntimeContract {
  if (!isSupportedDshVersion(version)) throw Object.assign(new Error(`DSH ${version} 没有已审核的运行时合同`), {
    code: 'dsh-host-version-blocked', statusCode: 409, nativeAdmission: 'not-submitted',
  });
  let contract = contracts.get(version);
  if (contract === undefined) {
    const capturedVersion = (catalogs[version] as { nativeVersion?: string }).nativeVersion;
    if (capturedVersion !== undefined && capturedVersion !== version) throw new Error('DSH catalog release identity does not match its runtime binding');
    const endpoints = freeze(structuredClone(catalogs[version].endpoints)) as unknown as Record<string, DshEndpointDescriptor>;
    const nativeEvents = (catalogs[version] as { nativeEvents?: { systemMessages: 'whole' | 'sections' } }).nativeEvents;
    contract = { version, endpoints,
      schemaHash: createHash('sha256').update(JSON.stringify({ version, endpoints, nativeEvents })).digest('hex'),
      experimental: version.includes('-alpha.'),
      cardIdentity: endpoints['actionCards/act']?.parameters.some(parameter => parameter.name === 'cardId') ? 'cardId' : 'callId',
      pluginEvents: Object.hasOwn(endpoints, 'pluginEvents/follow') ? 'mux' : 'sse',
      systemMessages: nativeEvents?.systemMessages ?? 'whole',
    };
    freeze(contract);
    contracts.set(version, contract);
  }
  return contract;
}

export function dshRuntimeSummary(version: string = DSH_BASELINE_VERSION) {
  const contract = dshRuntimeContract(version);
  return { nativeVersion: contract.version, schemaHash: contract.schemaHash, experimental: contract.experimental,
    methods: Object.keys(contract.endpoints).sort(), cardIdentity: contract.cardIdentity, pluginEvents: contract.pluginEvents, systemMessages: contract.systemMessages };
}
