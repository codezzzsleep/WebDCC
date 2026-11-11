# M8 验收产物说明

- `report.json` / `status.json` / `index.html` 由脚本生成（`scripts/accept-m8.ts` + `e2e-real/reporter.ts`），**不许手改**。
- 仓库里当前这份是 **PR1（SPEC v1，125 个 ID）** 留下的记录，不是 M8 完成证据。
- 2026-11-11 用 SPEC-M8 v2（138 个 ID）重跑时，Playwright worker 在
  `AG-codex-03` 附近出现 `FATAL ERROR: Reached heap limit`（Node 堆涨到 2GB 后 abort），
  一遍没跑完，因此没有生成新的 `report.json`。这是当前**最优先要修的可测性问题**。
- 修好之后按 SPEC 6.1 用 `pnpm accept:m8`（严格模式，两遍）重新生成，并连同截图一起提交。
- `shots/` 是历次运行里保留下来的界面截图（review 用）；正式的验收截图会在下一次成功运行后刷新。
