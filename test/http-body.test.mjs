// 有界读响应体（src/core/http-body.js）的回归用例。
//
// 这个模块存在的理由：上游返回超大或畸形响应时，常驻进程会被单次调用打爆。
// 所以这里钉的重点是"超限时真的停住"与"各种残缺/异常的 Response 都不能把裸异常放出去"。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { readTextBounded, readJsonBounded } = await import('../src/core/http-body.js');

/** 造一个"每块 chunkBytes 字节、最多 maxChunks 块"的假流。 */
function streamRes({ chunkBytes = 100, maxChunks = 10, contentType = 'text/plain' } = {}) {
  let sent = 0;
  let cancelled = false;
  const body = {
    getReader() {
      return {
        async read() {
          if (cancelled || sent >= maxChunks) return { done: true, value: undefined };
          sent += 1;
          return { done: false, value: new Uint8Array(chunkBytes).fill(65) };
        },
        async cancel() { cancelled = true; },
        releaseLock() {},
      };
    },
  };
  return { res: { body, headers: { get: () => contentType } }, stats: () => ({ sent, cancelled }) };
}

test('超限时立刻停止并抛 BODY_TOO_LARGE：不截断、不再多读', async () => {
  const { res, stats } = streamRes({ chunkBytes: 100, maxChunks: 1000 });
  await assert.rejects(() => readTextBounded(res, 250), (err) => {
    assert.equal(err.code, 'BODY_TOO_LARGE');
    assert.match(err.message, /250/, '错误信息要带上限');
    return true;
  });
  const { sent, cancelled } = stats();
  assert.ok(sent <= 4, `超限后不该继续读（实际读了 ${sent} 块）`);
  assert.equal(cancelled, true, '超限必须取消底层流，否则上游继续吐数据占住连接与内存');
});

test('正好等于上限要放行（边界不能差一个字节）', async () => {
  const { res } = streamRes({ chunkBytes: 100, maxChunks: 5 });
  const text = await readTextBounded(res, 500);
  assert.equal(text.length, 500);
});

test('body 为空 / 没有流时退回 text()、json()，并照样按字节数校验', async () => {
  assert.equal(await readTextBounded({ text: async () => 'hello' }, 100), 'hello');
  assert.deepEqual(await readJsonBounded({ json: async () => ({ a: 1 }) }, 100), { a: 1 });
  await assert.rejects(() => readTextBounded({ text: async () => 'x'.repeat(50) }, 10),
    (err) => err.code === 'BODY_TOO_LARGE');
});

test('body 已被锁住 / 已被消费时，退回 text() 而不是抛裸 TypeError', async () => {
  // 审查指出的潜伏缺陷：getReader() 在流被锁住时抛 TypeError，而它原本在 try 之外，
  // 逃出去的就不是本模块承诺的错误形态了。真实调用点目前都不会先消费 body，
  // 但这是"下一个改动就可能踩到"的那类坑，钉住它。
  const res = {
    body: { getReader() { throw new TypeError('ReadableStream is locked'); } },
    text: async () => 'ok-from-text',
  };
  assert.equal(await readTextBounded(res, 1024), 'ok-from-text');
});

test('body 被锁住且连 text() 都没有时，抛的不能是裸 TypeError', async () => {
  const res = { body: { getReader() { throw new TypeError('locked'); } } };
  await assert.rejects(() => readTextBounded(res, 1024), (err) => {
    assert.notEqual(err.constructor.name, 'TypeError',
      `应当是可识别的错误，实际 ${err.constructor.name}: ${err.message}`);
    return true;
  });
});
