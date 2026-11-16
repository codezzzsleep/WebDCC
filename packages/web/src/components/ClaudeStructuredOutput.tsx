import type { ClaudeStructuredOutputView } from '@webdcc/protocol';

const labels = {
  completed: '结构化结果已完成', failed: '结构化输出失败', interrupted: '结构化输出已中断', unknown: '结构化结果待确认',
};

export function ClaudeStructuredOutput({ output }: { output: ClaudeStructuredOutputView }): React.ReactElement {
  const { data } = output;
  const text = Object.hasOwn(data, 'value') ? JSON.stringify(data.value, null, 2) : undefined;
  return <section className="step-row" aria-label="Claude 结构化结果" data-testid="claude-structured-output"
    data-item-key={output.itemKey} data-native-result-id={data.nativeResultId} data-query-id={data.queryId} id={`e-${output.seq}`}>
    <div className="step-line"><strong>Claude 结构化结果</strong><span role="status">{labels[data.status]}</span>
      {text === undefined ? null : <button type="button" className="btn ghost" aria-label="复制结构化结果"
        onClick={() => void navigator.clipboard?.writeText(text)}>复制</button>}
    </div>
    {text === undefined ? <p>原生尚未返回结构化结果。</p> : <pre className="output" data-testid="structured-output-value">{text}</pre>}
    {data.errors?.length ? <pre className="output" role="alert">{data.errors.join('\n')}</pre> : null}
    {data.rawText ? <details open={data.status !== 'completed'}><summary>原生返回文本</summary><pre className="output">{data.rawText}</pre></details> : null}
    <details><summary>原生结果详情</summary><pre className="output">{JSON.stringify({
      nativeSessionId: data.nativeSessionId, nativeResultId: data.nativeResultId, resultIndex: data.resultIndex,
      nativeSubtype: data.nativeSubtype, terminalReason: data.terminalReason,
    }, null, 2)}</pre></details>
  </section>;
}
