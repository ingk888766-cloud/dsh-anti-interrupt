/**
 * 续跑层（t169）：连续性检查点 + 中断检测 + pre-step 注入。
 *
 * 为什么需要它：看门狗能把「外壳死了」重开，但**被打断的那一步**没有任何交接记录。
 * 用户在 2026-11-17 23:43:25 跑一条长命令时工作台整体被杀，23:45:18 被拉起，
 * 那一轮的工具调用结果永久丢失（系统提示 interrupted, outcome unknown）。
 *
 * 三条链路：
 *  1. 检查点：监听 `session/event`，在 `turn/start` 写 open:true、在 `tool/call` 记 lastToolCall、
 *     在 `turn/end` 关闭并推进「已处理水位」。goal/nextAction 由模型通过 nightwatch 工具显式写
 *     （`action: 'checkpoint'`）——V1 不做自动推断。
 *  2. 中断检测：`agent/created` 且 source==='resume' 时判定这一轮是否「没有正常收尾」。
 *     两个信号，native 优先：
 *       native — 引擎自己崩溃恢复时会给未闭合的尾回合补 `turn/end {reason:{kind:'interrupted'}}`
 *                （dsh-session 的 interruptedTurnClosers）；这是权威信号，能区分 interrupted / aborted(user) / completed。
 *       own    — 我们自己的检查点 open:true（进程被杀得早、日志尾没 flush 时的兜底）。
 *     只有 turn 号 **大于水位** 才算新中断：否则每次 resume 都会拿历史里那条老 interrupted 反复注入。
 *  3. 注入：`agent/pre-step`（waterfall）里，若本会话有未 ack 的中断记录，就往 decision.messages
 *     追加一条 `source.kind = 'zero-one-continuity'` 的 user 消息；引擎随后按 `user/message`
 *     + surfaceOp:append 写进会话日志（dsh-agent-loop step() 内），所以下一轮 prompt 里真的会出现。
 *     注入前先把 ack 落盘 → 同一次中断只注入一次。
 *
 * 边界：只读写 `continuity/` 下自己的 JSON；不解析、不改写会话日志格式；不碰引擎核心。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** 注入消息的生产者标识。MessageSourceMap 是 merge-extensible 的，所以自定义 kind 合法。 */
export const SOURCE_KIND = 'zero-one-continuity';
/** 注入记录最多保留多少条（文件有界）。 */
const MAX_INJECTIONS = 20;
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

function safeId(id) {
  const text = String(id ?? '');
  return SAFE_ID.test(text) ? text : text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

function isoOf(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function localOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 只认顶层会话：子代理（delegationDepth>0 / origin==='subagent'）不写检查点，避免文件爆量。 */
function isTopLevel(session) {
  const header = session && session.header;
  if (!header) return false;
  if (header.origin === 'subagent') return false;
  return !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0);
}

/**
 * 在会话日志里找「尾回合有没有正常收尾」。只看最后一条 turn/end 与它之后的 turn/start：
 *  native 中断 = 最后一条 turn/end 的 reason.kind === 'interrupted' 且它属于最后一个 turn；
 *  open tail = 最后一个 turn/start 之后没有 turn/end（引擎还没来得及补 closer）。
 */
export function scanTail(events) {
  const list = Array.isArray(events) ? events : [];
  let lastStart = null;
  let lastEnd = null;
  const interruptedAll = [];
  for (const event of list) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'turn/start') lastStart = event;
    else if (event.type === 'turn/end') {
      lastEnd = event;
      const kind = event.data?.reason && typeof event.data.reason === 'object' ? event.data.reason.kind : event.data?.reason;
      if (kind === 'interrupted') {
        interruptedAll.push({
          turn: Number(event.data?.turn ?? 0),
          seq: event.seq ?? null,
          time: typeof event.time === 'number' ? event.time : null,
          at: isoOf(event.time),
        });
      }
    }
  }
  const startTurn = lastStart?.data?.turn;
  const endTurn = lastEnd?.data?.turn;
  const openTail = lastStart !== null && (lastEnd === null || Number(startTurn) > Number(endTurn));
  const reason = lastEnd?.data?.reason;
  const kind = reason && typeof reason === 'object' ? reason.kind : reason;
  return {
    lastTurn: Number.isFinite(Number(startTurn)) ? Number(startTurn) : 0,
    lastEndTurn: Number.isFinite(Number(endTurn)) ? Number(endTurn) : 0,
    lastEndReason: kind ?? null,
    lastEndAt: isoOf(lastEnd?.time),
    lastEndTime: typeof lastEnd?.time === 'number' ? lastEnd.time : null,
    lastStartAt: isoOf(lastStart?.time),
    lastStartTime: typeof lastStart?.time === 'number' ? lastStart.time : null,
    openTail,
    /**
     * 日志里**所有**被引擎补过 interrupted 收尾的回合（不只是尾部那一条）。
     * 尾部判据只在「刚重启那一刻」成立；玩家又干了几轮之后，那条 closer 就退到中间了，
     * 所以判定要用「全部 interrupted 里 turn 号最大且 > 水位」的那一条。
     */
    interruptedAll,
    nativeInterrupted: kind === 'interrupted' && !openTail ? { turn: Number(endTurn ?? 0), at: isoOf(lastEnd?.time), time: lastEnd?.time ?? null } : null,
  };
}

