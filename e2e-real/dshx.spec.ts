import { DshHostClient } from '../packages/adapters/dsh/src/host.js';
import { expect, test } from './fixtures.js';

test.describe('7.13 DSH 连接方式（D1）', () => {
  test('DSHX-00 设置页粘贴链接后已连接，token 不落盘', async ({ app }) => {
    await app.login();
    await app.page.goto(`${app.run.baseURL}/settings/providers`);
    await expect(app.page.getByTestId('dsh-section')).toContainText('已连接');
    const expectedUrl = (app.run.externalDsh?.url ?? '').replace(/\?.*$/, '').replace(/\/$/, '');
    await expect(app.page.getByTestId('dsh-section')).toContainText(expectedUrl);
    // token 不出现在数据目录与日志里
    const fs = await import('node:fs');
    const path = await import('node:path');
    const token = new URL(app.run.externalDsh?.url ?? 'http://x').searchParams.get('token') ?? '';
    expect(token.length).toBeGreaterThan(10);
    const files = [
      path.join(app.run.dirs.data, 'dsh-connection.json'),
      path.join(app.run.root, 'server.log'),
      path.join(app.run.dirs.data, 'webdcc.db'),
    ];
    for (const file of files) {
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      expect(content.includes(token), `${path.basename(file)} 不应包含 token`).toBe(false);
    }
    // 连接后再走一次设置页的连接按钮（用户视角）
    await app.page.getByTestId('dsh-link').fill(app.run.externalDsh?.url ?? '');
    await app.page.getByTestId('dsh-connect').click();
    await expect(app.page.getByTestId('dsh-section')).toContainText('已连接');
  });

  test('DSHX-01 外部会话的审批不被 WebDCC 干扰', async ({ app }) => {
    await app.login();
    const external = app.run.externalDsh;
    if (external === undefined) throw new Error('缺少外部 DSH 信息');
    // 用外部 DSH 自己的客户端驱动它发起审批
    const client = new DshHostClient(external.port);
    await client.authenticate(external.url);
    await client.connect();
    const approvals: string[] = [];
    let clientId = '';
    client.openStream('$events', {}, (frame) => {
      const v = frame.value as Record<string, unknown> | undefined;
      if (v?.type === 'ready') clientId = String(v['clientId'] ?? '');
      if (v?.type === 'waterfall' && v['event'] === 'approval/request') approvals.push(String(v['eventId']));
    });
    await fetch(`${app.run.mocks.anthDsh}/__plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'approval' }) });
    await client.rpc('session/prompt', {
      request: { requestId: 'ext-1', sessionId: external.sessionId, mode: 'queue', content: [{ type: 'text', text: '外部会话审批' }] },
    });
    // 15 秒内审批一直挂着，且 WebDCC 里看不到这个会话
    await app.page.waitForTimeout(15_000);
    expect(approvals.length).toBe(1);
    await app.page.goto(`${app.run.baseURL}/`);
    const sidebar = await app.page.getByTestId('sidebar').innerText();
    expect(sidebar).not.toContain('外部会话审批');
    expect(await app.page.getByTestId('approval-card').count()).toBe(0);
    // 外部界面批准，外部会话正常完成
    const eventId = approvals[0] ?? '';
    await client.rpc('$events/result', { clientId, eventId, outcome: { kind: 'result', value: 'allowed-once' } });
    await client.close();
  });
});
