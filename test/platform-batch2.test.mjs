// 协议端能力第二批（2026-10-07，SnowLuma 1.14.22）的回归用例：
// 合并转发卡片 / 群文件 / 群相册 / 陌生人信息 / 英译中，以及平台能力开关的工具门控。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-batch2-'));
process.env.QQ_AGENT_DATA_DIR = dir;
// Windows 上退出时句柄可能还没释放（rm 会 EPERM）——清理失败不该让整个文件判失败。
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着也无害 */ } });
fs.writeFileSync(path.join(dir, 'face-names.json'), JSON.stringify({ bySid: { 14: '微笑' } }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { buildToolDefs, platformToolAllowed } = await import('../src/tools/tools-core.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active';
cfg.allow.groups = ['1'];
cfg.allow.private = ['2'];
setRuntimeConfig(cfg);

const tool = (name) => {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `工具 ${name} 应存在`);
  return def;
};
const parse = (r) => JSON.parse(r.content);

const groupCtx = (call) => ({
  kind: 'group', chatId: '433', chatKey: 'group:433',
  store: { findByMid: () => null, recent: () => [] },
  onebot: { call },
  session: { id: 's', sent: [] },
  emit: () => {}
});

it('工具表：第二批工具都在；平台开关默认值正确', () => {
  const names = new Set(buildToolDefs().map((d) => d.name));
  for (const expected of ['list_group_files', 'group_file_url', 'send_group_file',
    'list_group_album', 'like_album_photo', 'comment_album_photo', 'upload_to_group_album',
    'get_user_info', 'translate_text']) {
    assert.ok(names.has(expected), `缺工具 ${expected}`);
  }
  assert.equal(DEFAULT_CONFIG.platform.albumUpload, false, '相册上传默认关');
  assert.equal(DEFAULT_CONFIG.platform.readReceipts, false, '已读标记默认关');
  assert.equal(DEFAULT_CONFIG.platform.forwardCards, true, '日报卡片默认开');
  assert.equal(DEFAULT_CONFIG.send.typingIndicator, true, '正在输入默认开');
});

it('platformToolAllowed：默认全开（相册上传除外），显式关生效', () => {
  assert.equal(platformToolAllowed('react_to_message', {}), true);
  assert.equal(platformToolAllowed('send_qq_voice', {}), true);
  assert.equal(platformToolAllowed('upload_to_group_album', {}), false, '默认关：未显式开就不放行');
  assert.equal(platformToolAllowed('upload_to_group_album', { albumUpload: true }), true);
  assert.equal(platformToolAllowed('react_to_message', { reactions: false }), false);
  assert.equal(platformToolAllowed('send_group_file', { groupFiles: false }), false);
  assert.equal(platformToolAllowed('list_group_album', { albumRead: false }), false);
  assert.equal(platformToolAllowed('read_image_text', { ocr: false }), false);
  assert.equal(platformToolAllowed('send_message', { reactions: false }), true, '无关工具不受平台开关影响');
});

it('list_group_files：映射文件与文件夹；私聊拒绝', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    return {
      files: [{ file_name: '名单.txt', file_size: 2048, file_id: 'f1', uploader_name: '群主' }],
      folders: [{ folder_name: '照片' }]
    };
  });
  const res = parse(await tool('list_group_files').execute(ctx, {}));
  assert.deepEqual(calls[0], ['get_group_root_files', { group_id: 433 }]);
  assert.deepEqual(res.files[0], { name: '名单.txt', sizeKB: 2, fileId: 'f1', uploader: '群主' });
  assert.deepEqual(res.folders, ['照片']);
  const priv = await tool('list_group_files').execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, {});
  assert.equal(priv.isError, true);
});

it('group_file_url：取下载直链；空 id 拒绝', async () => {
  const ctx = groupCtx(async () => ({ url: 'https://example.com/f1' }));
  const res = parse(await tool('group_file_url').execute(ctx, { fileId: 'f1' }));
  assert.equal(res.url, 'https://example.com/f1');
  const bad = await tool('group_file_url').execute(ctx, { fileId: '' });
  assert.equal(bad.isError, true);
});

it('send_group_file：text 变 base64 文件、url 原样转发、二选一校验', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => { calls.push([action, params]); return { file_id: 'up1' }; });
  const byText = parse(await tool('send_group_file').execute(ctx, { text: '第一行', name: '名单.txt' }));
  assert.equal(byText.sent, true);
  const [, textParams] = calls.at(-1);
  assert.equal(textParams.name, '名单.txt');
  assert.ok(textParams.file.startsWith('base64://'), '文本要以 base64 文件发出去');
  assert.equal(Buffer.from(textParams.file.slice('base64://'.length), 'base64').toString('utf8'), '第一行');

  await tool('send_group_file').execute(ctx, { url: 'https://example.com/a.pdf', name: 'a.pdf' });
  assert.equal(calls.at(-1)[1].file, 'https://example.com/a.pdf');

  assert.equal((await tool('send_group_file').execute(ctx, {})).isError, true);
  assert.equal((await tool('send_group_file').execute(ctx, { text: 'x', url: 'https://e/x' })).isError, true);
});

