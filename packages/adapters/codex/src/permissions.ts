import type { NativePermissionObservation } from '@webdcc/protocol';
import type { ThreadStartResponse } from './schema/v2/ThreadStartResponse.js';

export function codexPermissionObservation(response: Pick<ThreadStartResponse, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>, source: string): NativePermissionObservation {
  const effective = response.sandbox.type === 'readOnly' && response.approvalPolicy === 'on-request' && response.approvalsReviewer === 'user' ? 'read-only'
    : response.sandbox.type === 'workspaceWrite' && response.approvalPolicy === 'on-request' ? response.approvalsReviewer === 'auto_review' ? 'workspace-auto' : 'workspace'
    : response.sandbox.type === 'dangerFullAccess' && response.approvalPolicy === 'never' && response.approvalsReviewer === 'user' ? 'danger-full-access' : 'custom';
  return { effective, source, scope: 'thread', policy: { sandbox: response.sandbox, approvalPolicy: response.approvalPolicy, approvalsReviewer: response.approvalsReviewer } };
}
