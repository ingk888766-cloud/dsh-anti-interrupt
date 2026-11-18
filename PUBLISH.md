# 发布记录（maintainer 用）

## 已发布

| 通道 | 地址 | 状态 |
|---|---|---|
| GitHub 仓库 | https://github.com/ingk888766-cloud/dsh-anti-interrupt | public，`main` 已推 |
| GitHub Release | https://github.com/ingk888766-cloud/dsh-anti-interrupt/releases/tag/v1.0.0 | 已建，附 `dsh-anti-interrupt-1.0.0.tgz`（37277 B，state=uploaded） |
| npm | `dsh-anti-interrupt@1.0.0` | 见下方发布凭据步骤 |
| DSH 市场 | 社区清单 `awesome-dsh-plugin` | 见下方提交步骤 |

## 为什么叫 dsh-anti-interrupt

npm 上 `dsh-nightwatch` 已被他人占用（`Zci514`，功能是"续跑到指定钟点"），社区清单里也有同名条目。同名不同物会让用户混淆，因此本包改名为 `dsh-anti-interrupt`：

- 包名/仓库名：`dsh-anti-interrupt`
- `cordis.patch.yml` 的 `id` 与 `name` 必须与包名一致（预检硬要求）
- 界面与工具名仍叫「守夜 / nightwatch」，数据目录仍是 `<DSH_HOME>/nightwatch`（避免已有安装的数据迁移）

## 复现发布

```bash
node --check index.js && node --check lib/continuity.js && node --check lib/ui-client.js
node test/t173-wake.test.mjs
node test/t169-continuity.test.mjs
npm pack --dry-run          # 11 files / ~37 kB
npm publish --access public
git push -u origin main --tags
```

## 版本与兼容

- `VERSION` 常量（`index.js`）、`package.json` 的 `version`、Release tag 三者必须一致。
- `dsh.compatibility.dshReleases` 目前声明 `0.2.1-rc.5` / `0.2.2-rc.1`；引擎升级后需实测再改。

## 市场提交前自检

1. `cordis.patch.yml` 的 `id: dsh-anti-interrupt` 这一行**不能带行尾注释**。
2. `package.json` 必须有 `dsh.bundle.patch` 与 `dsh.compatibility.dshReleases`。
3. 描述里写清 Windows-only 的部分（屏保/电源），以及"不联网、不建计划任务"。
4. 装一遍官方 App，确认工具出现、路由 200、无崩溃。

## 隐私

- 不联网；数据全在 `~/.dsh/nightwatch/`（或 `DSH_HOME` 下）。
- 检查点只存 turn 号、最后工具调用、目标/下一步，不存对话正文。

## 8. 官方桌面版（0.2.2-rc.1）真杀实测记录

2026-11-18 两次实杀，第二次是完整链路：

| 时刻（+08） | 事件 | 出处 |
|---|---|---|
| 09:11:16 | 看门狗起来（`Win32_Process.Create` 拉起，父进程 `WmiPrvSE.exe`，不在 App 进程树里） | `guard.log` |
| 09:11:23 | `Stop-Process -Force` 杀掉 App 主进程，落在 turn 5 step 6 | 续跑消息记录的中断点 |
| 09:11:28 | 看门狗：`app gone after 7200ms` | `guard.log` |
| 09:11:31 | 看门狗拉起 App，主进程 pid 26448 | `guard.log` + `CreationDate` |
| 09:11:54 | 插件：`不在内存，按前端同一条路恢复会话（sessionController）` | `nightwatch.log` |
| 09:11:56.801 | `已自动唤醒会话 …（boot-6000ms，中断 turn 5，来源 native-turn-end）` | `nightwatch.log` |

**杀 → 醒 = 31.8 秒，全程零用户输入。**

### 关键教训：看门狗不能由 App 的子孙进程来当

