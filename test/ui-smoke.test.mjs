// UI 真实 DOM 冒烟（改进方案 #1 A 档）：happy-dom 提供真实 DOM 语义（对比 render-test 的
// 手写桩件），加载 index.html 骨架 + 全部 ui/*.js（按 script 清单顺序），断言：
// 11 个 tab 的渲染入口都不抛、api() 走 fetch 桩、登录表单提交走通。
// **缺 happy-dom 时自动跳过** —— D6 约定：更新器用 --omit=dev 不装 devDeps，
// 这条 skip 路径是必须守住的（不许删；删了更新器环境会红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  // 只有"依赖确实没装"才跳过（生产/更新器环境是 npm ci --omit=dev）；装了却加载失败
  // （版本与 Node 不兼容 / 包损坏）必须抛出去 —— 否则这层门禁静默消失，CI 照样绿（2026-10-01 审查）。
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
const TABS = [...new Set([...RAW_HTML.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))];

function settle(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  // 骨架进 DOM；script 标签不交给 happy-dom 自己加载，由测试按清单手动按序执行
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const fetchLog = [];
  const cfgStub = {
    api: { model: 'smoke-model', maxRounds: 3 },
    allow: { groups: ['10001', '20002'], private: [] },
    server: {}, runtime: { mode: 'observe' },
    webSearch: { enabled: false }, asr: {}, tts: {},
    identityPilot: {}, slangPilot: {}, incidentPilot: {}, memory: {}
  };
  window.fetch = async (url) => {
    fetchLog.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/config') ? cfgStub : {})
    };
  };
  // 浏览器标准全局：happy-dom 的 vm 上下文里没有 structuredClone，而 UI 代码（时间控制草稿、
  // 按群覆盖草稿）用它做深拷贝 —— 补上，别让"浏览器里有、测试里没有"的差异把用例判红。
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  }
  window.EventSource = class EventSourceStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event?.error ?? event?.message ?? event)));
  const ctx = vm.createContext(window);
  for (const file of SCRIPT_FILES) {
    const raw = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(toClassicScript(raw, file), { filename: `ui/${file}` }).runInContext(ctx);
  }
  return { window, fetchLog, errors };
}

