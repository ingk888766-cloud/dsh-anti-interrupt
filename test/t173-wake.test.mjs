/**
 * t173 唤醒器独立测试：不启动引擎、不碰真实连续性目录。
 *
 * 要证明的只有一件事：**续跑用的是 followup（会唤醒驱动），不是 inject（永远叫不醒空闲会话）**。
 * 顺带覆盖：开关关闭不唤醒 / 过期检查点不唤醒 / 正在跑的回合不复放 / resolve 失败不抛。
 *
 * 跑法：node test/t173-wake.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href);
const contMod = await import(pathToFileURL(path.join(root, 'lib', 'continuity.js')).href);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error && error.message ? error.message : error) });
  }
}

const tmpRoots = [];
async function makeDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nw-t173-'));
  tmpRoots.push(dir);
  return dir;
}

/** 直接落一份「开着没闭合」的检查点，模拟进程被杀那一刻的磁盘状态。 */
async function seedOpenState(dir, sessionId, { at = new Date().toISOString(), turnId = 3, handledThroughTurn = 2 } = {}) {
  await mkdir(dir, { recursive: true });
  const state = {
    sessionId,
    turnId,
    goal: 't173 自动续跑',
    nextAction: '重启后不等用户发消息，直接续跑',
    lastToolCall: { name: 'pwsh', callId: 'call_x', turn: turnId, step: 4, at, argsPreview: '{"command":"Start-Sleep 200"}' },
    at,
    open: true,
    closedReason: null,
    handledThroughTurn,
    interrupted: false,
    interruptedAt: null,
    interruptSource: null,
    interruptedTurn: null,
    ack: true,
    ackAt: null,
    pending: false,
    injections: [],
    firstSeenAt: at,
    updatedAt: at,
  };
  await writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function mkAgent(sessionId, { status = 'idle', events } = {}) {
  const calls = { followup: [], inject: [], steer: [], send: [] };
  const agent = {
    session: {
      id: sessionId,
      header: { id: sessionId, isSeeded: false },
      snapshotEvents: () => events ?? [
        { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 3 } },
        { type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 3, step: 4, name: 'pwsh', callId: 'call_x' } },
      ],
    },
    status,
    followup: (m) => calls.followup.push(m),
    inject: (m) => calls.inject.push(m),
    steer: (m) => calls.steer.push(m),
    send: (m, target, wakeup) => calls.send.push({ m, target, wakeup }),
  };
  return { agent, calls };
}

/**
 * cordis 真实规则：服务属性访问必须在插件 inject 名单里，否则抛
 * "cannot get property ... without inject"。所以这里 **故意** 让 ctx.agents 抛，
 * 只提供 ctx.get('agents') —— 真杀那次 6 秒扫描就栽在这，必须由测试钉住。
 */
function mkCtx({ agent, resolve } = {}) {
  const agentsRegistry = { get: () => undefined };
  return {
    get: (name) => {
      if (name === 'agents') return agentsRegistry;
      if (name === 'sessionController') {
        return { resolve: resolve ?? (async () => ({ agent })) };
      }
      return undefined;
    },
    get agents() {
      throw new Error('cannot get property "agents" without inject');
    },
  };
}

// ---------- 1. 正常续跑：用 followup，不用 inject ----------
await check('开着的回合 → resolve 会话 → followup 唤醒（inject 次数必须为 0）', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-aaaa';
  await seedOpenState(dir, sid);
  const continuity = contMod.createContinuity({ dir });
  const { agent, calls } = mkAgent(sid);
  const runner = mod.createWakeRunner({
    ctx: mkCtx({ agent }),
    continuity,
    readEnabled: async () => true,
  });
  const out = await runner.bootWake('test-1');
  assert.equal(calls.followup.length, 1, 'followup 必须被调用一次');
  assert.equal(calls.inject.length, 0, 'inject 永远不能用来唤醒');
  assert.equal(calls.steer.length, 0);
  assert.ok(out.results[0].woken, `应标记 woken: ${JSON.stringify(out)}`);
  const msg = calls.followup[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'zero-one-continuity');
  assert.match(msg.content[0].text, /守夜续跑/);
  const saved = JSON.parse(await readFile(path.join(dir, `${sid}.json`), 'utf8'));
  assert.equal(saved.ack, true, '注入后必须落 ack');
  assert.equal(saved.pending, false);
  assert.equal(saved.injections.length, 1);
});

