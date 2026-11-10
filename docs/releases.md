# 发布

[简体中文](releases.md) | [English](releases.en.md)

主仓库为 `mearlhq/mearl`，发布源码统一合入 `main`。在 GitHub Actions 打开 **Publish → Run workflow**，选择 `main` 和 `beta`、`stable` 或 `patch` 通道。

## Beta

Beta 是迭代制品。Action 查询所有公开包的 npm 版本，在源码目标版本下选择已发布最大 beta 编号加一（首次从 beta.0 开始），再导出所选源码提交，在独立构建目录同步 npm 包、扩展 Manifest、MCP 元数据及 Skills 目录的版本，再构建、检查、测试和打包。版本文件不回写源码分支，也不生成正式更新日志或单独的版本提交。

源码由 commit 和预发布标签定位，制品由自动选择的 beta 版本定位；标签中的源码版本字段可以保留日常迭代版本。GitHub 预发布只记录对应提交，附带扩展 ZIP、`config.json` 和许可证。工具箱目录 `toolbox.json` 随官网部署。npm 使用 `beta` 标签。

发布流程代码变更时自动运行仅验证流程：执行完整构建、Node 20.18.0 运行检查、类型检查、测试与打包，保存 Actions artifact；npm 发布与 GitHub 标签、预发布写入只在手动运行时执行。

同一个工作流运行通过 Actions cache 保存版本记录。构建和发布是两个 job：构建完成后保存不可覆盖的 artifact，发布 job 下载并校验该制品。发布失败时选择 **Re-run failed jobs**（CLI 为 `gh run rerun <run-id> --failed`），只重试发布，沿用原版本和原字节，不重新构建打包。不要重跑已成功的构建 job 来替换制品；artifact 缺失或过期时停止，核对部分发布状态后开启新运行。构建重试时若版本缓存丢失也会停止。新运行会重新查询已发布记录。当前源码目标版本已正式发布时，beta 自动进入下一个未发布的 patch 版本。

发布使用 npm 受信的 `publish.yml` OIDC 身份。从干净的原源码目录逐个发布已校验 tarball，保留 pnpm 的分支、工作区和远端状态检查。重跑先核对所有已有 npm 版本的完整性摘要；相同产物可跳过，冲突版本会停止。GitHub 标签固定原提交，已有下载附件也须与本次产物一致，不覆盖其他提交或不同附件。

## 正式版

正式版在 `main` 手动选择 `stable`。先准备、审核并提交一致的版本文件，以及 `changelogs/v<version>.md` 和 `changelogs/v<version>.en.md`。工作流读取正式版本，并将中文版作为 GitHub Release 正文；正文链接到英文版。npm 使用 `latest` 标签。

### 自动补丁版

在 `main` 手动选择 `patch`。工作流核对公开 npm 包版本和 Git 标签，在最新正式版本线上选择已占用的最大正式版本加一个 patch。候选版本须与源码的主版本和次版本一致，且补丁号至少达到源码版本。例如，源码和最新正式版均为 3.0.0 时选择 3.0.1。若要开启新的主版本或次版本，请使用 `stable` 通道。

版本号只写入导出的构建目录。Git 标签指向参与构建的原始提交。工作流为 GitHub 正式 Release 生成发布说明，列出当前版本线自上一份已发布 Release 以来的提交。npm 使用 `latest` 标签。失败重试沿用原工作流保留的版本和制品。若商店已有同版本的手动上传，先在开发者后台核对该版本的状态和来源。

### 商店提审

`patch` 通道的扩展制品关闭 Analytics。要为 `stable` 通道启用 Analytics，在仓库的 Actions 设置中添加变量 `VITE_MEARL_ANALYTICS_ID` 和 secret `VITE_MEARL_ANALYTICS_SECRET`。两项均为空时关闭上报。构建会将两项值写入公开的扩展 JavaScript，发布前应让商店隐私披露与实际采集行为一致。

npm 发布和 GitHub Release 完成后，**Submit Chrome Web Store review** 用同一份已校验的扩展 ZIP 提审。审核通过后商店自动上架。从 `main` 手动触发的 `stable` 和 `patch` 均执行这一步。

在 GitHub 的 `chrome-webstore` Environment 中限定部署分支为 `main`，将发布者 ID 配为变量 `CHROME_WEBSTORE_PUBLISHER_ID`，将获授权的 [Chrome Web Store 服务账号](https://developer.chrome.com/docs/webstore/service-accounts) JSON 配为 secret `CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON`。提审失败后先到开发者后台确认上传和审核状态。若同版本已上传为草稿，可直接在后台提交审核。重跑失败的 job 会沿用原制品。

GitHub 扩展附件的下载权限由仓库可见性决定。开发验证可加载本地 `packages/extension/dist_chrome`；发行验证使用同版预发布 ZIP 解压后的目录。

## Windows 发行包回查

`.github/workflows/windows-smoke.yml` 通过 GitHub Actions 手动运行，读取 npm 当前 beta，安装对应的官方运行包和同版 GitHub 扩展 ZIP。临时 Windows runner 使用独立 Chrome for Testing 配置，核验 Native Messaging 注册、Chrome/Native Host 同版连接、CLI 命名管道往返与注册清理，并保存 `windows-runtime-smoke` 证据附件。它检查已发布制品，不代替候选源码 CI、完整 Windows UI 或第三方服务验收。
