// @webdcc/server：Fastify、Session Manager、Event Store、同步、Auth、Files
// 骨架占位：实现见 SPEC 对应里程碑。
export const PACKAGE = '@webdcc/server';

export { assertTestIsolation, isolatedDirs, isolatedEnv, ISOLATED_KEYS, realUserHome } from './test-isolation.js';
export type { IsolatedDirs } from './test-isolation.js';
export { TurnTracker } from './turn-tracker.js';
