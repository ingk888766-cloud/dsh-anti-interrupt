/**
 * 守夜 web UI（t163 纠正版）：注入到 dsh web index 的工具栏行内小按钮 + 弹窗。
 *
 * t163 纠正（用户 + 队长追加验收）：
 *  - 按钮是工具栏那一行里的**行内小件**：插在 PUA 胶囊之后、同一父容器；
 *    高度/圆角/内边距/底色/字色/字号照抄 PUA 胶囊的 computed style，不自造图标，纯文字「守夜」；
 *    MutationObserver 重扫幂等（data-nightwatch-button 去重，任何时刻该按钮 ≤ 1 个）。
 *  - 「防屏保中断」按一次 = 检查一次：POST screenAction 'disable'/'restore'，
 *    用脚本返回的 JSON（state.active / note / warning）刷新开关与提示；失败必须显示 stderr/exit code。
 *  - mount 成功后把按钮与 PUA 胶囊的 getBoundingClientRect + 实例数 POST 到 /api/nightwatch/selfcheck，
 *    服务端落盘，验收用真实读数（不靠截图「看起来像」）。
 *
 * 本字符串会被原样塞进 webserver 的 <script> index 注入行，
 * 因此全文禁止出现 "</script" 序列、反引号与 "${"。
 */
export default String.raw`(function () {
  'use strict';
  if (window.__nightwatchUiV2) { return; }
  window.__nightwatchUiV2 = true;

  var API = '/api/nightwatch/guard';
  var SELFCHECK = '/api/nightwatch/selfcheck';
  var KEY = 'data-nightwatch-button';
  var state = { enabled: false, screenActive: null, screenGuardIntent: false, screenSupported: true };

  function el(tag, styles, text) {
    var n = document.createElement(tag);
    if (styles) {
      for (var k in styles) {
        try { n.style[k] = styles[k]; } catch (e) { /* ignore */ }
      }
    }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  // ---- 工具栏行内小按钮：纯文字，样式在 mount 时照抄 PUA 胶囊 ----
  var btn = el('button', {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: 'auto',
    minWidth: 'auto',
    boxSizing: 'border-box',
    margin: '0 4px',
    whiteSpace: 'nowrap',
    cursor: 'pointer'
  }, '守夜');
  btn.type = 'button';
  btn.setAttribute(KEY, '1');
  btn.title = '守夜：查看防中断 / 防屏保（按一次检查一次）';

  // ---- 弹窗 ----
  var backdrop = el('div', {
    position: 'fixed', inset: '0', background: 'rgba(6,8,12,0.62)', zIndex: '2147483000',
    display: 'none', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)'
  });
  var card = el('div', {
    width: '336px', maxWidth: '92vw',
    background: 'var(--dsw-alias-bg-layer-2, #1a1f2b)',
    color: 'var(--dsw-alias-label-primary, #e2e7f2)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
    borderRadius: '14px', boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
    padding: '18px', fontFamily: 'inherit'
  });
  var titleRow = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' });
  var title = el('div', { fontSize: '15px', fontWeight: '600' }, '守夜');
  var closeBtn = el('button', {
    background: 'transparent', border: '0', color: 'var(--dsw-alias-label-secondary, #8b93a5)',
    fontSize: '18px', lineHeight: '18px', cursor: 'pointer', padding: '2px 8px', borderRadius: '6px'
  }, '×');
  closeBtn.title = '关闭';
  closeBtn.addEventListener('mouseenter', function () { closeBtn.style.background = 'rgba(255,255,255,0.08)'; });
  closeBtn.addEventListener('mouseleave', function () { closeBtn.style.background = 'transparent'; });
  titleRow.appendChild(title);
  titleRow.appendChild(closeBtn);
  card.appendChild(titleRow);

  function makeRow(key, label, desc) {
    var row = el('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))'
    });
    var texts = el('div', { flex: '1' });
    texts.appendChild(el('div', { fontSize: '13px', fontWeight: '500' }, label));
    texts.appendChild(el('div', { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #8b93a5)', marginTop: '2px' }, desc));
    var sw = el('label', { position: 'relative', display: 'inline-block', width: '36px', height: '20px', flex: 'none', cursor: 'pointer' });
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.opacity = '0';
    cb.style.width = '0';
    cb.style.height = '0';
    var track = el('span', { position: 'absolute', inset: '0', background: '#3a4152', borderRadius: '999px', transition: 'background .18s ease' });
    var knob = el('span', {
      position: 'absolute', left: '2px', top: '2px', width: '16px', height: '16px',
      background: '#eef1f7', borderRadius: '50%', transition: 'transform .18s ease'
    });
    sw.appendChild(cb);
    sw.appendChild(track);
    sw.appendChild(knob);
    function paint() {
      track.style.background = cb.checked ? 'var(--dsw-alias-link, #4176e6)' : '#3a4152';
      knob.style.transform = cb.checked ? 'translateX(16px)' : 'none';
    }
    paint();
    row.appendChild(texts);
    row.appendChild(sw);
    return { row: row, cb: cb, paint: paint };
  }

  var rows = {};
  rows.enabled = makeRow('enabled', '防重启中断', '崩溃后自动续跑（持久开关）；装了守夜底座时还会自动重开工作台');
  rows.screenGuard = makeRow('screenGuard', '防屏保中断', '按一次检查一次：开→关掉屏保/关屏/睡眠；关→恢复原始值（Windows）');
  rows.enabled.cb.addEventListener('change', function () {
    saveEnabled(rows.enabled.cb.checked);
  });
  rows.screenGuard.cb.addEventListener('change', function () {
    saveScreenGuard(rows.screenGuard.cb.checked);
  });
  card.appendChild(rows.enabled.row);
  card.appendChild(rows.screenGuard.row);

  // ---- 启动守护（防杀）：不是开关，是一个显式动作。装了什么、怎么卸，都写在行里。----
  var bootRow = el('div', {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))'
  });
  var bootTexts = el('div', { flex: '1' });
  var bootTitle = el('div', { fontSize: '13px', fontWeight: '500' }, '启动守护（防杀）');
  var bootDesc = el('div', {
    fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #8b93a5)', marginTop: '2px'
  }, '每分钟查一次：App 不在就启动它。会创建一个计划任务，可随时卸掉');
  bootTexts.appendChild(bootTitle);
  bootTexts.appendChild(bootDesc);
  var bootBtn = el('button', {
    flex: 'none', minWidth: '60px', padding: '5px 12px', borderRadius: '8px', cursor: 'pointer',
    fontSize: '12px', fontFamily: 'inherit',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18))',
    background: 'transparent', color: 'var(--dsw-alias-label-primary, #e2e7f2)'
  }, '安装');
  bootBtn.type = 'button';
  bootRow.appendChild(bootTexts);
  bootRow.appendChild(bootBtn);
  card.appendChild(bootRow);

  var boot = { installed: false, supported: true, busy: false };

  function paintBootGuard(bg) {
    if (!bg) { return; }
    boot.installed = bg.installed === true;
    boot.supported = bg.supported !== false;
    if (!boot.supported) {
      bootRow.style.display = 'none';
      return;
    }
    bootRow.style.display = '';
    var taskName = (bg.paths && bg.paths.task) || '';
    bootBtn.textContent = boot.installed ? '卸载' : '安装';
    if (boot.installed) {
      var img = (bg.launcher && bg.launcher.image) || '?';
      bootDesc.textContent = '已装｜任务 ' + taskName + '｜启动器 ' + img;
      bootBtn.title = '点一下删掉计划任务和这个目录';
    } else {
      bootDesc.textContent = (bg.launcher && bg.launcher.error)
        ? bg.launcher.error
        : '每分钟查一次：App 不在就启动它。会创建一个计划任务，可随时卸掉';
      bootBtn.title = '装一个每分钟一次的计划任务：App 不在就启动它';
    }
  }

  bootBtn.addEventListener('click', function () {
    if (boot.busy) { return; }
    var want = boot.installed ? 'uninstall' : 'install';
    boot.busy = true;
    bootBtn.disabled = true;
    setStatus(want === 'install' ? '正在安装启动守护…' : '正在卸载…');
    http('POST', { bootGuard: want }).then(function (j) {
      var bg = j && j.bootGuard;
      paintBootGuard(bg);
      if (!bg) { setStatus('服务端没有返回守护状态', true); return; }
      if (want === 'install') {
        setStatus(bg.ok
          ? '已安装：计划任务 ' + ((bg.task && bg.task.task) || '') + '，每分钟检查一次'
          : '安装失败：' + (bg.error || '未知原因'), !bg.ok);
      } else {
        setStatus(bg.ok ? '已卸载：任务和目录都删了' : '卸载未完成，任务可能还在', !bg.ok);
      }
    }, function (e) {
      setStatus('操作失败：' + String((e && e.message) || e), true);
    }).then(function () {
      boot.busy = false;
      bootBtn.disabled = false;
    });
  });

  var statusLine = el('div', { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #8b93a5)', marginTop: '10px', minHeight: '14px' });
  card.appendChild(statusLine);

  backdrop.appendChild(card);
  (document.body || document.documentElement).appendChild(backdrop);

  function setStatus(text, isErr) {
    statusLine.textContent = text || '';
    statusLine.style.color = isErr ? '#e06c6c' : 'var(--dsw-alias-label-secondary, #8b93a5)';
  }

  function http(method, body) {
    var opt = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(API, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { throw new Error((j && j.error) || ('HTTP ' + r.status)); }
        return j;
      });
    });
  }

  function paintFromJson(j) {
    var s = j && j.script && j.script.json;
    if (s && s.state && typeof s.state.active === 'number') {
      // 只更新「屏保真实状态」，**不再拿它决定开关勾选**。
      state.screenActive = s.state.active;
    }
    if (j && j.guard) {
      if (typeof j.guard.enabled === 'boolean') {
        state.enabled = j.guard.enabled;
        rows.enabled.cb.checked = state.enabled;
        rows.enabled.paint();
      }
      // t175：开关勾选 = 开关意图（guard-toggle.json 的 screenGuard），不是屏保当前状态。
      // 否则「屏保开 + 开关开」会显示成关、「屏保关 + 开关关」会显示成开，点了方向就反了。
      if (typeof j.guard.screenGuard === 'boolean') {
        state.screenGuardIntent = j.guard.screenGuard;
        rows.screenGuard.cb.checked = state.screenGuardIntent;
        rows.screenGuard.paint();
      }
    }
  }

  function refresh() {
    setStatus('读取中…');
    return http('GET').then(function (j) {
      paintFromJson(j);
      paintBootGuard(j && j.bootGuard);
      // 平台门禁：非 Windows 时屏保/电源行直接隐藏，并说明原因
      if (j && j.supported === false) {
        state.screenSupported = false;
        rows.screenGuard.row.style.display = 'none';
        setStatus('屏保/电源守卫仅支持 Windows；自动续跑不受影响', false);
        return j;
      }
      state.screenSupported = true;
      rows.screenGuard.row.style.display = '';
      setStatus((j && j.error) ? ('读取异常：' + j.error) : '');
      return j;
    }, function (e) {
      setStatus('读取失败：' + String((e && e.message) || e), true);
      throw e;
    });
  }

  // 打开弹窗时「检查一次」屏保现状（只读 status 动作，不改任何设置）
  function screenStatus() {
    if (state.screenSupported === false) { return Promise.resolve(null); }
    setStatus('检查屏保现状…');
    return http('POST', { screenAction: 'status' }).then(function (j) {
      paintFromJson(j);
      var s = j.script && j.script.json;
      if (j.script && j.script.ok !== true) {
        setStatus('检查失败：' + ((j.script.stderr || '') || ('exit ' + j.script.exitCode)), true);
        return j;
      }
      var note = (s && s.note) || '';
      if (s && s.state && typeof s.state.active === 'number') {
        // t175：开关状态看意图，屏保真实状态单独显示——两者本来就可能不一致
        setStatus('防屏保：' + (state.screenGuardIntent ? '开' : '关')
          + '｜屏保当前：' + (s.state.active === 0 ? '已关闭' : '开启中')
          + (note ? '（' + note + '）' : ''));
      } else {
        setStatus('屏保状态读不到' + (note ? '：' + note : ''));
      }
      return j;
    }, function (e) {
      setStatus('检查失败：' + String((e && e.message) || e), true);
      throw e;
    });
  }

  var saving = false;
  function saveEnabled(value) {
    if (saving) { return; }
    saving = true;
    setStatus('写入中…');
    http('POST', { enabled: value }).then(function (j) {
      saving = false;
      paintFromJson(j);
      setStatus('已保存 ' + new Date().toLocaleTimeString());
    }, function (e) {
      saving = false;
      rows.enabled.cb.checked = state.enabled;
      rows.enabled.paint();
      setStatus('写入失败：' + String((e && e.message) || e), true);
    });
  }

  // 一次性屏保动作：勾上 → 检查并关掉（disable）；取消 → 恢复原值（restore）。
  function saveScreenGuard(desired) {
    if (saving) { return; }
    saving = true;
    // 失败回滚用「意图」的旧值；用屏保真实状态来回滚会把开关拨到相反方向（t175）
    var prev = state.screenGuardIntent;
    setStatus('检查中…');
    http('POST', { screenAction: desired ? 'disable' : 'restore' }).then(function (j) {
      saving = false;
      var s = j.script && j.script.json;
      if (j.script && j.script.ok !== true) {
        // 脚本失败：必须把原因显示出来，不许「点了没反应」；开关回到原状
        if (typeof prev === 'boolean') { rows.screenGuard.cb.checked = prev; rows.screenGuard.paint(); }
        var why = (j.script.stderr || '').trim() || ('exit ' + j.script.exitCode) + (j.script.killed ? '（超时被杀）' : '');
        setStatus('检查失败：' + why, true);
        return;
      }
      paintFromJson(j);
      var note = (s && s.note) || '';
      var head = j.action === 'disable' ? '已检查：屏保关掉' : '已检查：屏保恢复';
      setStatus(head + (note ? '（' + note + '）' : '') + ' ' + new Date().toLocaleTimeString());
    }, function (e) {
      saving = false;
      if (typeof prev === 'boolean') { rows.screenGuard.cb.checked = prev; rows.screenGuard.paint(); }
      setStatus('检查失败：' + String((e && e.message) || e), true);
    });
  }

  function open() {
    backdrop.style.display = 'flex';
    refresh().then(function () {
      return screenStatus();
    }, function () {
      return screenStatus();
    });
  }
  function close() { backdrop.style.display = 'none'; }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) { close(); } });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && backdrop.style.display !== 'none') { close(); }
  });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    open();
  });

  // ---- 找 PUA 胶囊（同一行的参照件）：优先 pua-trigger 类，其次 aria-label，最后纯文本 ----
  function puaCapsule() {
    var withClass = document.querySelectorAll('button[class*="pua-trigger"]');
    if (withClass.length) { return withClass[0]; }
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var aria = all[i].getAttribute('aria-label') || '';
      if (aria.indexOf('PUA') === 0) { return all[i]; }
    }
    for (var j = 0; j < all.length; j++) {
      var t = (all[j].textContent || '').replace(/^\s+|\s+$/g, '');
      if (t === 'PUA' || t === '完全权限' || t === 'Full access') { return all[j]; }
    }
    return null;
  }

  // 照抄 PUA 胶囊的实际 computed style（高度/圆角/内边距/底色/字色/字号/边框/行高/字体）
  function adoptPuaStyle(pua) {
    var cs = window.getComputedStyle(pua);
    var keys = ['height', 'border-radius', 'padding', 'background', 'color', 'font-size', 'border', 'line-height', 'font-family'];
    for (var i = 0; i < keys.length; i++) {
      var v = cs.getPropertyValue(keys[i]);
      if (v) { btn.style.setProperty(keys[i], v); }
    }
    // t169（用户要求）：PUA 胶囊本身没有可见边框，照抄过来就「看不出是个按钮」。
    // 照抄之后**覆盖**描边 + 悬停反馈。box-sizing 已是 border-box，高度不会被撑大。
    btn.style.setProperty('border', '1px solid rgba(255,255,255,0.34)');
    btn.style.setProperty('box-shadow', 'inset 0 0 0 1px rgba(255,255,255,0.05)');
    btn.style.setProperty('transition', 'background .16s ease, border-color .16s ease');
    // t170（用户截图：文字偏右）：PUA 的 padding 不是左右对称、行高也可能带偏移，
    // 照抄后文字会被挤到一边。这里显式改成交互控件该有的居中，用对称 padding + 居中三件套。
    btn.style.setProperty('box-sizing', 'border-box');
    btn.style.setProperty('display', 'inline-flex');
    btn.style.setProperty('align-items', 'center');
    btn.style.setProperty('justify-content', 'center');
    btn.style.setProperty('text-align', 'center');
    btn.style.setProperty('text-indent', '0');
    btn.style.setProperty('padding', '0 12px');
    btn.style.setProperty('line-height', '1');
    btn.style.setProperty('min-width', '0');
    btn.style.setProperty('width', 'auto');
    var puaBg = cs.getPropertyValue('background');
    btn.addEventListener('mouseenter', function () {
      btn.style.setProperty('background', 'rgba(255,255,255,0.10)');
      btn.style.setProperty('border-color', 'rgba(255,255,255,0.52)');
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.setProperty('background', puaBg);
      btn.style.setProperty('border-color', 'rgba(255,255,255,0.34)');
    });
    return true;
  }

  // 幂等去重：同一 DOM 里只允许一个守夜按钮；顺带清掉 t160 版无标记的旧按钮
  function dedupe() {
    var nodes = document.querySelectorAll('[' + KEY + ']');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== btn) { try { nodes[i].remove(); } catch (e) { /* ignore */ } }
    }
    var olds = document.querySelectorAll('button');
    for (var j = 0; j < olds.length; j++) {
      var o = olds[j];
      if (o === btn || o.hasAttribute(KEY)) { continue; }
      var t = (o.textContent || '').replace(/^\s+|\s+$/g, '');
      if (t === '守夜' || t === '♡ 守夜' || t === '🛡 守夜' || t === '♡守夜' || t === '🛡守夜') {
        try { o.remove(); } catch (e) { /* ignore */ }
      }
    }
    return document.querySelectorAll('[' + KEY + ']').length;
  }

  // 挂载后把真实 rect + 实例数回传给服务端（验收读数），节流 3 秒一次
  var lastReport = 0;
  function reportOnce() {
    var now = Date.now();
    if (now - lastReport < 3000) { return; }
    lastReport = now;
    window.setTimeout(function () {
      if (!btn.isConnected) { return; }
      var r = btn.getBoundingClientRect();
      var pua = puaCapsule();
      var pr = pua ? pua.getBoundingClientRect() : null;
      var count = document.querySelectorAll('[' + KEY + ']').length;
      // t170：文字是否真的居中 —— 用 Range 量文字盒再和按钮盒比中心，给可核对数字而不是靠眼看
      var textDeltaX = null, padLeft = null, padRight = null;
      try {
        var range = document.createRange();
        range.selectNodeContents(btn);
        var tr = range.getBoundingClientRect();
        if (tr && tr.width > 0) {
          textDeltaX = Math.round((((tr.left + tr.right) / 2) - ((r.left + r.right) / 2)) * 10) / 10;
          padLeft = Math.round((tr.left - r.left) * 10) / 10;
          padRight = Math.round((r.right - tr.right) * 10) / 10;
        }
      } catch (e) { /* ignore */ }
      var payload = {
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        puaWidth: pr ? Math.round(pr.width * 10) / 10 : null,
        puaHeight: pr ? Math.round(pr.height * 10) / 10 : null,
        count: count,
        textDeltaX: textDeltaX,
        padLeft: padLeft,
        padRight: padRight,
        href: String(location.href).split('?')[0],
        at: new Date().toISOString()
      };
      try {
        fetch(SELFCHECK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) { /* ignore */ }
    }, 400);
  }

  function mount() {
    dedupe();
    if (btn.isConnected) { reportOnce(); return true; }
    var pua = puaCapsule();
    if (!pua) { return false; }
    adoptPuaStyle(pua);
    // 插在 PUA 胶囊之后：同一父容器、同一行，不换行、不占满
    pua.insertAdjacentElement('afterend', btn);
    var ok = btn.isConnected && btn.parentElement === pua.parentElement;
    if (ok) {
      dedupe();
      reportOnce();
    }
    return ok;
  }

  var observer = new MutationObserver(function () { mount(); });
  function start() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', function () { start(); });
    }
  }
  start();

  // 有界延迟重试（仅按钮挂载用，最多 5 次，与屏保无关；不设任何周期任务）
  var retries = 0;
  (function retry() {
    if (retries >= 5 || btn.isConnected) { return; }
    retries += 1;
    window.setTimeout(function () {
      if (!btn.isConnected) { mount(); }
      retry();
    }, 2000);
  })();
})();
`;
