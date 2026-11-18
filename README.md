# dsh-anti-interrupt（守夜）

DSH 跑长任务时，进程被杀、崩溃，或者电脑自己睡着，任务就停在半路。这个插件管两件事：把被打断的回合接上，以及在 Windows 上关掉会打断你的屏保和睡眠。

## 它做什么

**接上被打断的回合。** DSH 启动后，插件在 6、20、45、90、180 秒各扫一次，看有没有开着的回合。找到就按前端的方法把会话恢复出来，再唤醒它继续跑。你不用再补一句「继续」。

**关掉会打断你的东西（Windows）。** 输入框工具栏的「守夜」按钮里有两个开关。「防屏保中断」打开会关掉屏保，并把关屏、睡眠的超时设成「从不」——交流电和电池各一套；关掉它会把原来的值还回去。

两个开关默认都关着。

## 实现上有两处值得说

唤醒用的是 `agent.followup()`，不是 `agent.inject()`。`inject` 的契约是不唤醒驱动，消息会一直躺在收件箱里，等下一次有人说话才被带出来。这一处用错，续跑就不会发生。

恢复会话走 `sessionController.resolveAgent()`，和前端打开会话是同一条路，preset 和工具集都会带回来。底层还有个 `agents.resume()`，也能把会话拉起来，但拿到的 agent 没有 `pwsh`、`read`、`edit`——会话在，活干不了。

## 安装

插件市场里搜 `dsh-anti-interrupt`，装完重启 DSH。或者：

```bash
dsh plugin add dsh-anti-interrupt
```

手动：在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-anti-interrupt": "^1.0.0"`，`dsh.profile.bundles` 里加 `"dsh-anti-interrupt"`，在 profile 目录跑一次包管理器安装，重启。

装好后 `nightwatch action=status` 能读到版本号，输入框工具栏会多一颗「守夜」按钮。

## 兼容

自动续跑只用到引擎接口，和平台无关；屏保、电源这部分是 Windows 的，其他系统上对应接口返回 `unsupported`，界面上那一行不显示。

实测过的版本：`0.2.1-rc.5`、`0.2.2-rc.1`。引擎大版本升级后建议先跑一次 `nightwatch action=status`；缺接口时相关能力会关掉并在日志里写明，不会让 DSH 起不来。

## 它改了你系统里的什么

这里会动系统设置，所以列清楚：

| 动作 | 改什么 | 怎么还回去 |
|---|---|---|
| 关屏保 | 注册表 `HKCU\Control Panel\Desktop` 下的 `ScreenSaveActive`，连带 `ScreenSaveTimeOut` 和 `SCRNSAVE.EXE` | 打开之前存原值，点「关」写回 |
| 关屏与睡眠 | `powercfg` 改当前电源方案的 `VIDEOIDLE`（关屏）和 `STANDBYIDLE`（睡眠），交流电、电池各一套 | 第一次打开时记一次基线（`power-original.json`），点「关」恢复那组值 |

另外：

- 不联网，没有遥测。
- 不建计划任务，不改启动项，不杀进程。
- 不需要管理员权限。
- 只对当前电源方案生效，换了方案要再点一次。
- 是一次性动作。点完之后别的软件再改电源计划，它不会自己改回来。
- 基线只记一次，点「关」恢复的是第一次记下的那组值，不是最近一次。

数据都在 `<DSH_HOME 或 ~/.dsh>/nightwatch/` 下：开关状态、电源基线、检查点、`continuity/nightwatch.log`。检查点只有 turn 号、最后一次工具调用、目标与下一步，不存对话内容。

## 「防重启中断」和守夜底座

那个开关管另一件事：DSH 被关掉之后，由外部的看门狗把它重新拉起来，再由自动续跑把回合接上。

看门狗不在这个包里。它要在目标机器上创建计划任务，权限不低，不适合跟着 npm 包一起静默安装。没装的时候，`status` 会返回 `guardKit.installed = false`，`check` 返回 `skipped`，那个开关只剩下「自动续跑的闸门」一个作用，界面上也这么写。

自动续跑本身不依赖看门狗。引擎被重启、或者你自己重新打开 DSH，都够用。看门狗只是让「连窗口一起被杀」的时候也能自己回来。

## 使用

| 动作 | 作用 |
|---|---|
| `nightwatch action=status` | 版本、平台、开关、看门狗是否安装、屏保脚本、任务状态 |
| `nightwatch action=toggle enabled=true\|false` | 开/关守夜 |
| `nightwatch action=checkpoint goal=… nextAction=…` | 写检查点，续跑消息会带上 |
| `nightwatch action=continuity` | 读回本会话的检查点 |
| `nightwatch action=check` | 干跑一次看门狗自检 |

界面：输入框工具栏「守夜」按钮。
HTTP：`GET|POST /api/nightwatch/guard`，`POST {"screenAction":"status|disable|restore"}`。

续跑消息会以【守夜续跑】出现在会话里，带中断的 turn 号、最后一次工具调用、目标和下一步，来源标记是 `zero-one-continuity`。

## 实测

| 场景 | 结果 |
|---|---|
| 0.2.1-rc.5，只杀引擎，外壳把它拉起来 | 约 40 秒，工具集完整 |
| 0.2.1-rc.5，连外壳一起杀，外部看门狗重开 | 约 83 秒（看门狗一分钟一班） |
| 0.2.2-rc.1，整个 App 被杀，外部看门狗拉起 | 31.8 秒。09:11:23 杀，09:11:56.8 唤醒 |
| 0.2.2-rc.1，你自己重新打开 App | 启动后第一次扫描就在 6 秒那拍接上 |
| 屏保、电源四组开关组合（0.2.1-rc.5） | 四组都过，走的是真实点击 |

唤醒过程在日志里是这样接起来的：`不在内存 → sessionController 恢复会话 → agent/created source=resume → 已自动唤醒`。

### 没测到的

- 让窗口自己弹回来需要外部看门狗，它不在包里。只装这个包时，能自动回来的是「引擎被重启」和「你自己重新打开 DSH」两种，这两种都会自动续跑。
- 睡眠本身没做破坏性实测——把电池的睡眠设成「从不」之后就不会触发了。
- macOS 和 Linux 上只保证自动续跑，屏保、电源那部分没跑过。

## 卸载

从 `dsh.profile.bundles` 和 `dependencies` 里删掉，重启 DSH。想清干净再删数据目录。

卸载之前先点一下「防屏保中断」把它关掉，否则屏保和睡眠会一直停在关闭状态。

## 许可

MIT
