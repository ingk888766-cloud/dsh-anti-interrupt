/**
 * 守夜插件（dsh-anti-interrupt）— v1.0.0（可公开发布版）
 *
 * 相对工作台私有版（@local/zero-one-nightwatch v1.3.0）的改造：
 *   1. 不再假设任何本机路径：数据目录默认 `<DSH_HOME 或 ~/.dsh>/nightwatch`，
 *      屏保脚本随包发布（scripts/screensaver-guard.ps1），不依赖安装位置。
 *   2. 「守夜底座」（看门狗 + 计划任务 + 启动器）变成**可选**：没有就如实报未安装，
 *      防重启开关只作为自动续跑的闸门，绝不假装能重开进程。
 *   3. 平台：自动续跑是纯引擎 API，跨平台；屏保/电源/看门狗只在 Windows 生效，
 *      其他平台明确返回 unsupported。
 *   4. 兼容性：dsh 0.2.1-rc.5 / 0.2.2-rc.1 实测同一套 API
 *      （agent-loop 的 send/followup/wakeDriver、sessionController.resolveAgent、
 *       webserver/index-inject、agent/created、Session.snapshotEvents）。
 *
 * 自动续跑的关键事实（源码级）：
 *   `agent.inject(msg)` = send(msg, 'next-step', false) —— **不唤醒驱动**；
 *   `agent.followup(msg)` = send(msg, 'next-turn', true) —— 才会 wakeDriver()。
 *   详见 dsh-agent-loop/lib/index.js:806-814（0.2.1）/ :564-577（0.2.2）。
 */
import { readFile, writeFile, rename, stat, mkdir, appendFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import CLIENT_UI_SCRIPT from './lib/ui-client.js';
import { createContinuity, SOURCE_KIND } from './lib/continuity.js';

export const name = 'dsh-anti-interrupt';
export const inject = ['tools', 'webServer'];
export const VERSION = '1.0.0';
/** 插件自身目录：脚本随包走，不依赖安装位置。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 数据根：DSH_HOME 优先，否则 ~/.dsh（官方桌面端默认）。 */
function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'nightwatch');
}

const TIMEOUT_MS = 20000;

/**
 * 控制台子进程的输出是系统代码页（本机 GBK/936），按 UTF-8 解会得到 `�ļ���` 这种乱码，
 * 于是 `schtasks` 的中文标签一个都匹配不到（实测：三项任务字段全空）。
 * 这里统一按 buffer 收，再用 GBK 解码；TextDecoder 不支持时退回 UTF-8，且不影响纯 ASCII 输出。
 */
function decodeConsole(buf) {
  if (buf === undefined || buf === null) return '';
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

function run(exe, args, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        killed: !!(error && error.killed),
        stdout: decodeConsole(stdout),
        stderr: decodeConsole(stderr),
      });
    });
  });
}

async function readJson(p) {
  try {
    const text = await readFile(p, 'utf8');
    // PowerShell 5.1 的 -Encoding UTF8 会写 BOM；JSON.parse 遇到 BOM 直接抛错。
    // liveness.json 就是 PS 写的，所以这里必须先去 BOM（实测踩过）。
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')), raw: text };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function fileInfo(p) {
  try {
    const st = await stat(p);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

// ---- 守夜 web 桥（t160 起）：HTTP 路由 + index 注入 ----
// 为什么选 HTTP 路由而不是 file 桥：webview 与浏览器页面都运行在 127.0.0.1:3083 同源下，
// 注入脚本 fetch 同源路径零配置即可用；file 桥需要改外壳 preload/IPC，且只覆盖 webview、不覆盖独立浏览器。
// webserver 匹配是 exact 优先于 prefix（dsh-host-webserver lib/index.js match()），
// 本 exact 路由先于任何 /api/* 认证前缀命中，无需额外凭证。
const GUARD_ROUTE_PATH = '/api/nightwatch/guard';
const SELFCHECK_ROUTE_PATH = '/api/nightwatch/selfcheck';
const GUARD_BODY_CAP = 32 * 1024;

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** CSRF 防御：POST 只接受无 Origin（同源 fetch 之外的本地调用）或与请求 host 同源的 Origin。 */
function originAllowed(req, protocol) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).origin === `${protocol}//${host}`;
  } catch {
    return false;
  }
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { done({ ok: false, error: 'body too large' }); return; }
      chunks.push(c);
    });
    req.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => done({ ok: false, error: 'read error' }));
  });
}

async function guardRead(flagFile) {
  const back = await readJson(flagFile);
  const st = await fileInfo(flagFile);
  if (!back.ok) {
    return {
      ok: true,
      // 全新安装的默认：两个开关都关（不替用户做决定）
      guard: st.exists ? null : { enabled: false, screenGuard: false },
      file: flagFile,
      exists: st.exists,
      error: st.exists ? back.error : null,
    };
  }
  const v = back.value || {};
  return {
    ok: true,
    guard: {
      enabled: v.enabled === true,
      screenGuard: v.screenGuard === true,
    },
    file: flagFile,
    exists: true,
    at: v.at ?? null,
    by: v.by ?? null,
  };
}

