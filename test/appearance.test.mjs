// 外观设置（预设 / 强调色 / 圆角 / 缩放 / 密度）：纯函数部分。
// 这些值直接写进 CSS 变量，坏一个字符就会把界面搞花，所以边界要钉死。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { PRESETS, DEFAULTS, resolveAppearance, appearanceVars, accentShades, hexToRgb } =
  await import('../ui/core/appearance.js');

test('hexToRgb：三位/六位/带不带 # 都认，垃圾值返回 null', () => {
  assert.deepEqual(hexToRgb('#4c8dff'), { r: 76, g: 141, b: 255 });
  assert.deepEqual(hexToRgb('4c8dff'), { r: 76, g: 141, b: 255 });
  assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204 });
  assert.equal(hexToRgb('rgb(1,2,3)'), null);
  assert.equal(hexToRgb('#12345'), null);
  assert.equal(hexToRgb(''), null);
});

test('accentShades：派生出"柔和底"与"描边"两个 rgba', () => {
  const s = accentShades('#4c8dff');
  assert.equal(s.accent, '#4c8dff');
  assert.equal(s.soft, 'rgba(76, 141, 255, 0.12)');
  assert.equal(s.border, 'rgba(76, 141, 255, 0.36)');
  assert.equal(accentShades('nope'), null);
});

test('resolveAppearance：预设生效、自定义色优先、坏值一律回默认并夹紧', () => {
  const def = resolveAppearance({});
  assert.equal(def.preset, DEFAULTS.preset);
  assert.equal(def.accent, PRESETS[0].accent);
  assert.equal(def.radius, 1);
  assert.equal(def.zoom, 1);
  assert.equal(def.density, 'cozy');

  const mint = resolveAppearance({ preset: 'mint' });
  assert.equal(mint.accent, '#2fd07a');

  const custom = resolveAppearance({ preset: 'mint', accent: '#ff8800' });
  assert.equal(custom.accent, '#ff8800', '自定义色压过预设');
  assert.equal(custom.customAccent, true);

  const bad = resolveAppearance({ preset: '不存在', accent: 'xxx', radius: 99, zoom: -3, density: 'huge' });
  assert.equal(bad.preset, DEFAULTS.preset);
  assert.equal(bad.accent, PRESETS[0].accent);
  assert.equal(bad.radius, 1.4, '越界要夹到上限');
  assert.equal(bad.zoom, 0.85, '越界要夹到下限');
  assert.equal(bad.density, 'cozy');

  assert.equal(resolveAppearance({ radius: 0.1 }).radius, 0.6, '低于下限夹住');
});

test('appearanceVars：产出 CSS 变量名与派生色，值都是字符串', () => {
  const vars = appearanceVars(resolveAppearance({ preset: 'rose', radius: 1.2, zoom: 1.1 }));
  assert.deepEqual(Object.keys(vars).sort(), ['--accent', '--accent-border', '--accent-soft', '--r-scale', '--zoom']);
  assert.equal(vars['--accent'], '#f472b6');
  assert.equal(vars['--r-scale'], '1.2');
  assert.equal(vars['--zoom'], '1.1');
  for (const v of Object.values(vars)) assert.equal(typeof v, 'string');
});
