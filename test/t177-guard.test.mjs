/**
 * t177：启动守护（防杀）的契约测试。
 *
 * 只验形状与默认值——**不创建任何计划任务**：install 会真的调 schtasks，
 * 属于对机器的写操作，不放进单测。真实安装/卸载往返用手跑，证据在提交说明里。
 *
 * 跑法：node test/t177-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href);

const tmp = await mkdtemp(path.join(tmpdir(), 'nw-t177-'));
const flagFile = path.join(tmp, 'guard-toggle.json');
await writeFile(flagFile, JSON.stringify({ enabled: false, screenGuard: false }), 'utf8');

const captured = { tools: [] };
const ctx = {
  tools: { register: (d) => captured.tools.push(d) },
  on: () => () => {},
  effect: (fn) => { const d = fn(); return () => d && d(); },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

await mod.apply(ctx, {
  flagFile,
  antiInterruptDir: path.join(tmp, 'kit'),
  continuityDir: path.join(tmp, 'continuity'),
  bootGuardDir: path.join(tmp, 'boot-guard'),
  bootGuardTask: 'dsh-anti-interrupt-guard-t177-dry',
});

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

const tool = captured.tools.find((t) => t.name === 'nightwatch');

await check('nightwatch 工具注册成功', () => {
  assert.ok(tool, 'tool 没注册');
});

await check('action 枚举包含 guard，并新增 guardAction 枚举', () => {
  const props = tool.parameters.properties;
  assert.ok(props.action.enum.includes('guard'), 'action 缺 guard');
  assert.deepEqual(props.guardAction.enum, ['status', 'install', 'uninstall']);
});

await check('guard 只在只读子动作上并发安全', () => {
  assert.equal(tool.isConcurrencySafe({ action: 'guard', guardAction: 'status' }), true);
  assert.equal(tool.isConcurrencySafe({ action: 'guard', guardAction: 'install' }), false);
  assert.equal(tool.isConcurrencySafe({ action: 'guard', guardAction: 'uninstall' }), false);
});

await check('包内随附守护脚本存在且非空', async () => {
  const info = await stat(path.join(root, 'scripts', 'boot-guard.ps1'));
  assert.ok(info.size > 500, `boot-guard.ps1 太小：${info.size}`);
});

await check('guardAction 非法时报错，不静默', async () => {
  await assert.rejects(
    () => tool.execute({ action: 'guard', guardAction: 'nonsense' }, {}),
    /guard/,
  );
});

// status 只读：临时目录没装过，必须如实报未安装
const bg = await tool.execute({ action: 'guard', guardAction: 'status' }, {});

await check('status 报未安装，并给出任务名与路径', () => {
  assert.equal(bg.installed, false, `不该报已安装：${JSON.stringify(bg.task)}`);
  assert.equal(bg.paths.task, 'dsh-anti-interrupt-guard-t177-dry');
  assert.ok(String(bg.paths.dir).includes('boot-guard'), 'paths.dir 不对');
  assert.ok(bg.what.includes('计划任务'), '缺少「装了什么」的说明');
});

await check('launcher 判定：要么给出 exe，要么给出理由', () => {
  if (bg.launcher.error) {
    assert.ok(bg.launcher.error.length > 5, 'error 太短');
  } else {
    assert.ok(/\.exe$/i.test(bg.launcher.path), `launcher 不是 exe：${bg.launcher.path}`);
    assert.ok(bg.launcher.image.endsWith('.exe'), 'image 不对');
  }
});

await check('status 不写盘：临时目录下没有 boot-guard', async () => {
  await assert.rejects(stat(path.join(tmp, 'boot-guard')), 'status 不该创建目录');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`PASS  ${r.name}`);
  else console.log(`FAIL  ${r.name}\n      ${r.error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
