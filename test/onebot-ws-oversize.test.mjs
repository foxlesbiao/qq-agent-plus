// Issue #21 根因修复的行为用例：SnowLuma 1.14.15 的 OneBot HTTP 端点对请求体有 ≈2MiB
// 上限（实测 2MB 过 / 2.5MB 被掐），生成贴纸是整张图 base64，正好压线 —— "时好时坏"。
// 修复：超过 HTTP_BODY_SAFE_MAX 的调用自动改走 WebSocket 通道（同版本实测 3MB 无恙）；
// 顺带：incident 落库补 cause 链（undici 外层恒为 "fetch failed"，真因在 cause 里）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ws-oversize-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ } });

const { OneBotClient } = await import('../src/onebot/onebot.js');
const { IncidentPilotManager } = await import('../src/pilots/incident-pilot.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 全量并行跑时机器很卡：心跳 ping 的 pong 一旦晚于 2 秒 kill 窗口，客户端就会掐连接
// （code=1006 → 重连风暴，用例全体超时）。心跳不是这些用例的被测对象，直接关掉。
async function waitConnected(client, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.connected) return true;
    await sleep(25);
  }
  return client.connected;
}

/** 一套假协议端：WS 服务端（echo 应答 + 可主动推事件/扣住不回）+ HTTP 计数服务端。 */
async function makeFakes(t, { wsReplyDelayMs = 0, wsStatus = 'ok', holdActions = [] } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const wsPort = wss.address().port;
  const wsReceived = [];
  const holdSet = new Set(holdActions);   // 这些 action 收到后故意不回（测超时/断线）
  let clientSocket = null;
  wss.on('connection', (socket) => {
    clientSocket = socket;
    socket.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      wsReceived.push(frame);
      if (holdSet.has(frame.action)) return;   // 扣住不回
      const reply = { status: wsStatus, retcode: wsStatus === 'ok' ? 0 : 1200, data: { message_id: 777, echoed: frame.echo }, echo: frame.echo };
      if (wsReplyDelayMs > 0) setTimeout(() => socket.send(JSON.stringify(reply)), wsReplyDelayMs);
      else socket.send(JSON.stringify(reply));
    });
  });

  const httpPaths = [];
  const httpServer = http.createServer((req, res) => {
    httpPaths.push(String(req.url || ''));
    // ⚠️ 必须消费请求体：没有 data/resume 时流处于 paused 态，'end' 永不触发，假服务端
    // 就永远不响应 —— 所有调用挂到各自的超时（lint 修 no-unused-vars 时踩过这个坑）。
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { via: 'http', path: req.url } }));
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;

  const events = [];
  const client = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    accessToken: 'test-token',
    onEvent: (e) => events.push(e),
    heartbeat: 'off'
  });
  t.after(async () => {
    client.close();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => httpServer.close(r));
  });
  await client.connect();
  assert.ok(await waitConnected(client), '前提：WS 建联（8 秒内）');
  return { client, wss, wsReceived, events, httpServer, get httpPaths() { return httpPaths; }, get socket() { return clientSocket; }, holdReplies: holdSet };
}

test('超过 HTTP 安全阈值的大请求自动改走 WS，HTTP 零请求', async (t) => {
  const f = await makeFakes(t);
  const big = { message_type: 'group', group_id: 1, big: 'A'.repeat(2 * 1024 * 1024) };
  const data = await f.client.call('send_group_msg', big, 5000);
  assert.equal(data.message_id, 777, 'WS 应答要被正确解析返回');
  assert.equal(f.httpPaths.filter((p) => p.includes('send_group_msg')).length, 0,
    `大请求不许走 HTTP（HTTP 收到的路径：${f.httpPaths.join(', ')}）`);
  assert.equal(f.wsReceived.length >= 1, true);
  assert.equal(f.wsReceived[0].action, 'send_group_msg');
  assert.ok(f.wsReceived[0].echo, 'WS 调用必须带 echo');
});

test('小请求仍走原 HTTP 路线（守卫不许变成一律走 WS）', async (t) => {
  const f = await makeFakes(t);
  const data = await f.client.call('get_version_info', {}, 5000);
  assert.equal(data.via, 'http');
  assert.equal(f.httpPaths.filter((p) => p.includes('get_version_info')).length, 1, '小请求应走 HTTP');
  assert.equal(f.wsReceived.filter((fr) => fr.action === 'get_version_info').length, 0, '小请求不该上 WS');
});

test('WS 响应 status=failed 按明确失败结清（口径与 HTTP 通道一致）', async (t) => {
  const f = await makeFakes(t, { wsStatus: 'failed' });
  await assert.rejects(
    () => f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 5000),
    (error) => error.name === 'OneBotActionError' && error.outcome === 'failed' && /retcode=1200/.test(error.message)
  );
});

