# 发布清单（GitHub / npm / DSH 插件市场）

## 0. 这个包是什么

`dsh-nightwatch@1.0.0` —— DSH 守夜插件：
- 崩溃/重启后**自动续跑**被中断的回合（`agent.followup` 唤醒，不需要用户再发消息）；
- Windows 下「防屏保中断」一键关屏保 + 关屏/睡眠（AC+DC 全设「从不」），再点一次恢复基线；
- 守夜底座（看门狗/计划任务/启动器）**可选**：没有就如实报未安装，不假装能防重启。

## 1. 发布前检查（已跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check index.js` / `lib/ui-client.js` | exit=0 |
| 单测 | `node test/t173-wake.test.mjs` | 7/7 passed |
| 单测 | `node test/t169-continuity.test.mjs` | 16/16 passed |
| 打包 | `npm pack --dry-run` | 11 files, 35.0 kB, shasum `d5aa49c3…` |
| 官方 App 装载 | `~/.dsh/nightwatch/continuity/nightwatch.log` | 6000ms/20000ms 扫描均执行 |
| 官方 App 路由 | `GET :<port>/api/nightwatch/guard` | 200 `{platform:win32,supported:true}` |
| 官方 App 屏保/电源 | `POST {"screenAction":"disable"/"restore"}` | 0/0 ↔ 0/300/0/7200 |

## 2. GitHub

```bash
cd dsh-nightwatch
git remote add origin https://github.com/<你的账号>/dsh-nightwatch.git
git push -u origin master --tags
```

仓库里已含 `.gitignore`、`LICENSE`（MIT）、`README.md`、`package.json`、`cordis.patch.yml`、`scripts/screensaver-guard.ps1`、`lib/`、`test/`。

Release：tag `v1.0.0` 已在本机创建，push 后到 GitHub Releases 附上 `npm pack` 的 tgz 即可。

## 3. npm（市场若从 npm 拉包，必须先发）

```bash
npm login
npm publish --access public
```

注意：
- 包名 `dsh-nightwatch` 若已被占用，改成带 scope 的名字（如 `@你的账号/dsh-nightwatch`），并同步改 `cordis.patch.yml` 的 `name`、`package.json` 的 `name` 与 profile 里的 bundle 名（三者必须一致）。
- `private` 已移除；版本 `1.0.0`。

## 4. DSH 插件市场提交要点

来自商城预检（`check-plugin-submission.mjs`）与已上架插件的约定：

1. `cordis.patch.yml` 的 `id` **必须全局唯一且与包名一致**，且 `id: 值` 那一行**不能写行尾注释**（否则判 SUBMISSION_ENTRY_MISSING）。
2. `package.json` 必须声明：
   ```json
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
            "compatibility": { "dshReleases": { "0.2.1-rc.5": "compatible", "0.2.2-rc.1": "compatible" } } }
   ```
3. 描述里写清 **Windows-only 的部分**（屏保/电源），以及「不联网、不创建计划任务」。
4. 提交前用官方 App 装一遍（见下），确认工具出现、路由 200、无崩溃。

## 5. 官方 App 本地验收（可复跑）

1. 在 `profiles/desktop/package.json` 的 `dependencies` 加 `"dsh-nightwatch": "link:<本目录>"`，`dsh.profile.bundles` 加 `"dsh-nightwatch"`；
2. `node_modules` 里建同名 junction 指向本目录；
3. 重启 DSH，看 `~/.dsh/nightwatch/continuity/nightwatch.log` 是否出现「启动扫描」；
4. 打开界面 → 输入框工具栏「守夜」→ 两个开关应可点；
5. 屏保/电源：点「防屏保中断」开/关各一次，`powercfg` 的 VIDEOIDLE/STANDBYIDLE 应在「从不 ↔ 基线」之间切换。

## 6. 尚未在官方 App 上完成的一项

**真杀续跑**（杀进程 → 重启 → 无人发消息自动继续）只在工作台 0.2.1-rc.5 上实测过；
官方 App（0.2.2-rc.1）已验证 `agent/created source=resume` 接线、路由、屏保/电源，
但杀进程复测需要在该 App 里发起一个长回合——本机被计算机控制层保护，无法代发消息。
自测步骤：

1. 打开官方 DSH，发一句会跑长命令的话（例：「执行 Start-Sleep -Seconds 120，然后说 DONE」）；
2. 它开始跑之后，`taskkill /F /IM "DeepSeek Harness.exe"`；
3. 重新打开 App，**不要发消息**；
4. 检查 `~/.dsh/nightwatch/continuity/nightwatch.log` 是否出现 `已自动唤醒会话 …`，以及会话里是否自动出现【守夜续跑】消息。

## 7. 隐私

- 不联网；数据全部在 `~/.dsh/nightwatch/`（或 `DSH_HOME` 下）；
- 检查点只存 turn 号、最后工具调用、目标/下一步，不存对话正文；
- 卸载：从 bundles/dependencies 移除并删数据目录即可。
