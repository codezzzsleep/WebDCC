import { codexSubagentCommandStatus, codexNativeToolStatusLabel, type CodexSubagentCommand } from '@webdcc/protocol';
import { store } from '../lib/store.js';

export function CodexChildCommand({ sessionId, childId, command }: {
  sessionId: string; childId: string; command: CodexSubagentCommand;
}): React.ReactElement | null {
  if (store.getSession(sessionId)?.agent !== 'codex') return null;
  const native = command.native;
  const label = native?.['status'] === 'declined' ? '原生已拒绝' : codexNativeToolStatusLabel(codexSubagentCommandStatus(command));
  return <details data-testid="codex-child-command" data-child-id={childId}
    data-native-turn-id={command.nativeTurnId} data-native-item-id={command.itemId}>
    <summary>原生命令 · <code>{typeof native?.['command'] === 'string' ? native['command'] : command.itemId}</code> · {label}</summary>
    <p role="status" data-testid="codex-child-command-status">{label}{command.incomplete ? ' · 尚未收到命令完成通知' : ''}</p>
    {typeof native?.['cwd'] === 'string' ? <p>工作目录：{native['cwd']}</p> : null}
    {typeof native?.['processId'] === 'string' ? <p>原生进程：{native['processId']}</p> : null}
    {typeof native?.['exitCode'] === 'number' ? <p data-testid="codex-child-command-exit">退出码：{native['exitCode']}</p> : null}
    {command.output === undefined ? <p>原生尚未提供输出</p>
      : <pre className="output" data-testid="codex-child-command-output">{command.output}</pre>}
    {typeof command.streamedOutput === 'string' && command.streamedOutput !== command.output ? <details>
      <summary>已捕获的过程输出</summary><pre className="output" data-testid="codex-child-command-stream">{command.streamedOutput}</pre>
    </details> : null}
    {native === undefined ? null : <details><summary>原生命令详情</summary><pre className="output">{JSON.stringify(native, null, 2)}</pre></details>}
  </details>;
}
