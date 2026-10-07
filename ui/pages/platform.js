// 「平台能力」设置分区（2026-10-07）：协议端 SnowLuma 接入的 QQ 平台能力开关。
// 口径与表情包/搜索/ASR 一致：开关关掉后，对应工具会被 orchestrator 从模型工具表里摘除、
// 提示词也不再教用法 —— 不只是"界面上隐藏"。个别项来自 send.*（正在输入），其余一对一映射
// config.platform.*；保存映射见 settings-save.js。
//
// 2026-10-07 第二批（用户："控制台设置可以详细一点"）：
//   ① 读 / 写拆开（"只让它看，不让它动手"要能单独配）；
//   ② 每个开关旁边列出它管的工具名 —— 从 /api/platform/gates 拉（**不在 ui 里再抄一份**，
//      抄一份就会在下次拆键时漏掉一半；拉失败只影响这行说明，不影响开关本身）；
//   ③ 四个写入闸门（贴表情/资料/备注/换头像）的每日上限可改、并显示当前用量；
//   ④ 按群覆盖（config.platform.perGroup）：某个群单独开/关某项，其余群跟随全局。
'use strict';

import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { state } from '../core/state.js';

// 门控键的显示顺序与标签（与 src/core/platform-gates.js 的键一一对应；
// 工具名从接口补，标签这边写死 —— 标签纯展示，键名错了下面那条锚点用例会红）。
const GATE_SECTIONS = [
  ['像群友一样的小动作', [
    ['reactionsWrite', '贴表情回应（给群里的消息贴表情）'],
    ['reactions', '看表情回应（谁贴了什么）'],
    ['qqVoice', 'QQ 原生语音（群聊限定）'],
    ['profileWrites', '改个性签名 / 在线状态'],
    ['remarkWrites', '改好友 / 群备注'],
    ['avatarWrites', '换 QQ 头像（账号级外观，默认关）'],
    ['nicknameWrites', '改 QQ 昵称 / 个性说明（账号级外观，默认关）']
  ]],
  ['信息与素材', [
    ['groupTools', '群资料：看简介 / 公告 / 荣誉'],
    ['groupWrites', '群签到 / 把消息设成群待办'],
    ['ocr', '服务端 OCR：读图上的文字'],
    ['groupFiles', '群文件：看目录 / 取下载直链'],
    ['groupFileSend', '群文件：发文件到群'],
    ['albumRead', '群相册：看相册与照片'],
    ['albumWrites', '群相册：点赞 / 评论'],
    ['albumUpload', '群相册：把图传进相册（默认关）']
  ]]
];

// 写入闸门：与 src/core/platform-gates.js 的 PLATFORM_QUOTA_DEFAULTS 一一对应
// （默认值只在这里做"输入框留空时的提示"，真正的默认值在服务端）。
const QUOTA_ROWS = [
  ['reactionsPerHour', '贴表情（每小时）', 30],
  ['profilePerDay', '签名 / 在线状态（每天）', 3],
  ['remarksPerDay', '备注（每天）', 5],
  ['avatarsPerDay', '换头像（每天）', 2]
];

const gateCheckboxId = (key) => `cfg-platform-${key.toLowerCase()}`;
const ALL_GATE_KEYS = GATE_SECTIONS.flatMap(([, rows]) => rows.map(([key]) => key));

/** 开关行：复选框 + 标签 + 工具清单占位（工具名由 hydrate 从接口补）。 */
function gateRowHtml(key, label) {
  const id = gateCheckboxId(key);
  return `    <div class="checkbox-row"><input type="checkbox" id="${id}" ${keyDefaultOn(key) ? 'checked' : ''} />
      <label for="${id}">${esc(label)}<span class="gate-tools muted" data-gate-tools="${esc(key)}"></span></label></div>`;
}

