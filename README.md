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
- 不改启动项，不杀进程。
- **默认不创建任何计划任务。** 只有你在「启动守护」里点安装，才会建 `dsh-anti-interrupt-guard` 这一条，点卸载就删掉。
- 不需要管理员权限。
- 只对当前电源方案生效，换了方案要再点一次。
- 是一次性动作。点完之后别的软件再改电源计划，它不会自己改回来。
- 基线只记一次，点「关」恢复的是第一次记下的那组值，不是最近一次。

数据都在 `<DSH_HOME 或 ~/.dsh>/nightwatch/` 下：开关状态、电源基线、检查点、`continuity/nightwatch.log`。检查点只有 turn 号、最后一次工具调用、目标与下一步，不存对话内容。

## 「防重启中断」：让 App 被杀后自己回来

自动续跑只在 DSH 重新起来之后才起作用。要让 DSH 自己回来，得有人在外面盯着——插件内置了一个启动守护，但要你点一下才会装。

**装什么**：一个名叫 `dsh-anti-interrupt-guard` 的 Windows 计划任务，每分钟跑一次；App 不在就启动它。脚本、任务定义、日志都在 `~/.dsh/nightwatch/boot-guard/` 下。

**怎么装**：输入框工具栏「守夜」→「启动守护（防杀）」→ 安装；或者 `nightwatch action=guard guardAction=install`。

**怎么卸**：同一处点卸载，或者 `nightwatch action=guard guardAction=uninstall`。卸完任务和目录都会删掉。

不装它也能用：引擎被 supervisor 重启、或者你自己重新打开 DSH，回合都会自动接上，只是窗口不会自己弹回来。

> 任务用的是 XML 注册，显式关掉了「电池供电时不启动」。`schtasks /SC MINUTE` 的默认值会让笔记本在电池下永远不跑这个任务，界面上却仍然显示 Ready、下次运行时间照常往前走——这个坑实测踩到过，任务从注册起一次都没执行。

## 使用

| 动作 | 作用 |
|---|---|
| `nightwatch action=status` | 版本、平台、开关、看门狗是否安装、屏保脚本、任务状态 |
| `nightwatch action=toggle enabled=true\|false` | 开/关守夜 |
| `nightwatch action=checkpoint goal=… nextAction=…` | 写检查点，续跑消息会带上 |
| `nightwatch action=continuity` | 读回本会话的检查点 |
| `nightwatch action=check` | 干跑一次看门狗自检 |
| `nightwatch action=guard guardAction=status\|install\|uninstall` | 启动守护：看状态 / 装计划任务 / 删干净 |

界面：输入框工具栏「守夜」按钮。
HTTP：`GET|POST /api/nightwatch/guard`，`POST {"screenAction":"status|disable|restore"}`。

续跑消息会以【守夜续跑】出现在会话里，带中断的 turn 号、最后一次工具调用、目标和下一步，来源标记是 `zero-one-continuity`。

## 实测

| 场景 | 结果 |
|---|---|
| 0.2.1-rc.5，只杀引擎，外壳把它拉起来 | 约 40 秒，工具集完整 |
| 0.2.1-rc.5，连外壳一起杀，外部看门狗重开 | 约 83 秒（看门狗一分钟一班） |
| 0.2.2-rc.1，整个 App 被杀，**插件自己装的启动守护**拉起 | 71.9 秒。09:53:14 杀，09:54:03 守护启动 App，09:54:26 唤醒 |
| 0.2.2-rc.1，你自己重新打开 App | 启动后第一次扫描就在 6 秒那拍接上 |
| 屏保、电源四组开关组合（0.2.1-rc.5） | 四组都过，走的是真实点击 |

唤醒过程在日志里是这样接起来的：`不在内存 → sessionController 恢复会话 → agent/created source=resume → 已自动唤醒`。

### 没测到的

- 启动守护只在 Windows 上做过。电池那一侧验过（笔记本、`PowerOnline=False` 下任务确实触发并启动了 App），交流电那一侧没单独验。
- 没在第二台机器上装过；换机器后靠 `process.execPath` 推启动器，这个只在本机验过。
- 睡眠本身没做破坏性实测——把电池的睡眠设成「从不」之后就不会触发了。
- macOS 和 Linux 上只保证自动续跑，屏保、电源、启动守护都不参与。

## 卸载

从 `dsh.profile.bundles` 和 `dependencies` 里删掉，重启 DSH。想清干净再删数据目录。

卸载之前先点一下「防屏保中断」把它关掉，否则屏保和睡眠会一直停在关闭状态。

## 许可

MIT