/** 合并写入：只更新显式给出的布尔字段，保留既有字段（enabled/screenGuard/at/by/其它），tmp+rename 原子替换。 */
async function guardWrite(flagFile, update, by = 'nightwatch-web-ui') {
  const back = await readJson(flagFile);
  const current = back.ok && back.value && typeof back.value === 'object' ? back.value : {};
  const next = { ...current };
  if (typeof update.enabled === 'boolean') next.enabled = update.enabled;
  if (typeof update.screenGuard === 'boolean') next.screenGuard = update.screenGuard;
  next.at = new Date().toISOString();
  next.by = by;
  await mkdir(path.dirname(flagFile), { recursive: true });
  const tmp = `${flagFile}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, flagFile);
  const verify = await readJson(flagFile);
  return {
    ok: verify.ok,
    guard: verify.ok
      ? { enabled: verify.value.enabled === true, screenGuard: verify.value.screenGuard === true }
      : null,
    file: flagFile,
    at: next.at,
    error: verify.ok ? null : verify.error,
  };
}

/**
 * screensaver-guard.ps1 的 stdout 是单行 JSON（ConvertTo-Json -Compress）。
 * 从最后一行开始找「{ 开头 } 结尾」的行解析，兼容 PS 前缀噪音；解不出就给 null + 原因。
 */
function parseScriptJson(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { json: null, error: 'empty stdout' };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
      try {
        return { json: JSON.parse(lines[i]), error: null };
      } catch { /* 继续找上一行 */ }
    }
  }
  try {
    return { json: JSON.parse(text), error: null };
  } catch {
    return { json: null, error: `stdout is not JSON: ${text.slice(0, 300)}` };
  }
}

function guardRoute(flagFile, screenScript, protocol, opts = {}) {
  const { isWin = process.platform === 'win32', originalFile = null, powerFile = null, platform = process.platform } = opts;
  return async function (req, res) {
    if (req.method === 'GET') {
      const result = await guardRead(flagFile);
      const script = await fileInfo(screenScript);
      return sendJson(res, 200, {
        ok: true,
        rev: 'v1',
        platform,
        supported: isWin,
        screenScript,
        screenScriptExists: script.exists,
        bootGuard: opts.bootGuard ? await opts.bootGuard.status() : null,
        ...result,
      });
    }
    if (req.method === 'POST') {
      if (!originAllowed(req, protocol)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      const body = await readBody(req, GUARD_BODY_CAP);
      if (!body.ok) return sendJson(res, 400, { ok: false, error: body.error });
      let parsed;
      try {
        parsed = JSON.parse(body.text || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid json body' });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return sendJson(res, 400, { ok: false, error: 'body must be a json object' });
      }

      // 持久开关（防重启中断）保持原语义：只写开关，不 spawn；合并写，保留 screenGuard。
      if (typeof parsed.enabled === 'boolean') {
        const update = { enabled: parsed.enabled };
        const result = await guardWrite(flagFile, update);
        if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, rev: 'v1', ...result });
      }

      // 启动守护（防杀）：用户显式点「安装」才创建计划任务，卸载就删干净。
      if (typeof parsed.bootGuard === 'string') {
        const act = parsed.bootGuard;
        if (act !== 'status' && act !== 'install' && act !== 'uninstall') {
          return sendJson(res, 400, { ok: false, error: "bootGuard must be 'status' | 'install' | 'uninstall'" });
        }
        if (!opts.bootGuard) return sendJson(res, 501, { ok: false, error: 'boot guard is unavailable in this host' });
        if (!isWin) return sendJson(res, 501, { ok: false, error: 'boot guard is Windows-only', platform });
        const out = act === 'install'
          ? await opts.bootGuard.install()
          : act === 'uninstall'
            ? await opts.bootGuard.uninstall()
            : await opts.bootGuard.status();
        return sendJson(res, out && out.ok === false ? 500 : 200, { ok: !(out && out.ok === false), rev: 'v1', bootGuard: out });
      }

      // screenGuard 不再接受直接写入 —— 只能通过一次性动作触发脚本检查。
      if (parsed.screenGuard !== undefined) {
        return sendJson(res, 400, {
          ok: false,
          error: "screenGuard 是意图记录，不接受直接写入；请用 screenAction: 'disable' | 'restore' | 'status'（按一次检查一次）",
        });
      }

      // 一次性屏保动作：写意图 → spawn 一次脚本 → 原样回传脚本 JSON。
      if (typeof parsed.screenAction === 'string') {
        const action = parsed.screenAction;
        if (action !== 'disable' && action !== 'restore' && action !== 'status') {
          return sendJson(res, 400, { ok: false, error: "screenAction must be 'disable' | 'restore' | 'status'" });
        }
        if (!isWin) {
          return sendJson(res, 501, { ok: false, error: 'screen/power guard is Windows-only', platform });
        }
        // 先写意图（disable→screenGuard:true；restore→screenGuard:false；status 不写）。
        // 先写再跑，screensaver-guard.ps1 的基线 suspect 检测才能看到正确意图。
        let guardInfo;
        if (action === 'disable' || action === 'restore') {
          const written = await guardWrite(flagFile, { screenGuard: action === 'disable' });
          if (!written.ok) return sendJson(res, 500, { ok: false, error: written.error });
          guardInfo = written;
        } else {
          guardInfo = await guardRead(flagFile);
        }
        const scriptBack = await fileInfo(screenScript);
        if (!scriptBack.exists) {
          return sendJson(res, 502, { ok: false, error: `screensaver-guard.ps1 not found: ${screenScript}` });
        }
        // 一次性 spawn：execFile（非 shell 字符串）+ windowsHide + 超时 + 捕获 stdout/stderr。
        const scriptArgs = [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', screenScript,
          '-Action', action,
          '-FlagFile', flagFile,
        ];
        if (originalFile) scriptArgs.push('-OriginalFile', originalFile);
        if (powerFile) scriptArgs.push('-PowerFile', powerFile);
        const r = await run('powershell.exe', scriptArgs, TIMEOUT_MS);
        const parsedOut = parseScriptJson(r.stdout);
        const scriptOk = r.ok && parsedOut.json !== null;
        return sendJson(res, 200, {
          ok: true,
          rev: 'v1',
          action,
          guard: guardInfo.guard,
          file: flagFile,
          at: guardInfo.at ?? null,
          script: {
            ok: scriptOk,
            exitCode: r.code,
            killed: r.killed,
            stderr: r.stderr.trim().slice(0, 4000),
            json: parsedOut.json,
            jsonError: parsedOut.json === null ? parsedOut.error : null,
          },
        });
      }

      return sendJson(res, 400, { ok: false, error: "body needs enabled (boolean) or screenAction ('disable'|'restore'|'status')" });
    }
    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
  };
}

/** 按钮渲染自查（t163 队长追加验收）：真实页面 mount 后把 rect 数据 POST 回来，服务端落盘供验收读取。 */
function selfcheckRoute(selfcheckFile, protocol) {
  return async function (req, res) {
    if (req.method === 'GET') {
      const back = await readJson(selfcheckFile);
      return sendJson(res, 200, { ok: true, file: selfcheckFile, exists: back.ok, record: back.ok ? back.value : null, error: back.ok ? null : back.error });
    }
    if (req.method === 'POST') {
      if (!originAllowed(req, protocol)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      const body = await readBody(req, GUARD_BODY_CAP);
      if (!body.ok) return sendJson(res, 400, { ok: false, error: body.error });
      let parsed;
      try {
        parsed = JSON.parse(body.text || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid json body' });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return sendJson(res, 400, { ok: false, error: 'body must be a json object' });
      }
      if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number' || typeof parsed.count !== 'number') {
        return sendJson(res, 400, { ok: false, error: 'width/height/count must be numbers' });
      }
      const record = {
        width: parsed.width,
        height: parsed.height,
        puaWidth: typeof parsed.puaWidth === 'number' ? parsed.puaWidth : null,
        puaHeight: typeof parsed.puaHeight === 'number' ? parsed.puaHeight : null,
        count: parsed.count,
        // t170：文字居中的可核对指标（客户端用 Range 量文字盒，服务端原样落盘，不再被白名单丢掉）
        textDeltaX: typeof parsed.textDeltaX === 'number' ? parsed.textDeltaX : null,
        padLeft: typeof parsed.padLeft === 'number' ? parsed.padLeft : null,
        padRight: typeof parsed.padRight === 'number' ? parsed.padRight : null,
        href: typeof parsed.href === 'string' ? parsed.href.slice(0, 300) : null,
        clientAt: typeof parsed.at === 'string' ? parsed.at.slice(0, 64) : null,
        serverAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(selfcheckFile), { recursive: true });
      const tmp = `${selfcheckFile}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
      await rename(tmp, selfcheckFile);
      return sendJson(res, 200, { ok: true, file: selfcheckFile, saved: record });
    }
    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
  };
}

