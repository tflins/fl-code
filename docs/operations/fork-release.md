# 定制版桌面发布

`tflins/fl-code` 使用自己的 `main` 维护定制内容，通过合并官方已发布的最新每夜版标签同步源码。推送或合并到自己的 `main` 自动触发 **Fork Desktop Release** 的构建验证，只保存 Actions artifacts，不创建 Release。正式发布需要手动启用 `publish`，或显式推送 `tflins-v*` 标签。该流程不触发上游的 `v*` 发布，也不发布官方 npm 包、手机 App 或云服务。

## 版本与发布

发布基线由 `.github/fork-release.json` 的 `upstreamTag` 固定到官方已发布的每夜版。构建会从官方仓库拉取此标签，并检查它的提交确实包含在当前源码历史中，避免只改版本号却没有同步源码。

定制版标签使用 `tflins-vX.Y.Z-nightly.YYYYMMDD.B-tflins.N`，完整保留上游每夜版版本号（包括构建号 `B`），再追加定制修订后缀。`N` 从同一上游基线的最新已发布版本递增；仅构建、失败或重跑不会占号。切换上游基线后从 `tflins.1` 开始。例如，基于官方 `v0.1.8-nightly.20261108.4367` 的已发布 `tflins.4` 之后，下一次发布为 `tflins.5`。Release 说明保留准确的上游标签和定制源码提交。

不使用 `apps/desktop/package.json` 的静态版本推断每夜版版本：上游源码可能仍记录上一个稳定版。版本由工作流传入现有打包脚本，构建期间对齐服务端、桌面端和 Web，应用名称及图标使用上游 Nightly 配置。Release 标记为预发布，已经公开的同名版本不覆盖。

首次启用需将工作流和对应代码提交、推送到 `tflins/fl-code` 的 `main`，并在该 fork 的 Actions 页面启用工作流。主线推送会构建用源码提交标识的验证包，但不会占发布版本，也不会创建 Release。日常变更先推送主线并完成本地与 Actions 验证：

```bash
vp run check:changed
git push origin main
```

主线推送后，GitHub Actions 构建 macOS Apple Silicon 的 DMG 和 ZIP，检查包内版本与应用 ID，从 ZIP 解压应用并用隔离测试数据启动验证，生成 SHA256SUMS 并保存 artifacts。本地检查及这次构建验证都通过后，在 Actions 中手动运行 **Fork Desktop Release**，保持 `tag` 为空并启用 `publish`。工作流从同一上游基线的已发布版本计算下一个连续 `N`，再为准确的源码提交创建版本标签、上传草稿 Release 并公开。发布说明记录完整源码提交。默认仅使用仓库提供的 `GITHUB_TOKEN`，不需要个人访问令牌或官方发布凭据。

手动运行时可以指定已存在的标签进行复验；`tag` 为空且未勾选 `publish` 只构建验证包。启用 `publish` 后，空标签会生成下一个连续版本，显式标签则只发布该标签。`tflins-v*` 标签推送属于显式发布入口。失败或重跑不会消耗新的版本号；若 Release 已经公开，应发布下一个版本。不要移动已经发布的标签。

## 安装与更新范围

仓库已从 `tflins/t3code` 更名为 `tflins/fl-code`。旧版更新入口通过 GitHub 重定向继续访问同一仓库及 Release；不要重新创建或复用 `tflins/t3code`，否则会破坏旧版更新链路。

当前流程未配置 Apple Developer ID 签名和公证，因此不启用 Electron 的签名自动更新源。`T3CODE_DESKTOP_DISABLE_UPDATE_FEED=true` 继续禁止包内 `app-update.yml`，避免把未签名构建接入官方更新通道。

定制版从包含自更新器的版本开始，从 GitHub API 查询 `tflins-v*` 预发布，只接受同一 Release 中的 Apple Silicon ZIP 和 `SHA256SUMS`。应用校验 SHA256、版本、应用 ID 和可执行文件后，在应用所在卷解压临时目录，递归清除 quarantine，退出后替换原 `.app` 并重启。安装目录当前用户可写时不需要 `sudo`，也不需要手工执行 `xattr`。

自更新器不会绕过 Gatekeeper 或 Apple 公证。首次从旧版切换到包含自更新器的版本仍需手动安装；如果安装目录不可写，应用会报告错误并继续运行当前版本。保留原应用 ID 和数据目录，应用包、可执行文件和用户可见名称统一为 `FL Code (Nightly)`。更新器在首次升级时把旧包名迁移到新包名，并在安装失败时恢复旧应用；切换前备份数据，不要让两份应用同时操作同一数据目录。旧版本可能无法读取新版迁移后的数据库，应用回退与数据恢复应一起考虑。本流程和更新器测试使用隔离临时目录或仓库测试数据库，不访问用户的真实 T3 home。

新版界面就绪后，更新器在后台清理已完成更新的旧应用备份和临时目录，并在运行期间定期补扫；清理中断后会在下次启动继续。仍在安装、尚需回滚或身份无法确认的备份会保留。

GitHub 使用 `macos-26` 的 ARM64 runner，发布前还检查实际架构；runner 标签以 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 为准。Windows、Intel Mac、Linux 和手机打包不在此定制工作流范围内。

## 同步官方

在工作区干净时，从官方 Releases 核对最新已公开的 Nightly 标签，然后拉取并合并该标签，更新 `.github/fork-release.json` 的 `upstreamTag` 为同一标签。不要直接用尚未发布的 `upstream/main` 替代每夜版基线。

解决冲突并运行受影响的检查后，提交并推送到 `origin/main`。主线推送只构建验证包；确认本地检查、应用启动和 Actions artifact 均通过后，再手动发布新的定制每夜版。保留定制工作流、打包开关及产品改动，不要重置或强制覆盖自己的主线。

推送触发构建验证，不会自动创建 Release，也不会自动合并未来的上游源码；后续同步每夜版仍需执行上述合并及验证。
