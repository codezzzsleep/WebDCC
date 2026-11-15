# 三 Harness 提问适配

本次修复在 `fix/native-parity-repair` 分支及草稿 PR #39，尚未合并或部署。原始 48 项需求仍由 #42 和 48 张子 Issue 追踪；本报告只更新提问适配这一范围。

| Harness | 当前行为 | 本次原生验证 |
| --- | --- | --- |
| Codex 0.167.0 | 新增沿用原生/默认/计划输入模式；Plan 用固定版本的实验 API 合同；多题原子回答，等待原生确认后完成 | 实际 app-server→网页多题/自由文本→原生答案→继续→刷新；停止后旧卡失效 |
| Codex Default | 默认是否可提问由原生配置决定；适配不打开原生功能开关 | 默认配置实际返回提问不可用；作为能力边界验证，不计成 Default 提问已实现 |
| Claude SDK 0.3.322 / CLI 2.1.322 | 按原题文本回填自由文本/多选；按 SDK tool_result 确认；取消后关闭整个问题组 | 实际 SDK/CLI→网页两题→原生答案→继续→刷新；原生停止后旧卡失效 |
| DSH 0.2.2-rc.1 | 保留多题、多选和自由文本；按 waterfall/原生晚答协议回填；取消和确认保留原题 | 实际 native Host→网页两题→原生答案→继续→刷新；原生停止后旧卡失效 |

使用输入模式时，正文逐字保留。模式随消息、持久队列和草稿保存，介入当前轮次不改变模式。目录失败时保留原因及重新读取入口。Codex 的模式设置使用真实模型与思考强度，原生内置模式指令由 `developer_instructions:null` 选择。

本次原生验证使用隔离配置、本机免费脚本模型和真实 Chromium。脚本模型只安排工具调用，生产 adapter、原生 Harness、SDK、HTTP/WS、SQLite 和网页均为实际代码。复现命令和确认语义见 `docs/question-blocking-semantics.md`、`scripts/verify-native-questions.ts`；详细原生轨迹保留在私有证据目录，公开摘要不包含凭据。

发现并修复的两个真实原生/网页故障：Claude 已停止但两张问题卡仍可回答；刷新期间会话身份暂缺导致 Codex Plan 草稿选择被误清空。对应生产 Handler、浏览器和原生回归保留。

验证绑定提交 `76fb0366da55f72e203005f57b71fe145c8a238a`，源码指纹 `7305b5a1c969670f3dd3306261e73e47e18cb930f3e4d942268306cfe07ce492`：565 项单元测试、26 项 Chromium 测试、类型检查/Lint/协议库存/build 全部通过；7 个实际原生浏览器场景通过。固定版本和日志/轨迹摘要指纹见 `question-adaptation-2026-11-15.summary.json`。L1 仍为 1/33 场景通过、32 GOLDEN 差异与 16 NOT_TRIGGERED；没有修改黄金文件。NP-06 仍有 secret/MCP 完整交互、双原生界面、失联/重启及真实 Provider 全范围验收；#29/#41 仍待审查合并与完整原验收，保持开放。