async function tailLines(p, count) {
  try {
    const text = await readFile(p, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    return lines.slice(-count);
  } catch {
    return [];
  }
}

async function taskState(taskName) {
  const r = await run('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V']);
  if (!r.ok && !r.stdout) {
    return { task: taskName, registered: false, detail: r.stderr.trim() || `exit ${r.code}` };
  }
  // schtasks 的输出跟着系统语言走（本机是中文），只按英文标签匹配会三项全空 ——
  // 这是实测踩到的坑，所以中英标签都认。
  const grab = (en, zh) => {
    const m = r.stdout.match(new RegExp('(?:' + en + '|' + zh + ')\\s*:?\\s*(.+)', 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    task: taskName,
    registered: true,
    lastRunTime: grab('Last Run Time', '上次运行时间'),
    lastResult: grab('Last Result', '上次结果'),
    nextRunTime: grab('Next Run Time', '下次运行时间'),
    status: grab('Status', '状态'),
  };
}

/** 7 位小数秒（…01.2875793Z）JS 的 Date.parse 会解析失败，先裁到 3 位。 */
function parseIsoLoose(text) {
  if (typeof text !== 'string' || text === '') return null;
  const normalized = text.replace(/(\.\d{3})\d+/, '$1');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

/** 开着的回合最多留多久还算「该续跑」：超过这个年龄的旧检查点不再唤醒（防把几天前的会话拉起来）。 */
export const WAKE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 每次启动最多唤醒几个会话（防一次性拉起一堆会话各开一轮）。 */
export const MAX_WAKES_PER_BOOT = 3;

/**
 * t173 自动续跑唤醒器（导出是为了能在不启动引擎的情况下用 mock 单测，见 test/t173-wake.test.mjs）。
 *
 * 三条铁律（都由源码/实测得出，不是猜）：
 *   1. 唤醒只能用 `followup`（wakeup=true），**不能用 `inject`**（wakeup=false，空闲驱动永远不动）。
 *   2. 会话可能还没被前端打开，所以先 `sessionController.resolve(sessionId)` 把会话恢复成活 agent；
 *      拿不到 controller 时才退回 `ctx.agents.resume()`（无 preset 组合，能力受限，会写日志）。
 *   3. 正在跑的回合不是「中断」：`agent.status === 'running'` 一律跳过，绝不复放。
 */
export function createWakeRunner({ ctx, continuity, readEnabled, log = async () => {}, now = Date.now }) {
  const waking = new Set();
  let wakeBudget = MAX_WAKES_PER_BOOT;

  const safeLog = async (text) => { try { await log(text); } catch { /* ignore */ } };
  const service = (name) => {
    try { return ctx?.get ? ctx.get(name) : undefined; } catch { return undefined; }
  };
  /**
   * 取活 agent。**必须走 ctx.get('agents')**：本插件 inject 只声明了 tools/webServer，
   * 直接访问 `ctx.agents` 在 cordis 里会抛 "cannot get property agents without inject"。
   * 实测（t173 第一次真杀）：6 秒那次启动扫描就栽在这，日志写着「续跑失败 … cannot get property "agents" without inject」，
   * 靠 20 秒那次扫描才补上。ctx.get() 不受 inject 限制，拿不到就返回 undefined。
   */
  const liveAgent = (sessionId) => {
    try { return service('agents')?.get?.(sessionId) ?? undefined; } catch { return undefined; }
  };

  /**
   * 拿一个活 agent：内存里已有就复用；没有就按前端同一条路恢复会话。
   *
   * `sessionController.resolveAgent(sessionId)` 是公开方法（dsh-api-session-controller
   * 的 SessionController.resolveAgent，源码注释：「Resolve or resume one ordinary Session
   * for another Host API domain」）——它内部带 preset 组合 + 并发去重，和浏览器打开会话完全同一条路。
   * 旧版猜的 `sessionController.resolve` 在服务上没有这个入口（在它内部的 agents 子控制器上），
   * 所以这里按 公开方法 → 内部子控制器 → 直接 resume 的顺序退。
   */
  async function ensureAgent(sessionId) {
    const live = liveAgent(sessionId);
    if (live) return live;
    const controller = service('sessionController');
    const resolveFn = typeof controller?.resolveAgent === 'function'
      ? controller.resolveAgent.bind(controller)
      : (typeof controller?.agents?.resolveAgent === 'function'
        ? controller.agents.resolveAgent.bind(controller.agents)
        : (typeof controller?.resolve === 'function' ? controller.resolve.bind(controller) : null));
    if (resolveFn) {
      await safeLog(`续跑：${sessionId} 不在内存，按前端同一条路恢复会话（sessionController）`);
      const found = await resolveFn(sessionId);
      if (found && found.agent) {
        await safeLog(`续跑：${sessionId} 会话已恢复（agent 已就绪）`);
        return found.agent;
      }
      if (found && found.error) {
        const detail = found.error.code || found.error.message || JSON.stringify(found.error);
        throw new Error(`sessionController.resolveAgent 失败：${detail}`);
      }
      return found ?? undefined;
    }
    // t174：**不再用「无 preset 组合」的 `agents.resume` 兜底**。
    // 实测（2026-11-18 01:35 全量杀）：6 秒那拍 sessionController 还没就绪，旧兜底把会话恢复成了
    // 一个「没有 preset」的 agent —— 会话是活的，但 pwsh/read/edit 这些核心工具全没了，
    // 等于给我一个不能干活的替身。宁可晚 15 秒，也要等下一次扫描走 sessionController 的正规路径。
    await safeLog(`续跑：${sessionId} sessionController 未就绪，跳过本次（绝不走无 preset 兜底），等下一次扫描`);
    return undefined;
  }

  /**
   * 尝试把一个会话续跑起来。幂等：检查点一旦被 ack，重复调用不会二次唤醒。
   * @param sessionId 会话 id
   * @param reason 诊断用：谁触发的这次尝试
   * @param options.knownAgent agent/created 时事件里已经给到的活 agent（省一次 resolve）
   * @param options.deferSend 是否把「唤醒」推到下一拍（创建事件里用，避免在 serial 监听器里重入驱动）
   * @returns {{sessionId: string, woken?: true, skipped?: string, error?: string, turn?: number, source?: string}}
   */
  async function wakeSession(sessionId, reason, options = {}) {
    const { knownAgent = null, deferSend = false } = options;
    if (!sessionId) return { sessionId: null, skipped: 'no-session' };
    if (waking.has(sessionId)) return { sessionId, skipped: 'busy' };
    waking.add(sessionId);
    try {
      const info = await continuity.describe(sessionId);
      const state = info && info.state;
      // 只有「开了没闭合」的回合才值得续跑；正常结束的回合 open=false。
      if (state && state.open !== true) return { sessionId, skipped: 'not-open' };
      const started = state ? Date.parse(state.at ?? '') : NaN;
      if (state && (!Number.isFinite(started) || now() - started > WAKE_MAX_AGE_MS)) {
        return { sessionId, skipped: 'stale' };
      }
      const agent = knownAgent ?? await ensureAgent(sessionId);
      if (!agent || !agent.session) {
        await safeLog(`续跑：${sessionId} 没有可用的 agent（${reason}）`);
        return { sessionId, skipped: 'no-agent' };
      }
      // 第一次见到这个会话（没有检查点文件）：只登记水位，不补发历史中断。
      // 否则装插件那一刻会把会话日志里所有老 interrupted 回合重放一遍。
      if (!state) {
        const seeded = await continuity.detectOnResume(agent.session);
        await safeLog(`续跑：${sessionId} 首次登记，水位推进到 turn ${seeded && seeded.turn != null ? seeded.turn : '?'}（不注入历史中断）`);
        return { sessionId, skipped: 'seeded' };
      }
      if (agent.status === 'running') return { sessionId, skipped: 'running' };
      const verdict = await continuity.detectOnResume(agent.session);
      if (!verdict || !verdict.interrupted) {
        await safeLog(`续跑：${sessionId} 未检出中断（${reason}）`);
        return { sessionId, skipped: 'no-interrupt' };
      }
      // 先确认有没有唤醒入口，再消费待注入消息：
      // 拿不到入口就把 pending 留着，交给 pre-step（用户下次发消息时）兜底注入。
      const canWake = typeof agent.followup === 'function' || typeof agent.steer === 'function' || typeof agent.send === 'function';
      if (!canWake) {
        await safeLog(`续跑：${sessionId} 的 agent 没有 followup/steer/send，pending 留给 pre-step`);
        return { sessionId, skipped: 'no-wake-api' };
      }
      const message = await continuity.takePendingInjection(agent);
      if (!message) {
        await safeLog(`续跑：${sessionId} 无待注入消息（${reason}，可能已被消费）`);
        return { sessionId, skipped: 'no-message' };
      }
      // 真唤醒：followup = send(next-turn, wakeup=true) → wakeDriver()。
      const send = () => {
        if (typeof agent.followup === 'function') agent.followup(message);
        else if (typeof agent.steer === 'function') agent.steer(message);
        else agent.send(message, 'next-turn', true);
      };
      if (deferSend) {
        const timer = setTimeout(() => { try { send(); } catch (error) { safeLog(`续跑：延迟唤醒失败 ${sessionId}：${error && error.message ? error.message : error}`).catch(() => {}); } }, 0);
        if (typeof timer?.unref === 'function') timer.unref();
      } else {
        send();
      }
      await safeLog(`续跑：已自动唤醒会话 ${sessionId}（${reason}，中断 turn ${verdict.turn}，来源 ${verdict.source}）`);
      return { sessionId, woken: true, turn: verdict.turn, source: verdict.source };
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      await safeLog(`续跑失败 ${sessionId}（${reason}）：${detail}`);
      return { sessionId, error: detail };
    } finally {
      waking.delete(sessionId);
    }
  }

  /** 启动扫描：只扫「开着的回合」，按最近开始时间优先；开关关着时什么都不做。 */
  async function bootWake(label) {
    try {
      if (typeof readEnabled === 'function') {
        const enabled = await readEnabled();
        if (!enabled) {
          await safeLog(`启动扫描(${label})：守夜开关关闭，不自动续跑`);
          return { skipped: 'disabled' };
        }
      }
      const states = (await continuity.listAll())
        .filter((s) => s && s.open === true && Number.isFinite(Date.parse(s.at ?? '')))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      if (states.length === 0) {
        await safeLog(`启动扫描(${label})：没有开着的回合，无需续跑`);
        return { skipped: 'none' };
      }
      const results = [];
      for (const state of states) {
        if (wakeBudget <= 0) {
          await safeLog(`启动扫描(${label})：本次启动的唤醒预算用完，${state.sessionId} 留到下次`);
          break;
        }
        const r = await wakeSession(state.sessionId, `boot-${label}`);
        results.push(r);
        if (r && r.woken) wakeBudget -= 1;
      }
      return { results };
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      await safeLog(`启动扫描(${label}) 失败：${detail}`);
      return { error: detail };
    }
  }

  return { wakeSession, bootWake, ensureAgent };
}

export async function apply(ctx, config = {}) {
  const isWin = process.platform === 'win32';
  const dataDir = path.resolve(String(config.dataDir ?? defaultDataDir()));
  const flagFile = path.resolve(String(config.flagFile ?? path.join(dataDir, 'guard-toggle.json')));
  // 守夜底座（看门狗 / 计划任务 / 启动器）是**可选**的：只有用户自己装了才有。
  // 没有就如实报「未安装」，绝不假装能防重启。
  const kitDir = path.resolve(String(config.antiInterruptDir ?? path.join(dataDir, 'guard')));
  const watchdog = path.join(kitDir, 'watchdog.ps1');
  const runLog = path.join(kitDir, 'wd-run.log');
  const livenessFile = path.join(kitDir, 'liveness.json');
  const screenScript = path.resolve(String(config.screenScript ?? path.join(PLUGIN_DIR, 'scripts', 'screensaver-guard.ps1')));
  const originalFile = path.join(dataDir, 'screensaver-original.json');
  const powerFile = path.join(dataDir, 'power-original.json');
  const selfcheckFile = path.join(dataDir, 'nightwatch-ui-selfcheck.json');
  const tasks = {
    watchdog: config.watchdogTask ?? 'ZeroOne-AntiInterrupt',
    recover: config.recoverTask ?? 'ZeroOne-AntiInterrupt-Recover',
    liveness: config.livenessTask ?? 'ZeroOne-Liveness',
  };
  const continuityDir = path.resolve(String(config.continuityDir ?? path.join(dataDir, 'continuity')));
  // 启动守护（防杀）自成一摊，和上面那套「守夜底座」互不覆盖：
  // 任务名、目录、脚本都不同，绝不碰 ZeroOne-* 那批已有任务。
  const bootGuardTask = String(config.bootGuardTask ?? 'dsh-anti-interrupt-guard');
  const bootGuardDir = path.resolve(String(config.bootGuardDir ?? path.join(dataDir, 'boot-guard')));
  const bootGuardScriptPath = path.join(bootGuardDir, 'boot-guard.ps1');
  const bootGuardCmdPath = path.join(bootGuardDir, 'run-guard.cmd');
  const bootGuardVbsPath = path.join(bootGuardDir, 'run-guard.vbs');
  const bootGuardConfigFile = path.join(bootGuardDir, 'guard.json');
  const bootGuardLogFile = path.join(bootGuardDir, 'guard.log');
  const bootGuardSourcePath = path.join(PLUGIN_DIR, 'scripts', 'boot-guard.ps1');
  const continuity = createContinuity({ dir: continuityDir, logger: ctx.logger });
  const watchdogInfo = await fileInfo(watchdog);
  const kitInstalled = isWin && watchdogInfo.exists;

  async function status() {
    const flag = await readJson(flagFile);
    const enabled = !!(flag.ok && flag.value && flag.value.enabled === true);
    const live = await readJson(livenessFile);
    const ageSeconds = (() => {
      if (!live.ok || !live.value || !live.value.writtenAt) return null;
      const t = parseIsoLoose(live.value.writtenAt);
      return t === null ? null : Math.round((Date.now() - t) / 1000);
    })();
    return {
      plugin: { name, version: VERSION, platform: process.platform },
      nightwatch: {
        enabled,
        flagFile,
        dataDir,
        meaning: enabled
          ? '守夜开：崩溃后自动续跑；装了守夜底座时还会自动重开工作台'
          : '守夜关（默认）：不自动续跑、不启动任何进程',
      },
      continuity: { dir: continuityDir },
      guardKit: {
        installed: kitInstalled,
        hint: kitInstalled
          ? null
          : '未安装守夜底座（watchdog.ps1 + 计划任务 + 启动器）：「防重启」只作为自动续跑的闸门，不会自动重开进程',
        watchdog: watchdogInfo,
        lastEvents: kitInstalled ? await tailLines(runLog, 3) : [],
        liveness: {
          file: await fileInfo(livenessFile),
          ageSeconds,
          fresh: ageSeconds !== null && ageSeconds <= 60,
        },
        tasks: kitInstalled
          ? await Promise.all([taskState(tasks.watchdog), taskState(tasks.recover), taskState(tasks.liveness)])
          : [],
        shellLauncher: { path: config.shellLauncher ?? null, ...(await fileInfo(config.shellLauncher ?? '')) },
      },
      screen: {
        supported: isWin,
        script: await fileInfo(screenScript),
        originalFile,
        powerFile,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async function toggle(enabled) {
    // 合并写：只改 enabled，保留 screenGuard（旧版直接覆写会把屏保意图清掉）
    const written = await guardWrite(flagFile, { enabled: enabled === true }, 'nightwatch-plugin');
    return {
      enabled: written.guard ? written.guard.enabled : enabled === true,
      screenGuard: written.guard ? written.guard.screenGuard : null,
      flagFile,
      at: written.at,
    };
  }

  /**
   * 干跑自检：用 -DryRun + 一个没人听的端口，走到「外壳死了」分支，
   * 看它是否按开关决定「要不要重开」。绝不启动任何进程。
   * 没装守夜底座时直接如实返回 skipped。
   */
  async function check(port = 39999) {
    if (!kitInstalled) {
      return {
        dryRun: true,
        skipped: true,
        reason: 'guard kit not installed: no watchdog.ps1 / scheduled tasks / launcher on this machine',
        hint: '装底座后 check 才有意义；自动续跑不依赖它',
        watchdog,
        platform: process.platform,
      };
    }
    const hash = await run('powershell.exe', ['-NoProfile', '-Command',
      `(Get-FileHash '${watchdog.replace(/'/g, "''")}' -Algorithm SHA256).Hash.ToLower()`]);
    const selfSha = hash.stdout.trim();
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'AllSigned', '-File', watchdog,
      '-Port', String(port),
      '-EvolutionRoot', kitDir,
      '-ReportPath', path.join(kitDir, 'wd-plugintest.json'),
      '-ShellImagePattern', '__nightwatch_probe__',
      '-ExpectSelfSha256', selfSha,
      // 必须带 -Recover：看门狗的「重开」分支要求 开关 与 -Recover 同时成立。
      // 只给开关不给 -Recover 时它会停在 degraded（实测 exit 3），那就测不到真正的放行路径。
      // -DryRun 保证即便放行也不会启动任何进程。
      '-Recover',
      '-DryRun',
    ];
    const r = await run('powershell.exe', args, 30000);
    const lines = (r.stdout + r.stderr).split(/\r?\n/).filter(l => l.trim() !== '');
    return {
      dryRun: true,
      exitCode: r.code,
      expected: 'uiFlag/switch 决定 exit 2（会重开）或 exit 3（只告警）',
      selfSha256: selfSha,
      output: lines.slice(-8),
    };
  }

  /** 找出「被杀了要拉起来」的那个可执行文件：优先配置，其次当前进程。 */
  function detectLauncher() {
    const override = typeof config.shellLauncher === 'string' && config.shellLauncher.trim() !== ''
      ? config.shellLauncher.trim()
      : null;
    if (override) {
      return { ok: true, path: override, image: path.basename(override), from: 'config.shellLauncher' };
    }
    const exe = process.execPath;
    const base = path.basename(exe);
    if (!/\.exe$/i.test(base)) {
      return { ok: false, reason: `当前进程的可执行文件是 ${base}，不是 Windows 程序` };
    }
    if (/^(node|electron)\.exe$/i.test(base)) {
      return {
        ok: false,
        reason: `当前跑在 ${base} 下（dsh web / CLI），没有可拉起的窗口式 App；要装请用 config.shellLauncher 指定启动器`,
      };
    }
    return { ok: true, path: exe, image: base, from: 'process.execPath' };
  }

  async function bootGuardStatus() {
    const launcher = detectLauncher();
    const script = await fileInfo(bootGuardScriptPath);
    const conf = await readJson(bootGuardConfigFile);
    const task = isWin ? await taskState(bootGuardTask) : { task: bootGuardTask, registered: false, detail: 'non-windows' };
    return {
      ok: true,
      platform: process.platform,
      supported: isWin && launcher.ok,
      installed: isWin && script.exists && task.registered === true,
      task,
      launcher: launcher.ok ? { path: launcher.path, image: launcher.image, from: launcher.from } : { error: launcher.reason },
      script,
      config: conf.ok ? conf.value : null,
      paths: {
        dir: bootGuardDir,
        script: bootGuardScriptPath,
        cmd: bootGuardCmdPath,
        vbs: bootGuardVbsPath,
        log: bootGuardLogFile,
        task: bootGuardTask,
      },
      lastEvents: script.exists ? await tailLines(bootGuardLogFile, 3) : [],
      what: '创建一个每分钟跑一次的计划任务：App 不在就把它启动起来。卸载会删掉任务和这个目录。',
    };
  }

  async function bootGuardInstall() {
    if (!isWin) return { ok: false, error: 'boot guard is Windows-only', platform: process.platform };
    const launcher = detectLauncher();
    if (!launcher.ok) return { ok: false, error: launcher.reason };
    const src = await fileInfo(bootGuardSourcePath);
    if (!src.exists) return { ok: false, error: `包内缺少守护脚本：${bootGuardSourcePath}` };
    await mkdir(bootGuardDir, { recursive: true });
    await writeFile(bootGuardScriptPath, await readFile(bootGuardSourcePath, 'utf8'), 'utf8');
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const cmd = [
      '@echo off',
      `"${powershell}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${bootGuardScriptPath}" -Launcher "${launcher.path}" -Image "${launcher.image}" -Log "${bootGuardLogFile}"`,
      '',
    ].join('\r\n');
    await writeFile(bootGuardCmdPath, cmd, 'utf8');

    // 弹窗问题：任务动作若直接是 cmd.exe / powershell.exe，Task Scheduler 每分钟会闪一个控制台窗口
    // （-WindowStyle Hidden 只藏 PowerShell 自己的窗口，藏不住被拉起的 cmd 宿主）。
    // 改用 wscript.exe //B 跑一个 VBS，WScript.Shell.Run 的窗口样式传 0，全程无控制台。
    const powershellLine = `"${powershell}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${bootGuardScriptPath}" -Launcher "${launcher.path}" -Image "${launcher.image}" -Log "${bootGuardLogFile}"`;
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "${powershellLine.replace(/"/g, '""')}", 0, False`,
      '',
    ].join('\r\n');
    await writeFile(bootGuardVbsPath, vbs, 'ascii');

    await writeFile(bootGuardConfigFile, JSON.stringify({
      task: bootGuardTask,
      launcher: launcher.path,
      image: launcher.image,
      from: launcher.from,
      installedAt: new Date().toISOString(),
      by: 'nightwatch-plugin',
    }, null, 2), 'utf8');

    // 用 XML 注册，而不是 `schtasks /SC MINUTE`：
    // 后者会带上 DisallowStartIfOnBatteries=true / StopIfGoingOnBatteries=true，
    // 笔记本在用电池时任务永远不启动，却仍然显示 Ready、下次运行时间照常往前走。
    // 实测踩到过：任务从注册起一次都没跑，Last Run Time 停在 1999/11/30。
    //
    // 还有一条必须写的：<Principals>。不写的话任务落在 Administrators 名下，
    // 当前用户对 C:\Windows\System32\Tasks\<name> 只有 (R)，`schtasks /Delete` 直接「拒绝访问」，
    // 用户自己卸不掉。实测：不带 Principals 删不掉，带上就能用普通权限删。
    const who = await run('whoami', ['/user', '/fo', 'csv', '/nh'], 15000);
    const sidMatch = (who.stdout || '').match(/(S-1-[0-9-]+)/);
    const userSid = sidMatch ? sidMatch[1] : null;
    if (!userSid) {
      return { ok: false, error: `取不到当前用户 SID，放弃创建任务（宁可没装，也不给你留一个卸不掉的任务）：${who.stderr.trim() || who.stdout.trim()}` };
    }
    const startBoundary = new Date(Date.now() + 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${startBoundary.getFullYear()}-${pad(startBoundary.getMonth() + 1)}-${pad(startBoundary.getDate())}`
      + `T${pad(startBoundary.getHours())}:${pad(startBoundary.getMinutes())}:00`;
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      '    <Description>dsh-anti-interrupt: start the DSH app when it is not running.</Description>',
      '  </RegistrationInfo>',
      '  <Principals>',
      '    <Principal id="Author">',
      `      <UserId>${userSid}</UserId>`,
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <AllowHardTerminate>true</AllowHardTerminate>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
      '    <IdleSettings>',
      '      <StopOnIdleEnd>false</StopOnIdleEnd>',
      '      <RestartOnIdle>false</RestartOnIdle>',
      '    </IdleSettings>',
      '    <AllowStartOnDemand>true</AllowStartOnDemand>',
      '    <Enabled>true</Enabled>',
      '    <Hidden>false</Hidden>',
      '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
      '    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>',
      '    <Priority>7</Priority>',
      '  </Settings>',
      '  <Triggers>',
      '    <TimeTrigger>',
      '      <Repetition>',
      '        <Interval>PT1M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      `      <StartBoundary>${stamp}</StartBoundary>`,
      '      <Enabled>true</Enabled>',
      '    </TimeTrigger>',
      '  </Triggers>',
      '  <Actions Context="Author">',
      '    <Exec>',
      '      <Command>C:\\Windows\\System32\\wscript.exe</Command>',
      `      <Arguments>//B "${bootGuardVbsPath}"</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      '',
    ].join('\r\n');
    const xmlPath = path.join(bootGuardDir, 'guard-task.xml');
    // schtasks /XML 读的是 UTF-16（带 BOM）
    await writeFile(xmlPath, Buffer.from(`\uFEFF${xml}`, 'utf16le'));

    const created = await run('schtasks', ['/Create', '/TN', bootGuardTask, '/XML', xmlPath, '/F'], 30000);
    const task = await taskState(bootGuardTask);
    const ok = created.ok && task.registered === true;
    return {
      ok,
      error: ok ? null : (created.stderr.trim() || `schtasks exit ${created.code}`),
      task,
      launcher: { path: launcher.path, image: launcher.image, from: launcher.from },
      files: { script: bootGuardScriptPath, cmd: bootGuardCmdPath, vbs: bootGuardVbsPath, xml: xmlPath, config: bootGuardConfigFile, log: bootGuardLogFile },
      powerPolicy: { disallowStartIfOnBatteries: false, stopIfGoingOnBatteries: false },
      schtasks: { exitCode: created.code, stdout: created.stdout.trim().slice(0, 600), stderr: created.stderr.trim().slice(0, 600) },
      howToRemove: 'nightwatch action=guard guardAction=uninstall（或工具栏「守夜」里点卸载）',
    };
  }

  async function bootGuardUninstall() {
    if (!isWin) return { ok: false, error: 'boot guard is Windows-only', platform: process.platform };
    const removed = await run('schtasks', ['/Delete', '/TN', bootGuardTask, '/F'], 30000);
    const task = await taskState(bootGuardTask);
    // 任务没删掉时**绝不能删脚本目录**：那会留下一个每分钟去执行不存在文件的空壳任务，
    // 每分钟闪一次错误窗口，比装之前更糟。实测踩到过一次。
    let dirRemoved = false;
    let dirError = null;
    if (task.registered) {
      dirError = '任务还在，脚本目录先保留（否则任务每分钟会去执行不存在的文件）';
    } else {
      try {
        await rm(bootGuardDir, { recursive: true, force: true });
        dirRemoved = true;
      } catch (error) {
        dirError = error && error.message ? error.message : String(error);
      }
    }
    const ok = task.registered === false;
    return {
      ok,
      error: ok ? null : (removed.stderr.trim() || removed.stdout.trim() || `schtasks exit ${removed.code}`),
      task,
      dirRemoved,
      dirError,
      schtasks: { exitCode: removed.code, stdout: removed.stdout.trim().slice(0, 400), stderr: removed.stderr.trim().slice(0, 400) },
    };
  }

  const definition = {
    name: 'nightwatch',
    description: '守夜插件：登录后自动续跑被中断的回合（读检查点并唤醒会话），查看/切换守夜开关，Windows 下还可按一次检查一次屏保与电源（关屏/睡眠）。不会替你改计划任务、不会结束任何进程；没装守夜底座时如实报「未安装」。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'toggle', 'check', 'checkpoint', 'continuity', 'guard'] },
        guardAction: { type: 'string', enum: ['status', 'install', 'uninstall'], description: 'guard 用：status 看状态，install 创建每分钟一次的计划任务（App 不在就启动它），uninstall 删掉任务与目录' },
        enabled: { type: 'boolean', description: 'toggle 用：true=开守夜（崩溃后自动续跑），false=关' },
        port: { type: 'integer', description: 'check 用：探测端口，默认 39999（一个没人听的端口）' },
        goal: { type: 'string', description: 'checkpoint 用：这一轮的目标（会写进续跑消息）' },
        nextAction: { type: 'string', description: 'checkpoint 用：被打断时下一步该做什么（关键步骤前后各写一次）' },
        note: { type: 'string', description: 'checkpoint 用：任意备注' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_input, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: (input) => input.action === 'status' || input.action === 'check' || input.action === 'continuity'
      || (input.action === 'guard' && (input.guardAction ?? 'status') === 'status'),
    async execute(input, exec) {
      if (input.action === 'status') return status();
      if (input.action === 'toggle') {
        if (typeof input.enabled !== 'boolean')
          throw new Error('toggle 需要 enabled: true|false');
        return { action: 'toggle', ...(await toggle(input.enabled)) };
      }
      if (input.action === 'check') {
        return { action: 'check', ...(await check(input.port ?? 39999)) };
      }
      if (input.action === 'guard') {
        const sub = input.guardAction ?? 'status';
        if (sub === 'install') return { action: 'guard', guardAction: sub, ...(await bootGuardInstall()) };
        if (sub === 'uninstall') return { action: 'guard', guardAction: sub, ...(await bootGuardUninstall()) };
        if (sub === 'status') return { action: 'guard', guardAction: sub, ...(await bootGuardStatus()) };
        throw new Error("guard 需要 guardAction: 'status' | 'install' | 'uninstall'");
      }
      if (input.action === 'checkpoint') {
        // 会话身份只能从工具执行上下文拿：exec.agent.session.id（ToolExecutionInput.agent 由 agent loop 填）
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? null;
        const state = await continuity.setCheckpoint(sessionId, {
          goal: input.goal,
          nextAction: input.nextAction,
          note: input.note,
        });
        return {
          action: 'checkpoint',
          file: continuity.fileFor(sessionId),
          sessionId,
          turnId: state.turnId,
          goal: state.goal,
          nextAction: state.nextAction,
          open: state.open,
          at: state.checkpointAt,
        };
      }
      if (input.action === 'continuity') {
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? null;
        const info = await continuity.describe(sessionId);
        return { action: 'continuity', ...info };
      }
      throw new Error(`unknown action: ${String(input.action)}`);
    },
  };

  ctx.tools.register(definition);

  // ---- t169/t173 续跑层（被打断的回合重启后能接着做）----
  // 检查点目录提前建好：队长/用户可直接看到落盘位置，不用等第一次 turn 发生。
  try {
    await mkdir(continuityDir, { recursive: true });
  } catch (error) {
    ctx.logger?.warn?.(`[nightwatch] continuity 目录创建失败：${error && error.message ? error.message : error}`);
  }

  // t173：插件自己的文件日志。上一轮真杀后 `server.log` 里一条 `[nightwatch]` 都没有——
  // 不是路径没执行，是 ctx.logger.info 根本没落到任何可读文件里，于是「没有日志」被误读成「没有执行」。
  // 现在关键动作（启动扫描/唤醒/失败原因）一律追加到 continuity/nightwatch.log，可当证据贴。
  const logFile = path.join(continuityDir, 'nightwatch.log');
  async function nlog(text) {
    const line = `${new Date().toISOString()} ${text}`;
    try {
      const st = await stat(logFile).catch(() => null);
      if (st && st.size > 1024 * 1024) await rename(logFile, `${logFile}.1`).catch(() => {});
      await appendFile(logFile, `${line}\n`, 'utf8');
    } catch { /* 文件日志失败不影响主链路 */ }
    try { ctx.logger?.info?.(`[nightwatch] ${text}`); } catch { /* ignore */ }
  }

  // 1) 检查点：事件驱动。turn/start 开、tool/call 记 lastToolCall、turn/end 关并推进已处理水位。
  //    监听 session/event 与 dsh-agent-loop 自己观测 tool 恢复时用的是同一条通道（agent-loop lib/index.js:976）。
  ctx.on('session/event', (session, event) => {
    // 返回 promise：emit 不看返回值，但测试桩/串行场景可以等它落盘（内容错也不许冒泡）。
    return continuity.observe(session, event).catch(() => {});
  });

  // 2) 唤醒器：崩溃重启后不靠任何人发消息，自己把回合接起来。
  //
  //    根因（t173，源码级）：上一版用的是 `agent.inject(msg)`，而它的实现是
  //      inject(input) { this.send(input, 'next-step', false); }   ← wakeup=false
  //    契约原文（dsh-agent/lib/types/runtime-types.d.ts:201-209）：
  //      "Queue model-facing context for the next pre-step **without waking the driver**.
  //       A running driver claims it ...; idle drivers leave it pending until follow-up or steering wakes them."
  //    所以空闲会话永远不会被 inject 唤醒——用户必须自己发一条消息，这正是「没有自动续跑」。
  //    正确入口是 `agent.followup(msg)`：
  //      followup(input) { this.send(input, 'next-turn', true); }   ← wakeup=true，会 wakeDriver()
  //    （dsh-agent-loop/lib/index.js:806-814）
  //
  //    第二个坑：崩溃重启后会话可能还没被前端打开，`agent/created` 根本不会触发。
  //    所以不再依赖它：启动后按「开着的检查点」主动 resolve 会话
  //    （sessionController.resolveAgent 会带 preset 组合把会话恢复成活的 agent，和前端打开会话同一条路），
  //    再 followup。
  const wakeRunner = createWakeRunner({
    ctx,
    continuity,
    readEnabled: async () => {
      const flag = await readJson(flagFile);
      return !!(flag.ok && flag.value && flag.value.enabled === true);
    },
    log: nlog,
  });

  ctx.on('agent/created', async ({ agent, source } = {}) => {
    try {
      const sid0 = agent?.session?.id;
      await nlog(`agent/created source=${source ?? '?'} session=${sid0 ?? '?'}`);
      if (!sid0) return;
      // 把事件里的 agent 直接带过去（创建期间它已在注册表里，不必再 resolve）；
      // 检测/登记同步做（和 t169 一致），只有「唤醒」推到下一拍，避免在 serial 监听器里重入驱动。
      await wakeRunner.wakeSession(sid0, `agent/created:${source ?? '?'}`, { knownAgent: agent, deferSend: true });
    } catch (error) {
      // 检测失败绝不能让 agent 创建失败（agent/created 是 serial，抛错会终止创建）
      await nlog(`agent/created 处理失败：${error && error.message ? error.message : error}`);
    }
  });

  // 3) 注入：pre-step waterfall。这是「用户自己发消息」那条路的兜底：
  //    decision.messages 里的消息会被 step() 按 `user/message` + surfaceOp:append 写进会话日志
  //    （dsh-agent-loop lib/index.js:1072），所以那一轮 prompt 里真的能看到这段续跑提示。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== 'enter') return decision;
    try {
      // 只在回合第一步注入，且只注入一次（ack 在 takePendingInjection 里先落盘）
      if (Number(payload?.step ?? 0) !== 1) return decision;
      const message = await continuity.takePendingInjection(payload?.agent);
      if (!message) return decision;
      await nlog(`续跑：已向会话 ${payload?.agent?.session?.id} 注入一条 ${SOURCE_KIND} 消息（用户回合兜底）`);
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      await nlog(`续跑注入失败：${error && error.message ? error.message : error}`);
      return decision;
    }
  });

  // 4) 启动扫描：不依赖 agent/created 是否触发。多拍重试，幂等。
  for (const delay of [6000, 20000, 45000, 90000, 180000]) {
    const timer = setTimeout(() => { wakeRunner.bootWake(`${delay}ms`).catch(() => {}); }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  // t160：守夜 web 按钮 + 弹窗；t163：一次性屏保动作 + 渲染自查回传。
  // 路由与 index 注入都挂在插件 fiber 生命周期上：插件被卸载（引擎重启/重载）时自动摘除，
  // 不会留下孤儿路由；index 注入是每次请求实时收集（webserver/index-inject 事件）。
  if (ctx.webServer) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: GUARD_ROUTE_PATH,
      handler: guardRoute(flagFile, screenScript, ctx.webServer.protocol, {
        isWin,
        platform: process.platform,
        originalFile,
        powerFile,
        bootGuard: { status: bootGuardStatus, install: bootGuardInstall, uninstall: bootGuardUninstall },
      }),
    }), 'nightwatch.guard-route');
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: SELFCHECK_ROUTE_PATH,
      handler: selfcheckRoute(selfcheckFile, ctx.webServer.protocol),
    }), 'nightwatch.selfcheck-route');
  }
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'body', text: CLIENT_UI_SCRIPT });
  });

  ctx.logger?.info?.(`[nightwatch] 已装载 v${VERSION}（dataDir=${dataDir}；guardKit=${kitInstalled ? 'installed' : 'not-installed'}；screen=${isWin ? 'on' : 'unsupported'}；flag=${flagFile}；screenScript=${screenScript}；continuity=${continuityDir}）`);
}
