import type { ThreadGoalGetResponse } from './schema/v2/ThreadGoalGetResponse.js';
import type { CommandExecResponse } from './schema/v2/CommandExecResponse.js';
import type { CommandExecWriteResponse } from './schema/v2/CommandExecWriteResponse.js';
import type { CommandExecResizeResponse } from './schema/v2/CommandExecResizeResponse.js';
import type { CommandExecTerminateResponse } from './schema/v2/CommandExecTerminateResponse.js';
import type { ThreadGoalSetResponse } from './schema/v2/ThreadGoalSetResponse.js';
import type { ThreadGoalClearResponse } from './schema/v2/ThreadGoalClearResponse.js';
import type { ThreadSetNameResponse } from './schema/v2/ThreadSetNameResponse.js';
import type { ThreadArchiveResponse } from './schema/v2/ThreadArchiveResponse.js';
import type { ThreadUnarchiveResponse } from './schema/v2/ThreadUnarchiveResponse.js';
import type { ThreadForkResponse } from './schema/v2/ThreadForkResponse.js';
import type { ThreadCompactStartResponse } from './schema/v2/ThreadCompactStartResponse.js';
import type { ReviewStartResponse } from './schema/v2/ReviewStartResponse.js';
import type { ThreadListResponse } from './schema/v2/ThreadListResponse.js';
import type { ListMcpServerStatusResponse } from './schema/v2/ListMcpServerStatusResponse.js';
import type { SkillsListResponse } from './schema/v2/SkillsListResponse.js';
import type { GetAccountResponse } from './schema/v2/GetAccountResponse.js';
import type { GetAccountRateLimitsResponse } from './schema/v2/GetAccountRateLimitsResponse.js';

export interface NativeControlResults {
  'command/exec': CommandExecResponse;
  'command/exec/write': CommandExecWriteResponse;
  'command/exec/resize': CommandExecResizeResponse;
  'command/exec/terminate': CommandExecTerminateResponse;
  'thread/goal/get': ThreadGoalGetResponse;
  'thread/goal/set': ThreadGoalSetResponse;
  'thread/goal/clear': ThreadGoalClearResponse;
  'thread/name/set': ThreadSetNameResponse;
  'thread/archive': ThreadArchiveResponse;
  'thread/unarchive': ThreadUnarchiveResponse;
  'thread/fork': ThreadForkResponse;
  'thread/compact/start': ThreadCompactStartResponse;
  'review/start': ReviewStartResponse;
  'thread/list': ThreadListResponse;
  'mcpServerStatus/list': ListMcpServerStatusResponse;
  'skills/list': SkillsListResponse;
  'account/read': GetAccountResponse;
  'account/rateLimits/read': GetAccountRateLimitsResponse;
}
export const nativeControlResultRefs: Record<keyof NativeControlResults, string> = {
  'command/exec': '#/definitions/v2/CommandExecResponse',
  'command/exec/write': '#/definitions/v2/CommandExecWriteResponse',
  'command/exec/resize': '#/definitions/v2/CommandExecResizeResponse',
  'command/exec/terminate': '#/definitions/v2/CommandExecTerminateResponse',
  'thread/goal/get': '#/definitions/v2/ThreadGoalGetResponse',
  'thread/goal/set': '#/definitions/v2/ThreadGoalSetResponse',
  'thread/goal/clear': '#/definitions/v2/ThreadGoalClearResponse',
  'thread/name/set': '#/definitions/v2/ThreadSetNameResponse',
  'thread/archive': '#/definitions/v2/ThreadArchiveResponse',
  'thread/unarchive': '#/definitions/v2/ThreadUnarchiveResponse',
  'thread/fork': '#/definitions/v2/ThreadForkResponse',
  'thread/compact/start': '#/definitions/v2/ThreadCompactStartResponse',
  'review/start': '#/definitions/v2/ReviewStartResponse',
  'thread/list': '#/definitions/v2/ThreadListResponse',
  'mcpServerStatus/list': '#/definitions/v2/ListMcpServerStatusResponse',
  'skills/list': '#/definitions/v2/SkillsListResponse',
  'account/read': '#/definitions/v2/GetAccountResponse',
  'account/rateLimits/read': '#/definitions/v2/GetAccountRateLimitsResponse',
};