// 默认取向：只用于"首次渲染时复选框是否勾上"。真正的默认值在服务端（config-legacy），
// 页面渲染拿的是已保存配置，这里只兜"配置里没有这个键"的老配置。
const DEFAULT_OFF_KEYS = new Set(['avatarWrites', 'nicknameWrites', 'albumUpload']);
/** 键的内置默认取向（"默认关"= 未显式 true 就不放行）。渲染与保存兜底共用。 */
function gateDefaultOn(key) {
  return !DEFAULT_OFF_KEYS.has(key);
}
function keyDefaultOn(key) {
  const saved = state.config?.platform?.[key];
  return typeof saved === 'boolean' ? saved : gateDefaultOn(key);
}

/** 「平台能力」分区。 */
function renderPlatformSection(c) {
  const p = c.platform || {};
  const voiceChar = String(p.qqVoiceCharacter || '').trim();
  const quotas = p.quotas || {};
  const groups = (c.allow?.groups || []).map(String);
  return `
    ${GATE_SECTIONS.map(([title, rows]) => `
    <h3>${esc(title)}</h3>
${rows.map(([key, label]) => gateRowHtml(key, label)).join('\n')}`).join('\n')}
    <div class="row" style="margin:6px 0 10px 26px">
      <label for="cfg-platform-voicechar" style="margin-right:8px">语音音色</label>
      <select id="cfg-platform-voicechar" style="min-width:220px">
        <option value="">不固定（让它自己挑）</option>
        ${voiceChar ? `<option value="${esc(voiceChar)}" selected>${esc(voiceChar)}</option>` : ''}
      </select>
      <span class="hint muted" id="cfg-platform-voicechar-note">正在拉取音色列表…</span>
    </div>

    <h3>会话与呈现</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-typing" ${state.config?.send?.typingIndicator !== false ? 'checked' : ''} />
      <label for="cfg-typing">私聊发言前先亮「正在输入…」（群聊 QQ 没有输入状态，只对私聊生效）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-readreceipts" ${(c.platform?.readReceipts === true) ? 'checked' : ''} />
      <label for="cfg-platform-readreceipts">处理完的消息在 QQ 里标已读（默认关：开了之后你自己各端看不到未读小红点）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-platform-forwardcards" ${c.platform?.forwardCards !== false ? 'checked' : ''} />
      <label for="cfg-platform-forwardcards">群日报等长内容用「聊天记录卡片」发送（关掉＝回到一整段文本）</label></div>

    <h3>写入次数上限（防刷屏的闸门）</h3>
    <div class="hint" style="margin-bottom:8px">写死的默认值：贴表情 30 次/小时，资料 3 次/天、备注 5 次/天、换头像 2 次/天。
      留空 = 用默认值；填 0 或非法值也按默认处理（这是刹车，不是"不限量"开关）。上限硬顶 200。</div>
    ${QUOTA_ROWS.map(([key, label, dflt]) => `
    <div class="row" style="margin:4px 0 4px 0;align-items:center">
      <label for="cfg-platform-quota-${esc(key)}" style="min-width:190px">${esc(label)}</label>
      <input type="number" id="cfg-platform-quota-${esc(key)}" min="1" max="200" step="1"
        value="${esc(quotas[key] ?? dflt)}" style="width:90px" />
      <span class="hint muted" data-quota-used="${esc(key)}" style="margin-left:10px">正在读用量…</span>
    </div>`).join('')}

    <h3>按群覆盖（可选）</h3>
    <div class="hint" style="margin-bottom:8px">默认所有群都用上面的全局设置。想让某个群不一样（例如测试群全开、大群只给"看"）
      就在下面选群、逐项改成「开 / 关」；选「跟随全局」的项不受影响。覆盖只改本群，别的群照旧。</div>
    ${groups.length ? `
    <div class="row" style="margin:6px 0;align-items:center">
      <label for="pergroup-group" style="margin-right:8px">选择群</label>
      <select id="pergroup-group" style="min-width:220px">${groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select>
      <button type="button" class="btn btn-small" id="pergroup-clear" style="margin-left:10px">清除本群覆盖（回到跟随全局）</button>
      <span class="hint muted" id="pergroup-note" style="margin-left:10px"></span>
    </div>
    <div id="pergroup-rows">${'<!-- 逐项三态选择由 hydrate / 切群时渲染 -->'}</div>`
    : '<div class="hint">白名单里还没有群 —— 先在「聊天白名单」加群，再回来按群覆盖。</div>'}

    <div class="hint" style="margin-top:10px">
      这些能力来自协议端 SnowLuma 1.14.20+（线上已升到 1.14.22）。关掉的项不只是"不显示"：
      对应工具会从模型的工具表里摘除，模型不会再调用它们，也不会在提示词里看到用法。
    </div>`;
}

// ── 按群覆盖编辑器 ──
// 草稿挂在 state（保存时 settings-save.js 读它）：所有群的改动先落在草稿里，
// 切群只是换渲染的数据源，切来切去不会丢；点保存才 POST。
function perGroupDraft() {
  if (!state.platformPerGroupDraft || typeof state.platformPerGroupDraft !== 'object') {
    state.platformPerGroupDraft = structuredClone(state.config?.platform?.perGroup || {});
  }
  return state.platformPerGroupDraft;
}

function currentPerGroupId() {
  return String(document.getElementById('pergroup-group')?.value || '');
}

function renderPerGroupRows() {
  const box = document.getElementById('pergroup-rows');
  if (!box) return;
  const gid = currentPerGroupId();
  const draft = perGroupDraft();
  const overrides = (gid && draft[gid]) || {};
  // 注意：外层 map 返回的是数组 —— 必须 flat() 再 join，否则内层数组会被
  // Array#join 用逗号连接，页面上每行之间多出一个孤零零的 ","（真机 2026-10-07 截图发现）。
  box.innerHTML = GATE_SECTIONS.map(([, rows]) => rows.map(([key, label]) => {
    // 三态：'' 跟随全局 / 'on' 本群开 / 'off' 本群关（草稿里存的是布尔值，这里换算成下拉值）
    const cur = overrides[key] === undefined ? '' : (overrides[key] ? 'on' : 'off');
    const sel = (v, text) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${text}</option>`;
    return `
    <div class="row" style="margin:2px 0;align-items:center">
      <label for="pergroup-${esc(key)}" style="min-width:290px">${esc(label)}</label>
      <select id="pergroup-${esc(key)}" data-pergroup-key="${esc(key)}" style="min-width:150px">
        ${sel('', '跟随全局')}${sel('on', '本群：开')}${sel('off', '本群：关')}
      </select>
    </div>`;
  })).flat().join('');
  const n = Object.keys(overrides).length;
  const note = document.getElementById('pergroup-note');
  if (note) {
    const list = Object.entries(overrides).map(([k, v]) => `${k}=${v ? '开' : '关'}`);
    note.textContent = n ? `本群已覆盖 ${n} 项：${list.join('、')}` : '本群还没覆盖任何项（全部跟随全局）';
  }
  for (const el of box.querySelectorAll('[data-pergroup-key]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.pergroupKey;
      const g = currentPerGroupId();
      if (!g) return;
      const next = { ...(draft[g] || {}) };
      if (el.value === '') delete next[key];
      else next[key] = el.value === 'on';
      if (Object.keys(next).length) draft[g] = next;
      else delete draft[g];
      renderPerGroupRows();
    });
  }
}

function bindPerGroup() {
  const sel = document.getElementById('pergroup-group');
  const clear = document.getElementById('pergroup-clear');
  if (sel) sel.addEventListener('change', () => renderPerGroupRows());
  if (clear) clear.addEventListener('click', () => {
    const g = currentPerGroupId();
    const draft = perGroupDraft();
    if (g) delete draft[g];
    renderPerGroupRows();
  });
  renderPerGroupRows();
}

/**
 * 「语音音色」下拉的数据补全：目录只有协议端知道（按群返回），所以渲染时先只有
 * 「不固定」+ 已保存的值，这里再异步拉列表换成按分类分组的完整目录。
 * 拉取失败不清空已有选择 —— 页面照常能保存。
 */
async function hydratePlatformVoiceSelect() {
  const sel = document.getElementById('cfg-platform-voicechar');
  if (!sel) return;   // 不在这一页
  const note = document.getElementById('cfg-platform-voicechar-note');
  try {
    const data = await api('/api/onebot/ai-characters');
    const chars = Array.isArray(data?.characters) ? data.characters : [];
    const groups = new Map();
    for (const c of chars) {
      const cat = String(c?.category || '其它');
      if (!groups.has(cat)) groups.set(cat, []);
      const list = groups.get(cat);
      // 同一个音色会出现在多个分类里（协议端就是这么分的）：分类内部去重
      if (!list.some((x) => x.characterId === c.characterId)) list.push(c);
    }
    const saved = String(sel.value || '');
    sel.innerHTML = `<option value="">不固定（让它自己挑）</option>`
      + [...groups.entries()].map(([cat, list]) =>
        `<optgroup label="${esc(cat)}">${list.map((c) =>
          `<option value="${esc(c.characterId)}">${esc(c.name || c.characterId)}</option>`).join('')}</optgroup>`).join('');
    if (saved && !chars.some((c) => c.characterId === saved)) {
      // 已保存的音色不在目录里（协议端目录变了/是手改的）也要保留，否则一打开页面就把它抹了
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(saved)}">${esc(saved)}（已不在目录里）</option>`);
    }
    sel.value = saved;
    if (note) note.textContent = chars.length ? `共 ${chars.length} 个音色（来自群 ${data.groupId}）` : '协议端没返回任何音色';
  } catch (error) {
    if (note) note.textContent = `没拉到音色列表（${error?.message ?? error}）—— 当前显示的是已保存的音色，仍可保存`;
  }
}

/**
 * 工具清单 + 配额用量的补全（都在「平台能力」页；不在这一页时各自 no-op）。
 * 工具清单来自 /api/platform/gates（服务端的键→工具映射，唯一一份）。
 */
async function hydratePlatformGates() {
  const slots = [...document.querySelectorAll('[data-gate-tools]')];
  const quotaSlots = [...document.querySelectorAll('[data-quota-used]')];
  if (!slots.length && !quotaSlots.length) return;   // 不在这一页
  // 编辑器是同步渲染的；坏了只该"这一块没出来"，不该把整页设置跟着炸掉
  try { bindPerGroup(); } catch (error) { console.warn('[platform] 按群覆盖编辑器渲染失败：', error); }
  // 两个请求各拉各的：一个失败不影响另一个
  if (slots.length) {
    api('/api/platform/gates').then((data) => {
      const byKey = new Map((data?.gates || []).map((g) => [g.key, g]));
      for (const el of slots) {
        const info = byKey.get(el.dataset.gateTools);
        if (!info) { el.textContent = ''; continue; }
        const tools = (info.tools || []).join('、');
        el.textContent = tools ? `（工具：${tools}${info.defaultOn ? '' : '；默认关'}）` : '';
      }
    }).catch(() => {
      for (const el of slots) el.textContent = '（工具清单没拉到，刷新重试）';
    });
  }
  if (quotaSlots.length) {
    api('/api/platform/quota-usage').then((data) => {
      // 接口分组用的是简称（reactions/profile/...），每一项里带规范 key（reactionsPerHour/…）；
      // 按 item.key 建索引 —— 直接用对象键会一个都对不上（真机 2026-10-07 验证时踩到）。
      const byKey = new Map(Object.values(data?.quotas || {}).map((info) => [info?.key, info]));
      for (const el of quotaSlots) {
        const info = byKey.get(el.dataset.quotaUsed);
        if (!info) { el.textContent = ''; continue; }
        const per = info.windowMs <= 3600_000 ? '本小时' : '今日';
        const detail = (info.chats || []).slice(0, 2)
          .map((c) => `${String(c.chatKey).replace(/^group:/, '群')}×${c.count}`).join(' ');
        el.textContent = `${per}已用 ${info.used} / 上限 ${info.limit}${detail ? `（${detail}）` : ''}`;
      }
    }).catch(() => {
      for (const el of quotaSlots) el.textContent = '（用量没读到）';
    });
  }
}

export {
  ALL_GATE_KEYS, QUOTA_ROWS, gateCheckboxId, gateDefaultOn, hydratePlatformGates,
  hydratePlatformVoiceSelect, renderPlatformSection
};
