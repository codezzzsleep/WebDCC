import { useState } from 'react';
import { elicitationUrl, type ElicitationAction, type ElicitationForm as Form } from '@webdcc/protocol';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function ElicitationForm({ form, busy, submit }: { form: Form; busy: boolean; submit: (answer: { action: ElicitationAction; content: unknown }) => void }): React.ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState('');
  const properties = form.kind === 'form' ? record(form.schema['properties']) : {};
  const required = new Set(form.kind === 'form' && Array.isArray(form.schema['required']) ? form.schema['required'] : []);
  const fields = Object.entries(properties);
  const respond = (action: ElicitationAction): void => {
    setError('');
    try {
      let content: unknown = null;
      if (form.kind === 'form' && action === 'accept') {
        if (fields.length === 0) content = JSON.parse(String(values['$json'] ?? '{}')) as unknown;
        else {
          const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (const [name, value] of fields) {
            const schema = record(value); const raw = values[name] ?? (schema['type'] === 'boolean' && required.has(name) ? false : undefined);
            if (raw === undefined || raw === '' && !required.has(name)) continue;
            if (raw === '' && (schema['type'] === 'integer' || schema['type'] === 'number')) throw new Error('Missing number');
            object[name] = schema['type'] === 'integer' || schema['type'] === 'number' ? Number(raw)
              : schema['type'] === 'object' || schema['type'] === 'array' ? JSON.parse(String(raw)) as unknown : raw;
          }
          content = object;
        }
      }
      submit({ action, content });
      setValues(previous => Object.fromEntries(Object.entries(previous).filter(([name]) => {
        const schema = record(properties[name]); return schema['writeOnly'] !== true && schema['isSecret'] !== true && schema['format'] !== 'password';
      })));
    } catch { setError('请检查数字或 JSON 内容格式。'); }
  };
  const url = form.kind === 'url' ? elicitationUrl(form.url) : null;
  return <div aria-label="原生表单">
    {form.kind === 'url' ? url === null ? <p role="alert">原生链接地址无效，已阻止打开。可以拒绝或取消此请求。</p>
      : <p><a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开 {form.serverName} 的原生链接</a><br />完成原生页面操作后再确认。</p>
      : fields.length === 0 ? <label>表单内容<textarea className="text-input" value={String(values['$json'] ?? '{}')} disabled={busy} onChange={event => setValues({ $json: event.target.value })} /></label>
      : fields.map(([name, value]) => {
        const schema = record(value); const title = typeof schema['title'] === 'string' ? schema['title'] : name;
        const secret = schema['writeOnly'] === true || schema['isSecret'] === true || schema['format'] === 'password';
        return <label key={name} style={{ display: 'block', margin: '8px 0' }}>{title}{required.has(name) ? '（必填）' : ''}
          {typeof schema['description'] === 'string' ? <span className="desc">{schema['description']}</span> : null}
          {schema['type'] === 'boolean' ? <input type="checkbox" checked={values[name] === true} disabled={busy} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.checked }))} />
            : Array.isArray(schema['enum']) && schema['enum'].every(option => typeof option === 'string') ? <select className="text-input" disabled={busy} value={String(values[name] ?? '')} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))}>
              <option value="">请选择</option>{schema['enum'].map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            : schema['type'] === 'object' || schema['type'] === 'array' ? <textarea className="text-input" disabled={busy} value={String(values[name] ?? '')} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />
            : <input className="text-input" type={secret ? 'password' : schema['type'] === 'number' || schema['type'] === 'integer' ? 'number' : 'text'} autoComplete={secret ? 'off' : undefined} disabled={busy} value={String(values[name] ?? '')} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} />}
        </label>;
      })}
    {error ? <p role="alert">{error}</p> : null}
    <div className="approval-actions"><button className="btn primary" type="button" disabled={busy || form.kind === 'url' && url === null} onClick={() => respond('accept')}>确认提交</button>
      <button className="btn" type="button" disabled={busy} onClick={() => respond('decline')}>拒绝</button>
      <button className="btn" type="button" disabled={busy} onClick={() => respond('cancel')}>取消</button></div>
  </div>;
}
