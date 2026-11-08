# 定制版桌面发布

`tflins/t3code` 使用自己的 `main` 维护定制内容，通过合并官方已发布的最新每夜版标签同步源码。推送或合并到自己的 `main` 自动触发 **Fork Desktop Release** 工作流；其他分支不发布。也保留 `tflins-v*` 标签触发入口，不触发上游的 `v*` 发布流程，也不发布官方 npm 包、手机 App 或云服务。

## 版本与发布

发布基线由 `.github/fork-release.json` 的 `upstreamTag` 固定到官方已发布的每夜版。构建会从官方仓库拉取此标签，并检查它的提交确实包含在当前源码历史中，避免只改版本号却没有同步源码。

定制版标签使用 `tflins-vX.Y.Z-nightly.YYYYMMDD.B-tflins.N`，完整保留上游每夜版版本号（包括构建号 `B`），再追加定制修订后缀。`N` 使用本仓库工作流的运行编号，持续递增，不随上游基线重置。例如，基于官方 `v0.1.8-nightly.20261108.4367` 的第 4 次定制构建为 `tflins-v0.1.8-nightly.20261108.4367-tflins.4`。Release 说明保留准确的上游标签和定制源码提交。

不使用 `apps/desktop/package.json` 的静态版本推断每夜版版本：上游源码可能仍记录上一个稳定版。版本由工作流传入现有打包脚本，构建期间对齐服务端、桌面端和 Web，应用名称及图标使用上游 Nightly 配置。Release 标记为预发布，已经公开的同名版本不覆盖。

首次启用需将工作流和对应代码提交、推送到 `tflins/t3code` 的 `main`，并在该 fork 的 Actions 页面启用工作流。之后日常发布只需检查并推送主线：

```bash
vp run check:changed
git push origin main
```

主线推送后，GitHub Actions 自动构建 macOS Apple Silicon 的 DMG 和 ZIP，检查包内版本与应用 ID，从 ZIP 解压应用并用隔离测试数据启动验证，生成 SHA256SUMS，再为准确的源码提交创建版本标签、上传草稿 Release 并公开。发布说明记录完整源码提交。默认仅使用仓库提供的 `GITHUB_TOKEN`，不需要个人访问令牌或官方发布凭据。

手动运行工作流时必须指定已存在的标签；默认只构建并保留 Actions artifacts，勾选 `publish` 才公开发布。主线和标签推送默认发布。失败后可以重新运行同一次 Actions run，版本号保持不变；若 Release 已经公开，则应增加修订号。不要移动已经发布的标签。

## 安装与更新范围

当前流程未配置 Apple Developer ID 签名和公证，产物用于手动安装，不提供应用内自动升级。`T3CODE_DESKTOP_DISABLE_UPDATE_FEED=true` 明确禁止包内更新源，校验步骤还会确认产物没有 `app-update.yml`，避免更新到官方或未经验证的定制包。未来启用自动升级，需要另外配置签名、公证、自有更新清单，并验证升级链路。

保留上游应用 ID 和数据目录，应用名为 `T3 Code (Nightly)`，首次切换前备份数据，退出旧应用后再替换安装；不要让两份应用同时操作同一数据目录。旧版本可能无法读取新版迁移后的数据库，应用回退与数据恢复应一起考虑。本流程的启动检查使用仓库测试数据库，不访问用户的真实 T3 home。

GitHub 使用 `macos-15` 的 ARM64 runner，发布前还检查实际架构；runner 标签以 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 为准。Windows、Intel Mac、Linux 和手机打包不在此定制工作流范围内。

## 同步官方

在工作区干净时，从官方 Releases 核对最新已公开的 Nightly 标签，然后拉取并合并该标签，更新 `.github/fork-release.json` 的 `upstreamTag` 为同一标签。不要直接用尚未发布的 `upstream/main` 替代每夜版基线。

解决冲突并运行受影响的检查后，提交并推送到 `origin/main`，自动发布新的定制每夜版。保留定制工作流、打包开关及产品改动，不要重置或强制覆盖自己的主线。希望先验证同步结果时，先在开发分支完成合并和检查，通过后再合入主线。

推送触发构建发布，不会自动合并未来的上游源码；后续同步每夜版仍需执行上述合并及验证。
