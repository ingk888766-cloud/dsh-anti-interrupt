# dsh-anti-interrupt（守夜）

给 DeepSeek Harness 上的长任务装一条命：**崩溃、被杀、重启之后，被中断的那个回合会自己接上来继续跑**；Windows 下还能一键关掉屏保、关屏与睡眠，让任务不被打断。

> 适合谁：让 AI 跑长任务（重构、巡检、批量实验）然后去睡觉的人。
> 适用：DeepSeek Harness 桌面端 / dsh web。**自动续跑跨平台**；屏保与电源守卫**仅 Windows**。

---

## 它解决什么

DSH 跑长任务时最常见的两种「白干」：

1. **进程没了，活儿就停在那儿。** 引擎被杀、崩溃、机器重启之后，会话停在半截，非要你说一句「继续」才动——而你可能已经睡了。
2. **电脑自己睡觉。** 屏保一开、电源计划到点关屏/睡眠，引擎就停。任务没死，只是没人按了。

守夜对这两件事各给一半：

| 场景 | 守夜做什么 |
|---|---|
| 崩溃 / 被杀 / 重启 | 启动后分 5 档扫描（6s / 20s / 45s / 90s / 180s）找「开着的回合」，用 `sessionController` 按**和前端同一条路**恢复会话，再用 `agent.followup` **唤醒它自己**继续——不是弹一条提示等你点 |
| 屏保 / 电源 | 点一下「防屏保中断」：屏保关掉 + 关屏/睡眠（AC 与电池都设成「从不」）；再点一下按原值还给系统 |

关键实现细节（容易踩错的地方，已按源码核实）：

- `agent.inject(msg)` 的契约是 **不唤醒驱动**（`send(msg,'next-step',false)`），空闲驱动会一直把消息挂在收件箱里；真正能叫醒会话的是 `agent.followup(msg)`（`send(msg,'next-turn',true)` → `wakeDriver()`）。**用错这一个 API，整个功能就等于不存在。**
- 恢复会话必须走 `sessionController.resolveAgent()`（带 preset 组合）。用更低层的 `agents.resume()` 也能把会话拉起来，但拿到的 agent **没有核心工具**（`pwsh`/`read`/`edit` 全丢）——会话活着却干不了活。守夜宁可晚 15 秒，也不醒在没有工具的壳里。

## 安装

**插件市场**：在市场里搜 `dsh-anti-interrupt`，安装后重启 DSH。

**命令行**：

```bash
dsh plugin add dsh-anti-interrupt
```

**手动**：

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加 `"dsh-anti-interrupt": "^1.0.0"`
2. 同文件 `dsh.profile.bundles` 数组里加 `"dsh-anti-interrupt"`
3. 在 profile 目录执行你用的包管理器安装（`pnpm install` / `npm install`）
4. 重启 DSH

验证装好了：`nightwatch action=status` 返回 `plugin.version = 1.0.0`；输入框工具栏会出现「守夜」按钮。

## 兼容性

| 项 | 值 |
|---|---|
| DSH | `0.2.1-rc.5`、`0.2.2-rc.1` 实测 |
| 依赖的引擎 API | `agent.followup` / `send(wakeup)` / `wakeDriver`、`sessionController.resolveAgent`、`webserver/index-inject`、`agent/created`、`agent/pre-step`、`Session.snapshotEvents` |
| 平台 | 自动续跑：全平台；屏保/电源：**Windows**（其他平台返回 `unsupported`，界面隐藏该项） |
| Node | 18+ |

引擎大版本升级后请先跑一次 `nightwatch action=status` 与「验收」第 3 条；缺 API 时插件会关掉对应能力并在日志里说明，不会让 DSH 起不来。

## 安全边界（先说清楚它动什么）

这个插件会碰系统设置，所以边界写在这里：

| 动作 | 具体改什么 | 可逆性 |
|---|---|---|
| 防屏保 | 注册表 `HKCU\Control Panel\Desktop\ScreenSaveActive`（+ `ScreenSaveTimeOut`、`SCRNSAVE.EXE`） | 开之前先存原值；点「关」按原值写回 |
| 防睡眠 | `powercfg` 改**当前电源方案**的 `VIDEOIDLE`（关屏）/ `STANDBYIDLE`（睡眠），AC 与 DC 两套 | 首次开启时记一次基线（`power-original.json`，不覆盖）；点「关」恢复基线那组值 |

除此之外：

- **不联网**。没有任何遥测、上报、外部请求。
- **不创建计划任务、不改启动项、不杀任何进程**。
- **不需要管理员权限**（全部走 `HKCU` 与当前用户电源方案）。
- 只作用于**当前电源方案**。切换电源方案后需要再点一次开关。
- 是一次性动作，不是周期强制：之后若别的软件又改了电源计划，守夜不会自动改回来。
- 基线只记一次，「关」恢复的是**第一次记录时**那组值，不是「最近一次」。