it('list_group_album：列相册 / 列照片；点赞与评论参数形状', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_group_album_list') return [{ id: 'alb1', name: '日常', picNum: 12, createTime: 1700000000 }];
    if (action === 'get_group_album_media_list') {
      return { media_list: [{ lloc: 'lo1', batch_id: 'b1', uploader_name: '甲', upload_time: 1700000001, desc: '合影' }] };
    }
    return {};
  });
  const albums = parse(await tool('list_group_album').execute(ctx, {}));
  assert.deepEqual(albums.albums[0], { id: 'alb1', name: '日常', pics: 12, createTime: 1700000000 });

  const photos = parse(await tool('list_group_album').execute(ctx, { albumId: 'alb1' }));
  assert.equal(photos.photos[0].lloc, 'lo1');
  assert.equal(photos.photos[0].batchId, 'b1');

  await tool('like_album_photo').execute(ctx, { albumId: 'alb1', batchId: 'b1' });
  assert.deepEqual(calls.at(-1), ['set_group_album_media_like', { group_id: 433, album_id: 'alb1', batch_id: 'b1' }]);
  await tool('comment_album_photo').execute(ctx, { albumId: 'alb1', lloc: 'lo1', content: '哈哈' });
  assert.deepEqual(calls.at(-1), ['do_group_album_comment', { group_id: 433, album_id: 'alb1', lloc: 'lo1', content: '哈哈' }]);
});

it('upload_to_group_album：用消息里的图 + 第一个相册；没有图时报错', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_group_album_list') return [{ id: 'alb1', name: '日常' }];
    return {};
  });
  ctx.store.findByMid = () => ({ mid: '9', media: [{ kind: 'image', url: 'https://example.com/pic.png', file: 'pic.png' }] });
  const res = parse(await tool('upload_to_group_album').execute(ctx, { messageId: '9' }));
  assert.equal(res.uploaded, true);
  assert.deepEqual(calls.at(-1), ['upload_image_to_qun_album',
    { group_id: 433, album_id: 'alb1', album_name: '日常', file: 'https://example.com/pic.png' }]);

  ctx.store.findByMid = () => ({ mid: '10', media: [] });
  const noPic = await tool('upload_to_group_album').execute(ctx, { messageId: '10' });
  assert.ok(!noPic.isError, '没有图时给提示而不是报错');
  assert.match(noPic.content, /没有可上传的图片/);
});

it('get_user_info / translate_text：形状正确', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_stranger_info') return { nickname: '甲', sex: 'male', age: 20 };
    if (action === 'translate_en2zh') return { words: ['你好'] };
    return {};
  });
  const info = parse(await tool('get_user_info').execute(ctx, { userId: '2002' }));
  assert.equal(info.nickname, '甲');
  assert.deepEqual(calls.at(-1), ['get_stranger_info', { user_id: 2002 }]);
  const tr = parse(await tool('translate_text').execute(ctx, { text: 'hello' }));
  assert.equal(tr.translation, '你好');
  assert.equal((await tool('get_user_info').execute(ctx, { userId: '不是数字' })).isError, true);
});

it('合并转发：sendForwardMsg 参数形状 + sender.sendForwardCard 走链并留档', async () => {
  const bot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' });
  const calls = [];
  bot.call = async (action, params) => { calls.push([action, params]); return { message_id: 7 }; };
  const nodes = [{ type: 'node', data: { nickname: '群日报', content: [{ type: 'text', data: { text: '昨天聊了…' } }] } }];
  await bot.sendForwardMsg('group', 433, nodes);
  assert.deepEqual(calls.at(-1), ['send_forward_msg', { message_type: 'group', group_id: 433, messages: nodes }]);
  await bot.sendForwardMsg('private', 2, nodes);
  assert.deepEqual(calls.at(-1), ['send_forward_msg', { message_type: 'private', user_id: 2, messages: nodes }]);

  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { call: async () => ({ message_id: 7 }), sendForwardMsg: async () => ({ message_id: 7 }) } });
  const sent = await sender.sendForwardCard('group:1', nodes, {});
  assert.equal(sent.message_id, 7);
  const self = store.recent('group:1', { limit: 5 }).find((m) => m.self);
  assert.ok(self && self.text.includes('聊天记录卡片'), '卡片要进自己的存档（下次运行能看到）');
  store.close();   // 句柄不关，Windows 上退出清理会 EPERM（整个文件被判失败）
});
