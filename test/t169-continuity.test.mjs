/**
 * t169 独立测试桩：不重启引擎、不碰真实连续性目录。
 * 用 mock ctx 装载守夜插件，驱动真实的 `session/event`、`agent/created`、`agent/pre-step` 三条钩子，
 * 验证：检查点写入 / 中断检测（native+own 两路）/ pre-step 注入 / 幂等 / 无误报。
 *
 * 跑法：node test/t169-continuity.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href;
const mod = await import(pluginUrl);

const tmp = await mkdtemp(path.join(tmpdir(), 'nw-t169-'));
const continuityDir = path.join(tmp, 'continuity');
const flagFile = path.join(tmp, 'guard-toggle.json');
await writeFile(flagFile, JSON.stringify({ enabled: false, screenGuard: true }), 'utf8');

const handlers = new Map();
const captured = { tools: [], routes: [] };
const ctx = {
  tools: { register: (d) => captured.tools.push(d) },
  on: (ev, cb) => {
    if (!handlers.has(ev)) handlers.set(ev, []);
    handlers.get(ev).push(cb);
    return () => {};
  },
  effect: (fn) => { const d = fn(); return () => d && d(); },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

await mod.apply(ctx, { flagFile, antiInterruptDir: tmp, continuityDir });

const fire = (ev, ...args) => Promise.all((handlers.get(ev) ?? []).map((h) => h(...args)));
const fireWaterfall = async (ev, payload) => {
  const list = handlers.get(ev) ?? [];
  // 复刻 cordis waterfall：从后往前串；最内层是默认 next（保留当前消息）
  const defaultNext = async () => ({ kind: 'enter', messages: payload.messages });
  let index = list.length - 1;
  const runner = async (p, next) => {
    if (index < 0) return next();
    const handler = list[index];
    index -= 1;
    return handler(p, () => runner(p, next));
  };
  return runner(payload, defaultNext);
};
const fileFor = (sid) => path.join(continuityDir, `${sid}.json`);
const readState = async (sid) => JSON.parse(await readFile(fileFor(sid), 'utf8'));
const mkSession = (id, opts = {}) => ({ id, header: { id, isSeeded: false, ...opts }, snapshotEvents: () => opts.events ?? [] });
const ev = (type, data, time = Date.now()) => ({ type, seq: 0, time, data });
// t173：续跑有 6 小时新鲜度上限（WAKE_MAX_AGE_MS），测试时间基准必须跟着现在走；
// 用 17949xxxxxx 这种固定时间戳，过几小时就变成「过期检查点」，唤醒会被（正确地）跳过。
const T = Date.now();

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error && error.message ? error.message : error) });
  }
};

// ---------- 1. 检查点：turn/start / tool/call / turn/end ----------
const sidA = 'session-aaaa-1111';
const sessA = mkSession(sidA);
await fire('session/event', sessA, ev('turn/start', { turn: 7 }, T - 120000));
let stateA = await readState(sidA);
check('turn/start 写出检查点且 open:true', () => {
  assert.equal(stateA.sessionId, sidA);
  assert.equal(stateA.turnId, 7);
  assert.equal(stateA.open, true);
  assert.equal(stateA.ack, true, '正常开始不该出现待注入');
  assert.ok(stateA.at, 'at 应有值');
});

await fire('session/event', sessA, ev('tool/call', { turn: 7, step: 2, name: 'pwsh', callId: 'call_x', arguments: '{"description":"长命令"}' }, T - 110000));
stateA = await readState(sidA);
check('tool/call 记下 lastToolCall', () => {
  assert.equal(stateA.lastToolCall.name, 'pwsh');
  assert.equal(stateA.lastToolCall.callId, 'call_x');
  assert.equal(stateA.lastToolCall.turn, 7);
});

// 模型显式写 nextAction（走 nightwatch action=checkpoint）
const nightwatch = captured.tools.find((t) => t.name === 'nightwatch');
const exec = { agent: { session: { id: sidA } } };
const cp = await nightwatch.execute({ action: 'checkpoint', goal: 't169 续跑层', nextAction: '复测注入' }, exec);
stateA = await readState(sidA);
check('action=checkpoint 写入 goal/nextAction', () => {
  assert.equal(cp.action, 'checkpoint');
  assert.equal(stateA.goal, 't169 续跑层');
  assert.equal(stateA.nextAction, '复测注入');
});

// ---------- 2. 中断检测（own 兜底路：有 open:true，日志尾没有 closer）----------
// 模拟「进程被杀」：不再有 turn/end，直接进 resume
const sessA_resume = mkSession(sidA, { events: [ev('turn/start', { turn: 7 }), ev('tool/call', { turn: 7, step: 2, name: 'pwsh', callId: 'call_x' })] });
await fire('agent/created', { agent: { session: sessA_resume }, source: 'resume' });
stateA = await readState(sidA);
check('resume 检出中断并置 pending/ack=false', () => {
  assert.equal(stateA.interrupted, true);
  assert.equal(stateA.pending, true);
  assert.equal(stateA.ack, false);
  assert.equal(stateA.interruptedTurn, 7);
  assert.ok(['own-checkpoint-open', 'open-tail'].includes(stateA.interruptSource), `source=${stateA.interruptSource}`);
});

// ---------- 3. pre-step 注入 + 幂等 ----------
const userMsg = { role: 'user', id: 'u-1', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } };
const decision = await fireWaterfall('agent/pre-step', {
  agent: { session: { id: sidA } },
  messages: [userMsg],
  turn: 8,
  step: 1,
  signal: new AbortController().signal,
});
check('pre-step(step=1) 追加一条 zero-one-continuity 消息', () => {
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'zero-one-continuity');
  assert.ok(typeof injected.id === 'string' && injected.id.length > 10, '需要带 id（会话日志校验要求）');
  const text = injected.content.map((b) => b.text).join('\n');
  assert.match(text, /守夜续跑/);
  assert.match(text, /turn 7/);
  assert.match(text, /pwsh/);
  assert.match(text, /t169 续跑层/);
  assert.match(text, /复测注入/);
});
stateA = await readState(sidA);
const injectedAt = stateA.ackAt;
check('ack 在注入后置 true 且记录 injections', () => {
  assert.equal(stateA.ack, true);
  assert.equal(stateA.pending, false);
  assert.ok(Array.isArray(stateA.injections) && stateA.injections.length === 1);
  assert.equal(stateA.injections[0].turn, 7);
});

// 第二次 pre-step：不应再注入
const decision2 = await fireWaterfall('agent/pre-step', {
  agent: { session: { id: sidA } },
  messages: [userMsg],
  turn: 9,
  step: 1,
  signal: new AbortController().signal,
});
check('幂等：同一次中断只注入一次', () => {
  assert.equal(decision2.messages.length, 1, '第二次不该再追加');
});

// 同一中断下再 resume 一次，也不该重新注入
await fire('agent/created', { agent: { session: sessA_resume }, source: 'resume' });
stateA = await readState(sidA);
const decision3 = await fireWaterfall('agent/pre-step', {
  agent: { session: { id: sidA } },
  messages: [userMsg],
  turn: 10,
  step: 1,
  signal: new AbortController().signal,
});
check('再 resume 一次也不重复注入（水位门禁）', () => {
  assert.equal(stateA.pending, false);
  assert.equal(decision3.messages.length, 1);
  assert.equal(stateA.ackAt, injectedAt, 'ackAt 不该被改写');
});

// ---------- 4. 无误报：正常结束的回合 + resume ----------
const sidB = 'session-bbbb-2222';
const sessB = mkSession(sidB);
const eventsB = [ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } })];
await fire('session/event', sessB, eventsB[0]);
await fire('session/event', sessB, eventsB[1]);
let stateB = await readState(sidB);
check('turn/end completed 关闭检查点并推进水位', () => {
  assert.equal(stateB.open, false);
  assert.equal(stateB.closedReason.kind, 'completed');
  assert.equal(stateB.handledThroughTurn, 1);
});
const sessB_resume = mkSession(sidB, { events: eventsB });
await fire('agent/created', { agent: { session: sessB_resume }, source: 'resume' });
stateB = await readState(sidB);
const decisionB = await fireWaterfall('agent/pre-step', {
  agent: { session: { id: sidB } },
  messages: [userMsg],
  turn: 2,
  step: 1,
  signal: new AbortController().signal,
});
check('无误报：正常回合后 resume 不产生中断消息', () => {
  assert.equal(stateB.interrupted, false);
  assert.equal(stateB.pending, false);
  assert.equal(decisionB.messages.length, 1);
});

// ---------- 5. 用户取消（aborted）不算中断 ----------
const sidC = 'session-cccc-3333';
const sessC = mkSession(sidC);
const eventsC = [ev('turn/start', { turn: 3 }), ev('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })];
await fire('session/event', sessC, eventsC[0]);
await fire('session/event', sessC, eventsC[1]);
await fire('agent/created', { agent: { session: mkSession(sidC, { events: eventsC }) }, source: 'resume' });
const stateC = await readState(sidC);
check('用户主动取消（aborted/user）不注入', () => {
  assert.equal(stateC.pending, false);
  assert.equal(stateC.interrupted, false);
});

// ---------- 6. native 标记路：引擎崩溃恢复补的 interrupted closer ----------
const sidD = 'session-dddd-4444';
const sessD = mkSession(sidD);
await fire('session/event', sessD, ev('turn/start', { turn: 5 }, T - 90000));
await fire('session/event', sessD, ev('tool/call', { turn: 5, step: 1, name: 'long', callId: 'call_d' }, T - 85000));
const eventsD = [
  ev('turn/start', { turn: 5 }),
  ev('tool/call', { turn: 5, step: 1, name: 'long', callId: 'call_d' }),
  ev('turn/end', { turn: 5, reason: { kind: 'interrupted' } }, T - 80000),
];
await fire('agent/created', { agent: { session: mkSession(sidD, { events: eventsD }) }, source: 'resume' });
const stateD = await readState(sidD);
check('native：turn/end{interrupted} 被识别（优先于 own 兜底）', () => {
  assert.equal(stateD.interrupted, true);
  assert.equal(stateD.pending, true);
  assert.equal(stateD.interruptSource, 'native-turn-end');
  assert.equal(stateD.interruptedTurn, 5);
  assert.equal(stateD.interruptedAt, new Date(T - 80000).toISOString());
});

// ---------- 7. 首次见到会话（没有检查点文件）不重放历史中断 ----------
const sidE = 'session-eeee-5555';
const eventsE = [
  ev('turn/start', { turn: 1 }),
  ev('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, T - 70000),
  ev('turn/start', { turn: 2 }),
  ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, T - 60000),
];
await fire('agent/created', { agent: { session: mkSession(sidE, { events: eventsE }) }, source: 'resume' });
const stateE = await readState(sidE);
check('首次见到会话只登记水位、不注入历史中断', () => {
  assert.equal(stateE.pending, false);
  assert.equal(stateE.interrupted, false);
  assert.equal(stateE.handledThroughTurn, 2);
});

// ---------- 8. 子代理会话不建检查点 ----------
const sidF = 'session-ffff-6666';
await fire('session/event', mkSession(sidF, { delegationDepth: 1 }), ev('turn/start', { turn: 1 }));
let subFileExists = true;
try {
  await readFile(fileFor(sidF), 'utf8');
} catch {
  subFileExists = false;
}
check('子代理会话（delegationDepth=1）不写检查点', () => {
  assert.equal(subFileExists, false);
});

// ---------- 9. 工具注册面没退化 ----------
check('nightwatch 工具仍注册且新增 checkpoint/continuity 两个 action', () => {
  assert.ok(nightwatch, 'nightwatch 工具仍注册');
  const actions = nightwatch.parameters.properties.action.enum;
  for (const action of ['status', 'toggle', 'check', 'checkpoint', 'continuity']) {
    assert.ok(actions.includes(action), `缺 action ${action}`);
  }
});
const continuityInfo = await nightwatch.execute({ action: 'continuity' }, exec);
check('action=continuity 能读回状态（验收：ack 前后对照）', () => {
  assert.equal(continuityInfo.action, 'continuity');
  assert.equal(continuityInfo.exists, true);
  assert.equal(continuityInfo.state.sessionId, sidA);
  assert.equal(continuityInfo.state.ack, true);
});

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed, results }, null, 2));
await rm(tmp, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