// ---------- 2. 幂等：同一检查点不会被唤醒两次 ----------
await check('重复扫描不二次唤醒（ack 已消费）', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-bbbb';
  await seedOpenState(dir, sid);
  const continuity = contMod.createContinuity({ dir });
  const { agent, calls } = mkAgent(sid);
  const runner = mod.createWakeRunner({ ctx: mkCtx({ agent }), continuity, readEnabled: async () => true });
  await runner.bootWake('first');
  await runner.bootWake('second');
  assert.equal(calls.followup.length, 1, '第二次扫描不能再唤醒');
});

// ---------- 3. 开关关闭：不续跑 ----------
await check('守夜开关关闭 → 不唤醒', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-cccc';
  await seedOpenState(dir, sid);
  const continuity = contMod.createContinuity({ dir });
  const { agent, calls } = mkAgent(sid);
  const runner = mod.createWakeRunner({ ctx: mkCtx({ agent }), continuity, readEnabled: async () => false });
  const out = await runner.bootWake('disabled');
  assert.equal(out.skipped, 'disabled');
  assert.equal(calls.followup.length, 0);
});

// ---------- 4. 过期检查点：不续跑 ----------
await check('检查点超过 6 小时 → 不唤醒', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-dddd';
  await seedOpenState(dir, sid, { at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() });
  const continuity = contMod.createContinuity({ dir });
  const { agent, calls } = mkAgent(sid);
  const runner = mod.createWakeRunner({ ctx: mkCtx({ agent }), continuity, readEnabled: async () => true });
  await runner.wakeSession(sid, 'stale');
  assert.equal(calls.followup.length, 0);
});

// ---------- 5. 正在跑的回合：不复放 ----------
await check('agent.status=running → 跳过（别把用户正在等的回合当崩溃）', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-eeee';
  await seedOpenState(dir, sid);
  const continuity = contMod.createContinuity({ dir });
  const { agent, calls } = mkAgent(sid, { status: 'running' });
  const runner = mod.createWakeRunner({ ctx: mkCtx({ agent }), continuity, readEnabled: async () => true });
  const out = await runner.wakeSession(sid, 'running');
  assert.equal(out.skipped, 'running');
  assert.equal(calls.followup.length, 0);
});

// ---------- 6. resolve 失败：不抛、写日志 ----------
await check('sessionController.resolve 失败 → 不抛，记错误', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-ffff';
  await seedOpenState(dir, sid);
  const continuity = contMod.createContinuity({ dir });
  const logs = [];
  const ctx = {
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionController'
      ? { resolve: async () => ({ error: { code: 'session/not-found', message: 'gone' } }) }
      : undefined),
  };
  const runner = mod.createWakeRunner({ ctx, continuity, readEnabled: async () => true, log: async (t) => logs.push(t) });
  const out = await runner.wakeSession(sid, 'resolve-fail');
  assert.ok(out.error, `应有 error：${JSON.stringify(out)}`);
  assert.ok(logs.some((l) => l.includes('续跑失败')), `应写失败日志：${logs.join(' | ')}`);
});

// ---------- 7. agent/created 接线：resume 的会话也会被 followup ----------
await check('agent/created 接线（mock ctx）→ followup 被调用', async () => {
  const dir = await makeDir();
  const sid = 'session-t173-gggg';
  await seedOpenState(dir, sid);
  const { agent, calls } = mkAgent(sid);
  const handlers = new Map();
  const ctx = {
    tools: { register: () => {} },
    on: (ev, cb) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(cb); return () => {}; },
    effect: (fn) => { const d = fn(); return () => d && d(); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => (name === 'sessionController' ? { resolve: async () => ({ agent }) } : undefined),
    agents: { get: () => undefined },
  };
  const flagFile = path.join(dir, 'guard-toggle.json');
  await writeFile(flagFile, JSON.stringify({ enabled: true }), 'utf8');
  await mod.apply(ctx, { flagFile, antiInterruptDir: dir, continuityDir: dir });
  for (const h of handlers.get('agent/created') ?? []) {
    await h({ agent, source: 'resume' });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.followup.length, 1, `followup 应被调用一次，实际 ${calls.followup.length}`);
  assert.equal(calls.inject.length, 0);
});

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true }).catch(() => {});
if (failed.length > 0) process.exitCode = 1;