test('真实 DOM 冒烟：加载全部脚本、11 个 tab 切换入口不抛', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    assert.ok(SCRIPT_FILES.length >= 12, `脚本清单应含 i18n+core+app+8 外挂，实际 ${SCRIPT_FILES.length}`);
    assert.deepEqual(errors, [], `加载期出现未捕获错误：${errors.join(' | ')}`);
    assert.ok(typeof window.switchTab === 'function', 'switchTab 应可用');
    const failed = [];
    for (const tab of TABS) {
      try {
        window.switchTab(tab);
        await settle(30);
      } catch (error) {
        failed.push(`${tab}: ${error?.message ?? error}`);
      }
    }
    assert.deepEqual(failed, [], `这些 tab 的渲染入口抛错：${failed.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：api() 走 fetch 桩', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const data = await window.api('/api/smoke-probe');
    assert.ok(fetchLog.includes('/api/smoke-probe'), `fetch 桩应收到调用，实际：${fetchLog.slice(0, 5).join(', ')}`);
    assert.deepEqual(data, {}, '桩返回空对象');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：登录表单提交打到 /api/login 且不抛', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const form = window.document.querySelector('#console-login-form');
    assert.ok(form, 'index.html 应含 #console-login-form');
    const input = form.querySelector('input');
    if (input) input.value = 'smoke-token';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(150);
    assert.ok(fetchLog.some((u) => u.includes('/api/login')), `提交应请求 /api/login，实际：${fetchLog.slice(0, 6).join(', ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

// 去插件化（§11 C2）之后的交互层覆盖：render-test 只验"渲染不抛"，这里验"钩子真的改写了输出"。
// 这条断言的由来：stable-features.js 原先靠 `window[name] = wrapped` 包裹渲染函数，
// 改成 QARegistry 注册后，"注册了但没人调用"会变成静默失效 —— 页面照常渲染，只是改造没了。
test('真实 DOM 冒烟：QARegistry 的 transform / after / override 真的接上了渲染入口', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    const { QARegistry } = window;
    assert.ok(QARegistry, 'index.html 必须先加载 core/registry.js');

    const cfg = {
      identityPilot: { enabled: false, graduated: false },
      slangPilot: {}, incidentPilot: {},
      api: {}, allow: {}, server: {}, runtime: {}
    };

    // ① transform：返回值被钩子改写（stable-features 的"摘掉已转正/退役控件"走的就是这条）
    const before = window.renderExperimentalSettingsSection(cfg);
    assert.ok(typeof before === 'string' && before.length > 0, '原实现应返回 html');
    QARegistry.onTransform('renderExperimentalSettingsSection', (html) => `${html}<!--smoke-transform-->`);
    const after = window.renderExperimentalSettingsSection(cfg);
    assert.ok(after.includes('<!--smoke-transform-->') && !before.includes('<!--smoke-transform-->'),
      '注册 transform 后，渲染函数的输出应被改写');

    // ② after：原实现跑完后触发（stable-features 在此挂"全局管理员"面板）
    // 注意：app.js 的 `const state` 是全局**词法**绑定，不挂 window（只有函数声明会挂），
    // 所以这里不能写 window.state.xxx —— 渲染函数自己闭包取 state 就行。
    let afterCalls = 0;
    QARegistry.onAfter('renderIdentityFeaturePage', () => { afterCalls += 1; });
    window.renderIdentityFeaturePage({ active: true, people: 0, aliases: 0, sources: 0, legacyMemories: 0, friends: 0 }, [], []);
    assert.equal(afterCalls, 1, 'after 钩子应在渲染函数返回后触发一次');

    // ③ override：整体接管（status-refresh.js 接管 refreshStatus 走的就是这条）
    QARegistry.override('refreshStatus', async () => 'smoke-override');
    assert.equal(await window.refreshStatus(), 'smoke-override', 'override 应接管全局入口');
    assert.equal(typeof QARegistry.base('refreshStatus'), 'function', 'override 之后仍能取回原实现');
  } finally { window.happyDOM?.abort?.(); }
});

// P1（2026-10-07 独立复审）：patch 装配挂错了分区 —— 平台能力页的开关全在 settings-save.js
// 的 `sec === 'chat'` 块里，在这一页点保存时 patch 为空（界面还提示"已保存"），开关只能手改
// config.json 才生效。这条用例走真实点按路径：切 tab → 点侧边栏分区 → 改控件 → 点保存，
// 断言 POST 体里真的有这一页的控件 —— 纯渲染断言（"不抛"）咬不住这类"存不下去"。
//
// 2026-10-07 第二批（设置细化）：读/写拆开（15 个门控键）+ 每项的工具清单占位 +
// 四个闸门配额可改 + 按群覆盖编辑器。这条用例同时钉住"UI 的键表 == 服务端的键表"：
// 在服务端加一个门控键而 UI 没跟上（或反过来），下面第一个 deepEqual 就会红。
test('真实 DOM 冒烟：「平台能力」页的开关/配额/按群覆盖能真的存下去（保存块不许挂错分区）', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    const { PLATFORM_GATE_KEYS, PLATFORM_QUOTA_KEYS } = await import('../src/core/platform-gates.js');
    window.switchTab('settings');
    await settle(50);
    const menuItem = window.document.querySelector('.settings-menu-item[data-section="platform"]');
    assert.ok(menuItem, '设置侧边栏应有「平台能力」入口');
    menuItem.click();
    await settle(80);

    // ① 渲染侧：门控复选框必须与服务端键表一一对应
    const renderedIds = [...window.document.querySelectorAll('#settings-form input[type="checkbox"]')]
      .map((el) => el.id).filter(Boolean).sort();
    // 门控键 + 三个"行为开关"（正在输入 / 标已读 / 日报卡片 —— 它们不是工具门控，但仍归这一页）
    assert.deepEqual(renderedIds,
      [...PLATFORM_GATE_KEYS.map((k) => `cfg-platform-${k.toLowerCase()}`),
        'cfg-typing', 'cfg-platform-readreceipts', 'cfg-platform-forwardcards'].sort(),
      '「平台能力」页的开关集合与服务端门控键表不一致（服务端加键、UI 没跟上就会红）');
    // 每个键都要有"它管的工具"占位（工具名由 /api/platform/gates 异步补）
    const slots = [...window.document.querySelectorAll('[data-gate-tools]')].map((el) => el.dataset.gateTools).sort();
    assert.deepEqual(slots, [...PLATFORM_GATE_KEYS].sort(), '每个门控键都要有工具清单占位');
    // 配额输入框按服务端的配额键表渲染
    const quotaIds = [...window.document.querySelectorAll('#settings-form input[type="number"]')]
      .map((el) => el.id).filter((id) => id.startsWith('cfg-platform-quota-')).sort();
    assert.deepEqual(quotaIds, PLATFORM_QUOTA_KEYS.map((k) => `cfg-platform-quota-${k}`).sort(),
      '四个闸门配额都要有输入框');
    // 按群覆盖编辑器：白名单的群可切换，且每个门控键都有三态下拉
    assert.ok(window.document.querySelector('#pergroup-group'), '按群覆盖要有"选择群"下拉');
    const perIds = [...window.document.querySelectorAll('[data-pergroup-key]')].map((el) => el.dataset.pergroupKey).sort();
    assert.deepEqual(perIds, [...PLATFORM_GATE_KEYS].sort(), '按群覆盖要覆盖全部门控键');
    // 行之间不许有游离字符：外层 map 返回数组、忘了 flat() 的话 join 会塞进逗号（真机踩过）
    const perText = window.document.querySelector('#pergroup-rows')?.textContent || '';
    assert.ok(!perText.includes(','), `按群覆盖区出现了游离的逗号：${perText.slice(0, 60)}`);

    // ② 行为侧：改四个控件（门控复选框 / 音色 / 配额 / 按群覆盖），保存后都要在 POST 体里
    const writeBox = window.document.querySelector('#cfg-platform-reactionswrite');
    assert.equal(writeBox.checked, true, '未配置时按内置默认：读写都开');
    writeBox.checked = false;
    const voiceSel = window.document.querySelector('#cfg-platform-voicechar');
    assert.ok(voiceSel, '「语音音色」下拉应渲染');
    voiceSel.insertAdjacentHTML('beforeend', '<option value="lucy-voice-daji">妲己</option>');
    voiceSel.value = 'lucy-voice-daji';
    const quota = window.document.querySelector('#cfg-platform-quota-avatarsPerWeek');
    assert.ok(quota, '换头像配额输入框应渲染');
    quota.value = '5';
    const perSel = window.document.querySelector('#pergroup-albumWrites');
    assert.ok(perSel, '按群覆盖：相册点赞/评论该有三态下拉');
    perSel.value = 'on';
    perSel.dispatchEvent(new window.Event('change'));
    // 切到别的群再切回来：草稿不丢（切群只是换渲染的数据源）
    const groupSel = window.document.querySelector('#pergroup-group');
    assert.equal(groupSel.value, '10001', '默认选中第一个白名单群');
    groupSel.value = '20002';
    groupSel.dispatchEvent(new window.Event('change'));
    assert.equal(window.document.querySelector('#pergroup-albumWrites').value, '', '另一个群没覆盖过 → 跟随全局');
    groupSel.value = '10001';
    groupSel.dispatchEvent(new window.Event('change'));
    assert.equal(window.document.querySelector('#pergroup-albumWrites').value, 'on', '切回来草稿要还在');

    const posts = [];
    window.fetch = async (url, options = {}) => {
      posts.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
      return { ok: true, status: 200, json: async () => ({ config: {} }) };
    };
    window.document.querySelector('#save-cfg-btn').click();
    await settle(120);

    const save = posts.find((p) => p.url.includes('/api/config') && p.method === 'POST');
    assert.ok(save, '点「保存设置」必须 POST /api/config');
    const patch = JSON.parse(save.body || '{}');
    assert.equal(patch.platform?.reactionsWrite, false, '改过的开关要按界面状态存下去（挂了错误分区时这里是 undefined）');
    assert.equal(patch.platform?.reactions, true, '没动过的读开关按当前值存');
    assert.equal(patch.platform?.readReceipts, false, '默认关的项没勾 = false');
    assert.equal(patch.platform?.avatarWrites, false, '换头像默认关（没勾就是 false）');
    assert.equal(patch.platform?.qqVoiceCharacter, 'lucy-voice-daji', '选中的音色要跟着保存');
    assert.equal(patch.platform?.quotas?.avatarsPerWeek, 5, '改过的配额要存下去');
    assert.deepEqual(patch.platform?.perGroup, { __replace__: { '10001': { albumWrites: true } } },
      '按群覆盖要带 __replace__ 存下去（普通深合并删不掉旧覆盖）');
    assert.deepEqual(Object.keys(patch.platform || {}).sort(),
      [...PLATFORM_GATE_KEYS, 'qqVoiceCharacter', 'quotas', 'perGroup', 'readReceipts', 'forwardCards'].sort(),
      '这一页的每个控件都要进 patch（漏一个 = 下次的"配了不生效"）');
    assert.equal(patch.send?.typingIndicator, true, '「正在输入」也归这一页保存');
    // 保存映射不许再手写第二份键清单（必须用 platform.js 的共享键表）
    const saveSrc = fs.readFileSync(path.join(UI, 'pages', 'settings-save.js'), 'utf8');
    assert.ok(saveSrc.includes('ALL_GATE_KEYS') && saveSrc.includes('gateCheckboxId'),
      '保存映射要用 platform.js 的键表/命名约定（手抄清单迟早与渲染漂掉）');
  } finally { window.happyDOM?.abort?.(); }
});
