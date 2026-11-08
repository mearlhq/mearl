# npm 发布

[简体中文](npm-release.md) | [English](npm-release.en.md)

工作流为 `.github/workflows/publish.yml`，使用 GitHub 托管的 Ubuntu runner、Node 24 和 npm OIDC。发布不需要 `NPM_TOKEN`，pnpm 继续检查干净工作区、发布分支及远端同步状态。整套检查完成后才运行发布脚本；所有包必须版本一致。测试版选择 `beta`，只接受 `x.y.z-beta.n` 并使用 `beta` 标签；正式版选择 `stable`，只接受 `x.y.z` 并使用 `latest`。两者共用同一 npm 受信连接。每个包的 npm 受信发布者须配置为 `mearlhq/mearl`，工作流文件为 `publish.yml`。

## 首次配置

每个公开 npm 包都需要信任同一工作流：

```sh
npm trust github @mearl/<package> --repository mearlhq/mearl --file publish.yml --allow-publish --yes
```

这一步需要 npm 账号登录及二次验证；npm 包设置页也可配置。工作流文件名只填写 `publish.yml`，不填写目录。包的 `repository.url` 必须与当前 GitHub 仓库匹配。私有 GitHub 仓库可以受信发布，但 npm 不生成其公开 provenance。

## 发起与重试

在 Actions 的 **Publish → Run workflow** 选择源码分支及 `beta` 或 `stable`，默认 `beta`。Beta 版本由工作流查询官方 npm 后自动选择，无需输入；源码版本不回写。正式版只允许从 main 手动运行，且源码必须已提交正式版本和更新日志。

发布源码合入 `main` 后，从 `main` 发起 beta。普通 push 和 PR 不发布 npm；发布流程文件变更会触发完整制品验证。修正 npm 信任配置后，选择 **Re-run failed jobs** 重试发布 job，直接复用成功构建保存的 artifact；不要重跑整个工作流重新打包。版本记录与原制品摘要须一致，已发布字节不可替换。

工作流核对 checkout 与事件提交一致，完整构建、类型检查、边界及浏览器资源检查、全量测试均通过后才发布。版本缓存、重跑和发布分支规则以 [发布说明](releases.md) 及工作流为准。正式版必须先按版本维护流程完成升级、审查与验证，并明确发起 stable 发布。

官方参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
