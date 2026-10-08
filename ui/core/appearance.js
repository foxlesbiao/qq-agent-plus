// 外观设置（2026-10-08）：主题预设 / 强调色 / 圆角 / 界面缩放 / 密度。
//
// 为什么单独成模块：这些值要在三处用同一份 —— 启动时套到 <html> 上、设置页渲染当前值、
// 保存时算 patch。「参照控制台」的外观页能配十来项（预设、强调色、深浅、圆角、缩放、密度、
// 壁纸、逐变量微调…），我们按同样的思路做了**能一眼看出差别**的五项，其余先不做。
//
// 纯函数、零依赖：方便单测（hex → rgba 的换算最容易写错）。
'use strict';

/** 预设：只换强调色（含由它派生出的柔和底与描边），不动背景与文字色。 */
const PRESETS = [
  { id: 'snow', label: '雪原', accent: '#4c8dff' },
  { id: 'mint', label: '薄荷', accent: '#2fd07a' },
  { id: 'amber', label: '琥珀', accent: '#f7b955' },
  { id: 'violet', label: '紫罗兰', accent: '#a78bfa' },
  { id: 'rose', label: '玫瑰', accent: '#f472b6' }
];

const DEFAULTS = { preset: 'snow', accent: '', radius: 1, zoom: 1, density: 'cozy' };
const DENSITIES = ['compact', 'cozy', 'roomy'];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** `#rrggbb` / `#rgb` → {r,g,b}；认不出返回 null。 */
function hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

/** 强调色的派生色：柔和底（卡片/hover）与描边（选中态边界）。 */
function accentShades(hex, alphaSoft = 0.12, alphaBorder = 0.36) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return {
    accent: hex,
    soft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaSoft})`,
    border: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaBorder})`
  };
}

/** 保存值 → 生效值（坏值一律回默认，绝不让一个手改坏的数字把界面搞花）。 */
function resolveAppearance(ui = {}) {
  const presetId = PRESETS.some((p) => p.id === ui.preset) ? ui.preset : DEFAULTS.preset;
  const preset = PRESETS.find((p) => p.id === presetId);
  const custom = String(ui.accent || '').trim();
  // 自定义色优先于预设；两样都不合法就回预设
  const accent = hexToRgb(custom) ? (custom.startsWith('#') ? custom : `#${custom}`) : preset.accent;
  const radius = clamp(Number(ui.radius) || DEFAULTS.radius, 0.6, 1.4);
  const zoom = clamp(Number(ui.zoom) || DEFAULTS.zoom, 0.85, 1.2);
  const density = DENSITIES.includes(ui.density) ? ui.density : DEFAULTS.density;
  return { preset: presetId, accent, radius, zoom, density, customAccent: Boolean(hexToRgb(custom)) };
}

/** 生效值 → CSS 变量（套在 documentElement 的 inline style 上）。 */
function appearanceVars(app) {
  const shades = accentShades(app.accent) || accentShades('#4c8dff');
  return {
    '--accent': shades.accent,
    '--accent-soft': shades.soft,
    '--accent-border': shades.border,
    '--r-scale': String(app.radius),
    '--zoom': String(app.zoom)
  };
}

export { PRESETS, DEFAULTS, DENSITIES, accentShades, appearanceVars, hexToRgb, resolveAppearance };
