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
