import { Icon } from './Icon.js';

/** Display only: the stored error remains the original native text. */
export function AgentError({ message }: { message: string }): React.ReactElement {
  let fields: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch { /* Ordinary error text is already readable. */ }
  let title = fields === undefined ? message : typeof fields['message'] === 'string' ? fields['message'] : 'Agent 返回错误';
  const reconnect = /^Reconnecting\.\.\.\s*(\d+\/\d+)$/.exec(title);
  if (reconnect && fields?.['codexErrorInfo'] !== undefined) title = `模型响应连接中断（原生曾尝试重连 ${reconnect[1]}）`;
  const detail = fields !== undefined && typeof fields['additionalDetails'] === 'string' ? fields['additionalDetails'] : undefined;
  return <div className="error-card" data-testid="error-card" role="alert">
    <Icon name="alert" size={15} />
    <div className="error-card-body">
      <span>{title}</span>
      {detail ? <p>{detail}</p> : null}
      {fields === undefined ? null : <details>
        <summary>查看原始错误</summary>
        <pre className="output" tabIndex={0}>{message}</pre>
      </details>}
    </div>
  </div>;
}
