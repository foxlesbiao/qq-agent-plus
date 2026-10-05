// 识图专用模型（visionModel）配置解析的最小自检：配了→出三元组；没配/缺 key→null。
import assert from 'node:assert/strict';
import { visionModelConfig } from '../src/tools/tools-core.js';

// 未配置 → null（走原行为）
assert.equal(visionModelConfig({ api: { baseUrl: 'https://x', apiKey: 'k' } }), null);
// 配了模型 → 三元组
const vis = visionModelConfig({ api: { baseUrl: 'https://x/', apiKey: 'k', visionModel: 'glm-5-3-flash' } });
assert.deepEqual(vis, { baseUrl: 'https://x/', apiKey: 'k', model: 'glm-5-3-flash' });
// 缺 baseUrl / 缺 key → null（调用方回退直塞图，不阻塞）
assert.equal(visionModelConfig({ api: { apiKey: 'k', visionModel: 'm' } }), null);
console.log('visionModelConfig self-check OK');