export function createContinuity(options = {}) {
  const dir = path.resolve(String(options.dir ?? ''));
  const logger = options.logger ?? null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  /** sessionId → state（内存镜像，避免每步都读盘） */
  const cache = new Map();
  /** sessionId → 串行写队列，防同一会话并发写互相覆盖 */
  const chains = new Map();

  const fileFor = (sessionId) => path.join(dir, `${safeId(sessionId)}.json`);

  function log(level, message) {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`[nightwatch:continuity] ${message}`);
    } catch { /* 日志失败绝不影响主链路 */ }
  }

  async function readState(sessionId) {
    if (cache.has(sessionId)) return cache.get(sessionId);
    try {
      const text = await readFile(fileFor(sessionId), 'utf8');
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (value && typeof value === 'object') {
        cache.set(sessionId, value);
        return value;
      }
    } catch { /* 不存在或坏文件：当作没有 */ }
    return null;
  }

  /** 串行 + 原子写（tmp+rename）：同会话的写不会互相踩。 */
  function persist(state) {
    const sessionId = state.sessionId;
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(dir, { recursive: true });
      const target = fileFor(sessionId);
      const tmp = `${target}.tmp`;
      const body = JSON.stringify(state, null, 2);
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, target);
      cache.set(sessionId, state);
    }).catch((error) => {
      log('warn', `persist ${sessionId} failed: ${error && error.message ? error.message : error}`);
    });
    chains.set(sessionId, next);
    return next;
  }

  function blank(sessionId) {
    return {
      sessionId,
      turnId: null,
      goal: null,
      nextAction: null,
      lastToolCall: null,
      at: null,
      open: false,
      closedReason: null,
      handledThroughTurn: 0,
      interrupted: false,
      interruptedAt: null,
      interruptSource: null,
      interruptedTurn: null,
      ack: true,
      ackAt: null,
      pending: false,
      injections: [],
      firstSeenAt: null,
      updatedAt: null,
    };
  }

  function touch(state) {
    state.updatedAt = isoOf(now());
    return state;
  }

  /**
   * 会话事件观察：turn/start → open；tool/call → lastToolCall；turn/end → 关闭 + 推进水位。
   * 永远不抛：监听器抛错会被引擎按 contained 记录，但没必要污染日志。
   */
  async function observe(session, event) {
    try {
      if (!isTopLevel(session) || !event || typeof event.type !== 'string') return;
      const sessionId = session.id;
      if (!sessionId) return;
      const loaded = await readState(sessionId);
      const state = loaded ?? blank(sessionId);
      if (state.firstSeenAt === null) state.firstSeenAt = isoOf(now());

      if (event.type === 'turn/start') {
        const turn = Number(event.data?.turn);
        state.turnId = Number.isFinite(turn) ? turn : state.turnId;
        state.open = true;
        state.closedReason = null;
        state.at = isoOf(event.time) ?? isoOf(now());
        await persist(touch(state));
        return;
      }
      if (event.type === 'tool/call') {
        const data = event.data ?? {};
        state.lastToolCall = {
          name: typeof data.name === 'string' ? data.name : null,
          callId: typeof data.callId === 'string' ? data.callId : null,
          turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : state.turnId,
          step: Number.isFinite(Number(data.step)) ? Number(data.step) : null,
          at: isoOf(event.time) ?? isoOf(now()),
          argsPreview: typeof data.arguments === 'string' ? data.arguments.slice(0, 240) : null,
        };
        await persist(touch(state));
        return;
      }
      if (event.type === 'turn/end') {
        const turn = Number(event.data?.turn);
        state.open = false;
        state.closedReason = event.data?.reason ?? null;
        state.at = isoOf(event.time) ?? state.at;
        if (Number.isFinite(turn)) {
          state.handledThroughTurn = Math.max(Number(state.handledThroughTurn ?? 0), turn);
          state.turnId = Math.max(Number(state.turnId ?? 0), turn);
        }
        await persist(touch(state));
      }
    } catch (error) {
      log('warn', `observe failed: ${error && error.message ? error.message : error}`);
    }
  }

  /**
   * resume 时判定中断。返回 { interrupted, source, turn, at, seeded } 供调用方记录。
   * 首次见到该会话（没有检查点文件）时只登记水位、不注入 —— 否则装插件那一刻会把
   * 历史里所有老 interrupted（本次会话里 turn 1 与 turn 57）当成新中断重放一遍。
   */
  async function detectOnResume(session) {
    if (!isTopLevel(session) || !session?.id) return { interrupted: false, reason: 'not-top-level' };
    const sessionId = session.id;
    let events = [];
    try {
      if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents();
    } catch (error) {
      log('warn', `snapshotEvents failed: ${error && error.message ? error.message : error}`);
    }
    const tail = scanTail(events);
    const existing = await readState(sessionId);
    const state = existing ?? blank(sessionId);
    if (state.firstSeenAt === null) state.firstSeenAt = isoOf(now());

    if (existing === null) {
      state.handledThroughTurn = Math.max(Number(state.handledThroughTurn ?? 0), tail.lastTurn, tail.lastEndTurn);
      state.seededAt = isoOf(now());
      state.lastResumeAt = isoOf(now());
      await persist(touch(state));
      log('info', `seeded ${sessionId} through turn ${state.handledThroughTurn} (no injection for pre-existing interruptions)`);
      return { interrupted: false, seeded: true, turn: tail.lastTurn };
    }

    const watermark = Number(state.handledThroughTurn ?? 0);
    state.lastResumeAt = isoOf(now());

    let candidate = null;
    // 优先 native：日志里 turn 号最大的那条 interrupted 收尾（不限于尾部 —— 重启后又干了几轮时，
    // 那条 closer 已经退到日志中段了），且必须大于水位，否则就是把历史老中断重放一遍。
    const newestInterrupted = (Array.isArray(tail.interruptedAll) ? tail.interruptedAll : [])
      .filter((item) => Number(item.turn) > watermark)
      .sort((a, b) => Number(b.turn) - Number(a.turn))[0] ?? null;
    if (newestInterrupted) {
      candidate = {
        source: 'native-turn-end',
        turn: Number(newestInterrupted.turn),
        at: newestInterrupted.at,
        time: newestInterrupted.time,
      };
    } else if (state.open === true && Number(state.turnId ?? 0) > watermark) {
      candidate = {
        source: 'own-checkpoint-open',
        turn: Number(state.turnId),
        at: state.at,
        time: null,
      };
    } else if (tail.openTail && Number(tail.lastTurn) > watermark) {
      candidate = { source: 'open-tail', turn: Number(tail.lastTurn), at: isoOf(now()), time: null };
    }

    if (!candidate) {
      await persist(touch(state));
      return { interrupted: false, turn: tail.lastTurn, watermark, tail };
    }

    state.interrupted = true;
    state.interruptedAt = candidate.at ?? isoOf(now());
    state.interruptSource = candidate.source;
    state.interruptedTurn = candidate.turn;
    state.open = false;
    state.pending = true;
    state.ack = false;
    state.handledThroughTurn = Math.max(watermark, candidate.turn);
    await persist(touch(state));
    log('info', `detected interruption on resume: ${sessionId} turn ${candidate.turn} source=${candidate.source}`);
    return { interrupted: true, ...candidate, watermark };
  }

  function composeText(state) {
    const when = state.interruptedAt ?? state.at ?? '（时间未记录）';
    const local = (() => {
      const t = Date.parse(when);
      return Number.isFinite(t) ? localOf(t) : null;
    })();
    const tool = state.lastToolCall;
    const toolLine = tool
      ? `${tool.name ?? 'unknown'}（callId=${tool.callId ?? '-'}，turn ${tool.turn ?? '-'}${tool.step ? ` step ${tool.step}` : ''}，${tool.at ?? ''}）`
      : '（没有记录到工具调用）';
    return [
      '【守夜续跑 · zero-one-continuity】上一轮没有正常收尾就中断了（引擎进程被杀/崩溃），这一轮需要从这里接着做。',
      `- 中断回合：turn ${state.interruptedTurn ?? state.turnId ?? '?'}（检测来源：${state.interruptSource ?? 'unknown'}）`,
      `- 中断时间：${when}${local ? `（本地 ${local}）` : ''}`,
      `- 最后一个工具调用：${toolLine}`,
      `- 检查点目标：${state.goal ?? '（未记录，可由 nightwatch action=checkpoint 显式补）'}`,
      `- 检查点下一步：${state.nextAction ?? '（未记录）'}`,
      '',
      '请从这里继续：先核实上一个工具调用是否已经产生副作用（读命令可重试，写/删/发/付费类必须先验证外部状态），再决定重试还是接着做下一步；不要从头重做整轮。',
    ].join('\n');
  }

  /**
   * 取一条待注入消息（只取一次）：返回 user 消息对象，或 null。
   * ack 在返回**之前**落盘 —— 同一次中断不会注入第二次。
   */
  async function takePendingInjection(agent) {
    try {
      const sessionId = agent?.session?.id;
      if (!sessionId) return null;
      const state = await readState(sessionId);
      if (!state || state.pending !== true || state.ack === true) return null;
      const text = composeText(state);
      const message = {
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND },
      };
      const at = isoOf(now());
      state.pending = false;
      state.ack = true;
      state.ackAt = at;
      state.injections = [
        ...(Array.isArray(state.injections) ? state.injections : []),
        {
          at,
          turn: state.interruptedTurn ?? state.turnId ?? null,
          source: state.interruptSource ?? null,
          interruptedAt: state.interruptedAt ?? null,
          messageId: message.id,
          textPreview: text.slice(0, 240),
        },
      ].slice(-MAX_INJECTIONS);
      await persist(touch(state));
      log('info', `injected continuity message into ${sessionId} (turn ${state.interruptedTurn ?? '?'})`);
      return message;
    } catch (error) {
      log('warn', `takePendingInjection failed: ${error && error.message ? error.message : error}`);
      return null;
    }
  }

  /** 模型显式写检查点：只改 goal/nextAction（其余字段由事件驱动）。 */
  async function setCheckpoint(sessionId, patch = {}) {
    if (!sessionId) throw new Error('checkpoint 需要会话身份（在子代理/无会话环境里不可用）');
    const state = (await readState(sessionId)) ?? blank(sessionId);
    if (state.firstSeenAt === null) state.firstSeenAt = isoOf(now());
    if (typeof patch.goal === 'string') state.goal = patch.goal.slice(0, 2000);
    if (typeof patch.nextAction === 'string') state.nextAction = patch.nextAction.slice(0, 2000);
    if (typeof patch.note === 'string' && patch.note !== '') state.note = patch.note.slice(0, 2000);
    state.checkpointAt = isoOf(now());
    await persist(touch(state));
    return state;
  }

  /** 只读状态（验收用：ack 前后的对照）。 */
  async function describe(sessionId) {
    const state = sessionId ? await readState(sessionId) : null;
    return {
      dir,
      file: sessionId ? fileFor(sessionId) : null,
      exists: state !== null,
      state,
    };
  }

  /** 列出所有检查点文件（引擎启动时的一次性总览，只读）。 */
  async function listAll() {
    const out = [];
    try {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir(dir);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const sid = name.slice(0, -'.json'.length);
        const state = await readState(sid);
        if (state) out.push(state);
      }
    } catch { /* 目录还不存在 */ }
    return out;
  }

  return {
    dir,
    fileFor,
    observe,
    detectOnResume,
    takePendingInjection,
    setCheckpoint,
    describe,
    listAll,
    composeText,
  };
}

export default createContinuity;