第一版把 relauncher 用 `Start-Process` 从会话里起，它是 App 进程树里的子孙——`Stop-Process` 一杀 App，它跟着一起死（`relaunch.log` 只留下 `armed` 一行，永远等不到 `app exited`）。  
**必须让看门狗脱离 App 进程树**：计划任务（Task Scheduler 拉起）或 `Win32_Process.Create`（父进程变成 `WmiPrvSE.exe`）都可以。

### 另一个坑：硬杀后可能触发官方的认证故障

反复硬杀后重启，可能出现窗口标题「DeepSeek Harness 无法使用」，崩溃日志为：

```
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (.../app.asar/lib/main.js:16856:31)
```

这不是插件的问题（把插件从 profile 移除后仍然复现）。原因是 Electron session 里残留了上一代 host 的认证 cookie。修法：关掉 App → 备份并删除
`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` → 重开。

### 手动装包后必须同步 lockfile

官方 App 启动时会跑 `pnpm install --frozen-lockfile`。手工往 `package.json` 里加依赖却不更新 lockfile，会导致安装失败、引擎不启动，表现同样是「无法使用」。装完依赖后必须跑一次：

```powershell
$node='D:\AAAAAA\DeepSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$pnpm='D:\AAAAAA\DeepSH\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
cd $env:USERPROFILE\.dsh\profiles\desktop
& $node $pnpm install --no-frozen-lockfile --ignore-scripts
& $node $pnpm install --frozen-lockfile --lockfile-only --ignore-scripts   # 必须 exit 0
```


## 9. 启动守护（防杀）—— 2026-11-18 实装与实测

`nightwatch action=guard guardAction=install` / 工具栏「守夜」→「启动守护（防杀）」→ 安装。

装出来的东西：计划任务 `dsh-anti-interrupt-guard`（每分钟一次，`cmd /c run-guard.cmd`）、
`~/.dsh/nightwatch/boot-guard/{boot-guard.ps1, run-guard.cmd, guard-task.xml, guard.log}`。
卸载：同一入口点卸载，`schtasks /Delete` + 删目录，两边都会核验。

### 踩到的坑（必须记住）

用 `schtasks /Create /SC MINUTE /MO 1 /TR ...` 建出来的任务，XML 里带的是默认值：

```xml
<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
```

笔记本**用电池时任务永远不启动**，而界面上仍显示 `Status: Ready`、`Next Run Time` 照常往前推。
实测症状：`Last Run Time = 1999/11/30`、`Last Result = 267011`（= 从未运行），`guard.log` 根本不存在；
先误判成「脚本坏了」，手跑 `.cmd` 和 `.ps1` 都正常（能写出 `alive`），才定位到触发器。

**修法**：改为用 `/XML` 注册（`guard-task.xml`，UTF-16 带 BOM），显式写
`DisallowStartIfOnBatteries=false`、`StopIfGoingOnBatteries=false`、`StartWhenAvailable=true`、
`ExecutionTimeLimit=PT5M`。改完后在电池下（`PowerOnline=False`）任务到点即触发。

### 实测链路（2026-11-18 09:53）

```
09:53:14  杀掉 App 主进程（turn 15 中断）
09:54:01  计划任务自己触发（Last Run 09:54:01，Result 0）
09:54:03  guard.log: started D:\AAAAAA\DeepSH\DeepSeek Harness.exe
09:54:03  App 主进程 pid 26456（CreationDate 与日志同秒）
09:54:24  nightwatch.log: 不在内存，按前端同一条路恢复会话
09:54:26  已自动唤醒会话（boot-6000ms，中断 turn 15）
```

**杀 → 醒 71.9 秒，电池供电，零输入。**

### 单测

`test/t177-guard.test.mjs` 8/8：只验形状（枚举、并发安全、status 未安装时如实报、launcher 判定、status 不写盘、非法 guardAction 报错）。
install 会真的动 schtasks，故不进单测，用手跑核验。
