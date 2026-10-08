// 控制台动效系统的源码锚点（2026-10-08）。
//
// 为什么用"读源码"而不是 DOM 断言：动效是靠 CSS 规则生效的，而 happy-dom 不跑真实
// 过渡；真正会出的事故是"这段 CSS 被删了/被后面的规则架空了"—— 那正好是文本层面能钉住的。
// 实测教训：一条兜底 `transition: ... .2s ease` 把整套动效 token 架空，所有控件的计算值
// 都变成浏览器默认的 ease，看起来就是"没有设计过的过渡"。这条用例专门守它别再回来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const UI = path.resolve('ui');
const css = fs.readFileSync(path.join(UI, 'style.css'), 'utf8');

test('交互过渡走 token（不许再出现写死的 .2s ease 兜底）', () => {
  assert.ok(css.includes('--dur-interaction: 150ms'), '要有交互过渡时长 token');
  assert.ok(css.includes('--dur-interaction) var(--ease-in-out)'), '兜底过渡要用 token');
  const blanket = /\.btn, \.icon-btn, input, select, textarea[\s\S]{0,400}?transition:\s*background-color \.2s ease/;
  assert.equal(blanket.test(css), false, '那条写死 .2s ease 的兜底过渡不许回来（它会架空 token）');
});

test('可交互元素都有过渡（chip / 菜单项 / 数据行 / 面板行）', () => {
  for (const sel of ['.tab', '.settings-menu-item', '.chip', '.preset', '.theme-option', '.feed li', '.plat-row']) {
    assert.ok(css.includes(sel), `动效覆盖清单里缺少 ${sel}`);
  }
  // 状态点会呼吸（参照实现是 animate-pulse）；减少动效偏好下必须关掉
  assert.ok(/\.dot\.dot-on \{ animation: breathe/.test(css), '已连接的状态点要有呼吸动画');
  assert.ok(/prefers-reduced-motion[\s\S]{0,200}\.dot\.dot-on \{ animation: none/.test(css),
    '减少动效偏好下呼吸动画要停');
});

test('键盘焦点可见：非按钮的可聚焦控件也有 focus-visible 环', () => {
  assert.ok(/a:focus-visible, \[tabindex\]:focus-visible/.test(css), '链接/自定义控件要有焦点环');
  assert.ok(/input:focus-visible, select:focus-visible, textarea:focus-visible/.test(css), '输入控件要有焦点环');
});

test('设计标度：间距/字号/圆角档位与卡片阴影都在，且圆角按角色分档', () => {
  for (const token of ['--sp-1: 4px', '--sp-4: 16px', '--fs-md:', '--fs-lg:', '--r-card:', '--r-input:', '--shadow-card:']) {
    assert.ok(css.includes(token), `标度 token 缺失：${token}`);
  }
  assert.ok(/\.kpi, \.panel, \.usage-card[\s\S]{0,200}?box-shadow: var\(--shadow-card\)/.test(css),
    '卡片要带上极轻阴影（没有它卡片是"平"的）');
});
