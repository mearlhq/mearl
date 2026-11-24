# 发布

[简体中文](releases.md) | [English](releases.en.md)

主仓库为 `mearlhq/mearl`，发布源码统一合入 `main`。在 GitHub Actions 打开 **Publish → Run workflow**，选择 `main` 和 `beta`、`stable` 或 `patch` 通道。

## 发布说明

触发工作流前，根据审核过的候选提交与上一相关发布标签之间的差异，准备本次发布的简体中文和英文说明。使用三级标题按功能组织，写明用户可感知的改动，以及相关的升级、兼容性和数据删除事项。

在 Publish 工作流的 `notes_zh` 和 `notes_en` 输入中分别填写两种语言的 Markdown 正文。提交多行说明时，可用 `gh workflow run publish.yml --ref main --json`，通过标准输入传入包含 `channel`、`notes_zh` 和 `notes_en` 的 JSON。工作流把两份说明写入同一条 GitHub Release，分别以「简体中文」和「English」为标题，并添加版本比较链接。首次发布链接到对应标签的源码。发布后核对标签与候选提交、两种语言的正文和比较链接。后续勘误直接编辑 GitHub Release 正文。

## Beta

Beta 是迭代制品。Action 查询所有公开包的 npm 版本，在源码目标版本下选择已发布最大 beta 编号加一（首次从 beta.0 开始），再导出所选源码提交，在独立构建目录同步 npm 包、扩展 Manifest、MCP 元数据及 Skills 目录的版本，再构建、检查、测试和打包。版本文件只写入导出的构建目录。

源码由 commit 和预发布标签定位，制品由自动选择的 beta 版本定位。标签中的源码版本字段可保留日常迭代版本。GitHub 预发布包含双语说明、扩展 ZIP 和许可证。工具箱目录 `toolbox.json` 随官网部署。npm 使用 `beta` 标签。

扩展、CLI 检查与稳定版 setup 从官网 `/mearl/config.json` 读取默认更新配置。npm 与 GitHub Release 发布成功后自动部署官网，不等待商店审核提交。普通构建直接读取已部署的 GitHub Pages 配置；stable 和 patch 发布流程传入刚发布的版本，beta 发布保留现有默认更新配置。无法解析时终止部署，保留已上线配置。beta setup 直接下载与自身版本一致的扩展 ZIP。ZIP 下载仍使用不可变的 Release 地址，Release 不附带更新配置。

发布流程代码变更时自动运行仅验证流程：执行完整构建、Node 20.18.0 运行检查、类型检查、测试与打包，保存 Actions artifact；npm 发布与 GitHub 标签、预发布写入只在手动运行时执行。

同一个工作流运行通过 Actions cache 保存版本记录。构建和发布是两个 job：构建完成后保存不可覆盖的 artifact，发布 job 下载并校验该制品。发布失败时选择 **Re-run failed jobs**（CLI 为 `gh run rerun <run-id> --failed`），只重试发布，沿用原版本和原字节，不重新构建打包。不要重跑已成功的构建 job 来替换制品；artifact 缺失或过期时停止，核对部分发布状态后开启新运行。构建重试时若版本缓存丢失也会停止。新运行会重新查询已发布记录。当前源码目标版本已正式发布时，beta 自动进入下一个未发布的 patch 版本。

发布使用 npm 受信的 `publish.yml` OIDC 身份。从干净的原源码目录逐个发布已校验 tarball，保留 pnpm 的分支、工作区和远端状态检查。重跑先核对所有已有 npm 版本的完整性摘要；相同产物可跳过，冲突版本会停止。GitHub 标签固定原提交，已有下载附件也须与本次产物一致，不覆盖其他提交或不同附件。

## 正式版

正式版在 `main` 手动选择 `stable`。先运行 `pnpm bump <version>`，审核并提交一致的版本文件。工作流使用提交中的正式版本。npm 使用 `latest` 标签。

### 自动补丁版

在 `main` 手动选择 `patch`。工作流核对公开 npm 包版本和 Git 标签，在最新正式版本线上选择已占用的最大正式版本加一个 patch。候选版本须与源码的主版本和次版本一致，且补丁号至少达到源码版本。例如，源码和最新正式版均为 3.0.0 时选择 3.0.1。若要开启新的主版本或次版本，请使用 `stable` 通道。

版本号只写入导出的构建目录。Git 标签指向参与构建的原始提交。npm 使用 `latest` 标签。失败重试沿用原工作流保留的版本和制品。若商店已有同版本的手动上传，先在开发者后台核对该版本的状态和来源。

### 商店提审

`patch` 通道的扩展制品关闭 Analytics。要为 `stable` 通道启用 Analytics，在仓库的 Actions 设置中添加变量 `VITE_MEARL_ANALYTICS_ID` 和 secret `VITE_MEARL_ANALYTICS_SECRET`。两项均为空时关闭上报。构建会将两项值写入公开的扩展 JavaScript，发布前应让商店隐私披露与实际采集行为一致。

npm 发布和 GitHub Release 完成后，**Submit Chrome Web Store review** 用同一份已校验的扩展 ZIP 提审。审核通过后商店自动上架。从 `main` 手动触发的 `stable` 和 `patch` 均执行这一步。

如果审核中的版本明确早于本次发布，工作流会撤回旧版本，再上传并提交新版本审核。若同版本已在审核，重跑会沿用现有审核。若有更新的版本在审核，或已有版本审核通过等待上架，工作流会停止并提示检查开发者后台。

在 GitHub 的 `chrome-webstore` Environment 中限定部署分支为 `main`，将发布者 ID 配为变量 `CHROME_WEBSTORE_PUBLISHER_ID`，将获授权的 [Chrome Web Store 服务账号](https://developer.chrome.com/docs/webstore/service-accounts) JSON 配为 secret `CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON`。提审失败后先到开发者后台确认上传和审核状态。若同版本已上传为草稿，可直接在后台提交审核。重跑失败的 job 会沿用原制品。

GitHub 扩展附件的下载权限由仓库可见性决定。开发验证可加载本地 `packages/extension/dist_chrome`；发行验证使用同版预发布 ZIP 解压后的目录。

### SkillHub

在 [SkillHub API Keys](https://skillhub.cn/dashboard/keys) 用已实名认证的发布账号创建个人 API Key，并将其保存为仓库 Actions secret `SKILLHUB_TOKEN`。首次同步或补发时，在 GitHub Actions 打开 **Publish Skills to SkillHub → Run workflow**，选择 `main` 并填写已发布的正式标签，例如 `v3.1.0`。

`stable` 和 `patch` 完成 npm 与 GitHub Release 发布后，自动提交该标签下 `skills/<name>/SKILL.md` 对应的全部 Skill。工作流保留各 Skill 的资源，在临时副本中加入 SkillHub 字段并统一为发行版本。提交后在 SkillHub「我的 Skill」查看审核状态。失败可重跑该 job，或手动用同一标签补发。平台确认同账号的同版本已在审核或已通过时，工作流会跳过该项。

## Windows 发行包回查

`.github/workflows/windows-smoke.yml` 通过 GitHub Actions 手动运行，读取 npm 当前 beta，安装对应的官方运行包和同版 GitHub 扩展 ZIP。临时 Windows runner 使用独立 Chrome for Testing 配置，核验 Native Messaging 注册、Chrome/Native Host 同版连接、CLI 命名管道往返与注册清理，并保存 `windows-runtime-smoke` 证据附件。它检查已发布制品，不代替候选源码 CI、完整 Windows UI 或第三方服务验收。