数据全在 `<DSH_HOME 或 ~/.dsh>/nightwatch/`：开关状态、电源基线、检查点、`continuity/nightwatch.log`。检查点只存 turn 号、最后工具调用、目标与下一步，**不存对话正文**。

## 配置（全部可选）

| 键 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `<DSH_HOME 或 ~/.dsh>/nightwatch` | 数据根 |
| `flagFile` | `<dataDir>/guard-toggle.json` | 两个开关的状态 |
| `continuityDir` | `<dataDir>/continuity` | 检查点与 `nightwatch.log` |
| `screenScript` | 包内 `scripts/screensaver-guard.ps1` | 屏保/电源脚本（随包发布，与安装位置无关） |
| `antiInterruptDir` | `<dataDir>/guard` | 可选的「守夜底座」目录（见下） |
| `watchdogTask` / `recoverTask` / `livenessTask` | `ZeroOne-*` | 可选底座的计划任务名 |
| `shellLauncher` | 无 | 可选底座的启动器 |

两个开关**默认都是关的**——插件不替你做决定。

### 关于「防重启中断」

「防重启中断」这个开关的意思是：DSH 被关掉/杀掉之后，由**守夜底座**（看门狗 + 计划任务 + 启动器）把它重新拉起来，再由自动续跑把回合接上。

底座是**可选外部件**，不在本包里（它要在目标机上创建计划任务，属高权限动作，不适合随 npm 包静默安装）。**没装底座时**：

- `nightwatch action=status` 如实返回 `guardKit.installed = false`；
- `nightwatch action=check` 返回 `skipped`，不假装能防重启；
- 那个开关退化为「自动续跑的闸门」，界面会写清楚。

换句话说：**自动续跑不依赖底座**——引擎被 supervisor 重启、或你自己重开 DSH，都够它工作。底座只是让「连外壳一起被杀」也能自动回来。

## 使用

| 工具动作 | 作用 |
|---|---|
| `nightwatch action=status` | 版本、平台、开关、底座是否安装、屏保脚本、任务状态 |
| `nightwatch action=toggle enabled=true\|false` | 开/关守夜（自动续跑闸门） |
| `nightwatch action=checkpoint goal=… nextAction=…` | 写检查点，续跑消息会带上它 |
| `nightwatch action=continuity` | 读回本会话检查点（`ack` / `pending` / `injections`） |
| `nightwatch action=check` | 干跑底座自检（未装底座返回 `skipped`） |

界面：输入框工具栏「守夜」按钮 → 两个开关。
HTTP：`GET|POST /api/nightwatch/guard`，`POST {"screenAction":"status|disable|restore"}`。

续跑消息进入会话时来源标记为 `zero-one-continuity`，你会看到一条【守夜续跑】，里面带中断的 turn 号、最后工具调用、目标与下一步。

## 验收（可复跑，不靠自评）

1. `nightwatch action=status` → `version` 正确、`guardKit.installed` 与实机一致。
2. **自动续跑真杀**：写一次 `checkpoint`，趁回合执行中 `taskkill /F` 掉 DSH 引擎 → 重启（或等 supervisor 拉起）→ **不要发任何消息** → 看 `dataDir/continuity/nightwatch.log` 是否出现 `已自动唤醒会话`，且会话里自动出现【守夜续跑】。
3. **屏保/电源**：点一次「防屏保中断」→ `ScreenSaveActive=0`、`powercfg` 里关屏/睡眠 AC+DC 全 `0`；再点一次 → 恢复原值。

### 本项目实测过的

| 项 | 结果 |
|---|---|
| 只杀引擎（外壳 supervisor 拉起） | 杀 → 醒 **约 40 秒**，工具集完整 |
| 连外壳一起杀（看门狗重开） | 杀 → 醒 **约 83 秒**（受看门狗 1 分钟一班限制） |
| 唤醒路径 | `boot-20000ms`、来源 `native-turn-end`；日志逐行可核 |
| 屏保/电源四组合 | 屏保开/关 × 开关开/关，四组全过，真实点击验过 |

### 还没验证的（诚实写在这儿）

- **「连外壳一起被杀」的自动恢复依赖守夜底座**，底座不在本包里，因此对只装本包的用户，这条恢复路径不成立；能自动回来的场景是「引擎被 supervisor 拉起」和「你自己重开 DSH」。
- 睡眠**事件本身**没做破坏性实测（把 DC 设成「从不」后不再触发睡眠）。
- 非 Windows 平台只保证自动续跑，屏保/电源返回 `unsupported`——没有在 mac/Linux 上跑过长任务实测。

## 卸载

从 `dsh.profile.bundles` 与 `dependencies` 移除，重启 DSH。想清干净就删 `dataDir`。

**先点「防屏保中断」把它关掉再卸载**——否则屏保和电源超时会停在「已关闭」的状态。

## 许可

MIT