test('WS 中途断线：在途调用立即按 unknown 结清，不挂到超时', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });   // 服务端收下但永不回
  const pendingCall = f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 30000);
  await sleep(100);   // 等它发出去
  for (const socket of f.wss.clients) socket.terminate();   // 服务端掐断
  await assert.rejects(() => pendingCall, (error) => {
    assert.match(error.message, /断开|投递状态未知/);
    assert.equal(error.outcome, 'unknown', '断线 = 不知道对方收没收到，必须 unknown');
    return true;
  });
});

test('WS 响应超时按 unknown 结清', async (t) => {
  const f = await makeFakes(t, { holdActions: ['send_group_msg'] });   // 服务端收下但永不回
  await assert.rejects(
    () => f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 400),
    (error) => error.name === 'OneBotActionError' && error.outcome === 'unknown' && /超时/.test(error.message)
  );
});

test('WS 调用期间事件帧照常分发（共用通道不许互吞）', async (t) => {
  const f = await makeFakes(t, { wsReplyDelayMs: 400 });
  const pendingCall = f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 8000);
  await sleep(120);   // 大消息已发出、应答还在路上
  for (const socket of f.wss.clients) {
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 9, raw_message: 'hello' }));
  }
  await pendingCall;
  const got = f.events.find((e) => e?.post_type === 'message');
  assert.ok(got, '事件帧必须照常进 onEvent（不许被 echo 应答逻辑吞掉）');
  assert.equal(got.group_id, 9);
});

test('WS send 回调报错（帧确定没写进 socket）按 failed 结清，可自动重试', async (t) => {
  const f = await makeFakes(t);
  // 伪造"连接标志还在、socket 已死"的窗口：send 回调立刻报错（readyState 非 OPEN 的真实形态）
  const deadSocket = { send: (payload, cb) => { cb(new Error('WebSocket is not open: readyState 2')); } };
  const realSocket = f.client.socket;
  f.client.socket = deadSocket;
  try {
    await assert.rejects(
      () => f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 5000),
      (error) => {
        assert.equal(error.outcome, 'failed', 'send 回调报错 = 确定未投递，必须 failed（unknown 会升级成 critical 人工核对）');
        assert.match(error.message, /WS 发送失败/);
        return true;
      }
    );
  } finally {
    f.client.socket = realSocket;
  }
});

test('WS 未连接时大请求回落 HTTP（保留原有网络行为 + 告警日志）', async (t) => {
  const f = await makeFakes(t);
  // 模拟 WS 掉了：connected=false、socket 为空 —— call 应照旧走 HTTP 而不是拒绝
  f.client.connected = false;
  const realSocket = f.client.socket;
  f.client.socket = null;
  try {
    const data = await f.client.call('send_group_msg', { big: 'A'.repeat(2 * 1024 * 1024) }, 5000);
    assert.equal(data.via, 'http', 'WS 未连接时大请求回落 HTTP');
    assert.equal(f.httpPaths.filter((p) => p.includes('send_group_msg')).length, 1);
  } finally {
    f.client.connected = true;
    f.client.socket = realSocket;
  }
});

// ── incident 落库补 cause 链 ──
test('incident：undici 外层 "fetch failed" 的真因（cause 链）要落进消息', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-cause-'));
  const cfg = {
    incidentPilot: {
      enabled: true, graduated: false, ownerUin: '10000003', notifyWarnings: true,
      duplicateWindowMinutes: 10, unknownWritesBlockChat: false, retentionDays: 90
    }
  };
  const manager = new IncidentPilotManager({
    dataDir,
    config: () => cfg,
    notifyAvailable: () => true,
    notify: async () => {},
    now: () => Date.now(),
    emit: () => {},
    log: () => {}
  });
  manager.start();   // active 的前提是 db 已建（capture 在未 start 时返回 null）
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const undiciStyle = new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
  });
  const incident = manager.capture(undiciStyle, { source: 'onebot', category: 'external_write' });
  assert.ok(incident, '前提：incident 已捕获');
  assert.match(incident.message, /fetch failed/);
  assert.match(incident.message, /ECONNRESET/, `真因 code 必须进消息（面板才有的看），实际：${incident.message}`);
  assert.match(incident.message, /other side closed/, '真因 message 也要进消息');

  const noCause = manager.capture(new Error('普通错误没有 cause'), { source: 'onebot', category: 'external_write', code: 'PLAIN_ERROR' });
  assert.ok(noCause);
  assert.doesNotMatch(noCause.message, /真因/, '没有 cause 的错误保持原样（不许拼出空真因）');
});
