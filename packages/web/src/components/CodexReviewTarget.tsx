type Target = { type: 'uncommittedChanges' } | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null };
export const DEFAULT_CODEX_REVIEW_TARGET = JSON.stringify({ type: 'uncommittedChanges' });

export function CodexReviewTarget({ value, onChange, disabled, cwd }: { value: string; onChange(value: string): void; disabled: boolean; cwd?: string }) {
  const target = JSON.parse(value) as Target;
  const update = (next: Target) => onChange(JSON.stringify(next));
  return <div>
    <p data-testid="review-workspace">Review 工作目录：{cwd ?? '待原生确认'}</p>
    <label>Review 目标<select className="text-input" aria-label="Review 目标" value={target.type} disabled={disabled}
      onChange={event => update(event.target.value === 'baseBranch' ? { type: 'baseBranch', branch: '' }
        : event.target.value === 'commit' ? { type: 'commit', sha: '', title: null } : { type: 'uncommittedChanges' })}>
      <option value="uncommittedChanges">未提交改动</option><option value="baseBranch">基线分支</option><option value="commit">指定 commit</option>
    </select></label>
    {target.type === 'baseBranch' ? <label>基线分支<input className="text-input" aria-label="基线分支" value={target.branch} disabled={disabled}
      onChange={event => update({ ...target, branch: event.target.value })} /></label> : null}
    {target.type === 'commit' ? <label>Commit SHA<input className="text-input" aria-label="Commit SHA" value={target.sha} disabled={disabled}
      onChange={event => update({ ...target, sha: event.target.value })} /></label> : null}
  </div>;
}
