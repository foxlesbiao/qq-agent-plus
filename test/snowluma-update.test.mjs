// 协议端（SnowLuma）版本识别与"控制台一键更新"的回归用例。
//
// 这一层的价值全在**边界与失败路径**上：镜像串解析（带国内镜像站前缀）、版本比较、
// 目标镜像的前缀继承、以及更新失败时的"只还原 .env / 自动回滚"——真机上跑一次升级代价太大
// （协议端会重启），所以用注入的 exec/probe 替身把这些路径逐条钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const {
  SNOWLUMA_BASELINE_IMAGE, SNOWLUMA_MIN_RECOMMENDED,
  parseImage, compareVersions, targetImageFor, readComposeEnv, renderEnvWithImage,
  backupComposeFiles, createSnowlumaUpdater
} = await import('../src/core/snowluma-update.js');

const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无视 */ } }
});

/** 造一个假的 compose 项目目录（.env + docker-compose.yml）。 */
function makeProject({ image = 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', container = 'qq-agent-snowluma' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-'));
  tempDirs.add(dir);
  fs.writeFileSync(path.join(dir, '.env'), [
    `SNOWLUMA_IMAGE=${image}`,
    `SNOWLUMA_CONTAINER=${container}`,
    'ONEBOT_HTTP_PORT=3390',
    'ONEBOT_TOKEN=secret-token',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  snowluma:\n    image: "${SNOWLUMA_IMAGE}"\n');
  return dir;
}

/**
 * 假 docker：只实现我们用到的四个形态。up -d 之后"运行中的镜像"就跟着 .env 变
 * （模拟容器真的重建了）；pull 可以通过 failingPull 控制失败。
 */
function fakeDocker({ dir, state = {} } = {}) {
  const calls = [];
  const api = {
    calls,
    state: { running: state.running === true, image: state.image || '', failingPull: false, failingUp: false },
    exec(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      if (cmd !== 'docker') return { ok: false, code: -1, stdout: '', stderr: `unexpected cmd ${cmd}` };
      const joined = args.join(' ');
      if (args[0] === 'inspect') {
        if (joined.includes('.Config.Image')) return { ok: true, code: 0, stdout: `${api.state.image}\n`, stderr: '' };
        if (joined.includes('.State.Status')) return { ok: true, code: 0, stdout: `${api.state.running ? 'running' : 'exited'}\n`, stderr: '' };
        return { ok: false, code: 1, stdout: '', stderr: 'no such field' };
      }
      if (args[0] === 'compose') {
        const action = args.filter((a) => !a.startsWith('-') && a !== 'compose' && a !== dir && !a.includes('.env') && !a.includes('docker-compose'))[0];
        if (action === 'pull') {
          if (api.state.failingPull) return { ok: false, code: 1, stdout: '', stderr: 'manifest unknown' };
          return { ok: true, code: 0, stdout: 'pulled', stderr: '' };
        }
        if (action === 'up') {
          if (api.state.failingUp) return { ok: false, code: 1, stdout: '', stderr: 'port is already allocated' };
          // 容器重建：把运行中的镜像切换成 .env 里现在写的那个
          api.state.image = readComposeEnv(dir).image;
          api.state.running = true;
          return { ok: true, code: 0, stdout: 'started', stderr: '' };
        }
      }
      return { ok: false, code: -1, stdout: '', stderr: `unhandled: ${joined}` };
    }
  };
  return api;
}

function makeUpdater(dir, docker, { probeOk = true, probeCalls = 0 } = {}) {
  let seen = 0;
  return createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    webuiPort: 5099,
    exec: docker.exec,
    probe: async () => { seen += 1; return { ok: seen > probeCalls && probeOk, status: probeOk ? 200 : 0 }; },
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 30
  });
}

// ── 镜像串与版本 ──

test('parseImage：带镜像站前缀 / 带端口 / 无 tag 都能拆对', () => {
  const a = parseImage('mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.22');
  assert.equal(a.registry, 'mirror.ccs.tencentyun.com/');
  assert.equal(a.repo, 'motricseven7/snowluma');
  assert.equal(a.tag, 'v1.14.22');
  assert.equal(a.version, '1.14.22');
  const b = parseImage('motricseven7/snowluma:v1.14.15');
  assert.equal(b.registry, '');
  assert.equal(b.repo, 'motricseven7/snowluma');
  assert.equal(b.version, '1.14.15');
  const c = parseImage('127.0.0.1:5000/snowluma');
  assert.equal(c.registry, '127.0.0.1:5000/');
  assert.equal(c.repo, 'snowluma');
  assert.equal(c.version, '');
  assert.equal(parseImage('').version, '');
});

test('compareVersions：数值比较（不是字符串比较）', () => {
  assert.equal(compareVersions('1.14.22', '1.14.22'), 0);
  assert.equal(compareVersions('1.14.9', '1.14.15'), -1, '9 < 15（字符串比较会判反）');
  assert.equal(compareVersions('1.15.0', '1.14.99'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('', '1.14.15'), -1, '认不出来的版本按 0 处理');
});

test('targetImageFor：沿用当前镜像的镜像站前缀，不把国内机器坑到 docker.io', () => {
  const mirrored = targetImageFor({ currentImage: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  assert.equal(mirrored, `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}`,
    '当前走镜像站 → 目标也用镜像站 + 基线版本');
  const plain = targetImageFor({ currentImage: 'motricseven7/snowluma:v1.14.15' });
  assert.equal(plain, SNOWLUMA_BASELINE_IMAGE, '本来就拉 docker.io 的 → 直接用基线');
  const override = targetImageFor({ currentImage: 'mirror.x/motricseven7/snowluma:v1.14.15', override: 'registry.local/snowluma:v9.9.9' });
  assert.equal(override, 'registry.local/snowluma:v9.9.9', '配置里手填的镜像优先');
});

test('renderEnvWithImage：只改 SNOWLUMA_IMAGE 那一行，其余行（含令牌）原样保留', () => {
  const raw = 'SNOWLUMA_IMAGE=old:v1\nONEBOT_TOKEN=secret-token\nSNOWLUMA_CONTAINER=qq-agent-snowluma\n';
  const next = renderEnvWithImage(raw, 'new:v2');
  assert.match(next, /^SNOWLUMA_IMAGE=new:v2$/m);
  assert.match(next, /ONEBOT_TOKEN=secret-token/, '其它键不许被动');
  assert.equal(next.split('\n').length, raw.split('\n').length, '行数不变（是替换不是追加）');
  const appended = renderEnvWithImage('ONEBOT_TOKEN=t\n', 'x:v1');
  assert.match(appended, /SNOWLUMA_IMAGE=x:v1/);
  const withBlank = renderEnvWithImage('A=1\n\n', 'x:v1');
  assert.ok(withBlank.startsWith('A=1'), '原有内容保持在前');
  assert.ok(withBlank.includes('SNOWLUMA_IMAGE=x:v1'), '新键要写进去');
  assert.ok(withBlank.endsWith('\n'), '结尾换行保持（别把文件写成一坨）');
});

test('backupComposeFiles：两份文件都进时间戳目录', () => {
  const dir = makeProject();
  const b = backupComposeFiles(dir, 1700000000000);
  assert.deepEqual(b.copied.sort(), ['.env', 'docker-compose.yml']);
  assert.ok(fs.existsSync(path.join(b.dir, '.env')));
  assert.ok(fs.existsSync(path.join(b.dir, 'docker-compose.yml')));
});

// ── 状态与更新 ──

test('status：跑着的镜像 / 目标镜像 / 是否落后（含"低于推荐版本"）', () => {
  const dir = makeProject({ image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' });
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const st = makeUpdater(dir, docker).status();
  assert.equal(st.currentVersion, '1.14.15');
  assert.equal(st.targetVersion, parseImage(SNOWLUMA_BASELINE_IMAGE).version);
  assert.equal(st.outdated, true, '1.14.15 落后于基线');
  assert.equal(st.belowRecommended, true, `低于推荐版本 ${SNOWLUMA_MIN_RECOMMENDED}`);
  assert.equal(st.running, true);

  // 已经是最新：不落后；推荐版本线也不再报警
  const docker2 = fakeDocker({ dir, state: { running: true, image: `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}` } });
  const st2 = makeUpdater(dir, docker2).status();
  assert.equal(st2.outdated, false);
  assert.equal(st2.belowRecommended, false);
});

test('status：没装协议端（没有 .env）时如实说"没找到"，不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-empty-'));
  tempDirs.add(dir);
  const docker = fakeDocker({ dir });
  const st = makeUpdater(dir, docker).status();
  assert.equal(st.installed, false);
  assert.equal(st.currentVersion, '');
});

test('update：把镜像写进 .env → pull → up -d → 等就绪，并留备份目录', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const res = await updater.update();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.from, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15');
  assert.equal(res.to, `mirror.ccs.tencentyun.com/motricseven7/snowluma:${parseImage(SNOWLUMA_BASELINE_IMAGE).tag}`,
    '镜像站前缀要跟着当前镜像走');
  // .env 真的改了，且别的键还在
  const env = readComposeEnv(dir);
  assert.equal(env.image, res.to);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /ONEBOT_TOKEN=secret-token/);
  // 备份目录里有更新前的 .env
  assert.ok(fs.existsSync(path.join(res.backupDir, '.env')), '更新前要留一份 .env 备份');
  assert.match(fs.readFileSync(path.join(res.backupDir, '.env'), 'utf8'), /v1\.14\.15/);
  // 命令序列：pull 在 up -d 之前
  const seq = docker.calls.join(' ;; ');
  assert.match(seq, /compose --project-directory .* pull/);
  assert.match(seq, /compose --project-directory .* up -d/);
  assert.ok(seq.indexOf(' pull') < seq.indexOf(' up -d'), '先 pull 再 up -d');
});

test('update dryRun：只算命令与 .env 变化，一个字节都不写', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const res = await makeUpdater(dir, docker).update({ dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.match(res.envChange, /^SNOWLUMA_IMAGE=mirror\.ccs\.tencentyun\.com\//);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before, 'dry-run 不许改 .env');
  assert.equal(docker.calls.some((c) => c.includes(' pull') || c.includes(' up')), false,
    'dry-run 不许动容器（只允许 inspect 这类只读查询）');
});

test('update：pull 失败 → 只还原 .env，容器一个都不动', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  docker.state.failingPull = true;
  const res = await makeUpdater(dir, docker).update();
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'pull');
  assert.equal(res.restored, true);
  assert.match(res.error, /manifest unknown/);
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '.env 必须还原');
  assert.equal(docker.calls.some((c) => c.includes('up -d')), false, 'pull 失败就不该动容器');
});

test('update：起来了但等不到就绪 → 自动回滚到旧镜像，并把两次结果都报出来', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  // 第一次 up 之后永远探不到就绪；回滚用的第二次 up 之后就绪
  let upCount = 0;
  const baseExec = docker.exec;
  docker.exec = (cmd, args, opts) => {
    if (cmd === 'docker' && args[0] === 'compose' && args.includes('up')) upCount += 1;
    return baseExec(cmd, args, opts);
  };
  const updater = createSnowlumaUpdater({
    composeDir: dir,
    container: 'qq-agent-snowluma',
    webuiPort: 5099,
    exec: docker.exec,
    probe: async () => ({ ok: upCount > 1, status: upCount > 1 ? 200 : 0 }),   // 只有回滚后才就绪
    log: () => {},
    readyPollMs: 1,
    readyTimeoutMs: 15
  });
  const res = await updater.update();
  assert.equal(res.ok, false, '超时就算失败');
  assert.equal(res.rolledBack, true, '必须自动回滚成功');
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '.env 回到旧镜像');
  assert.ok(res.log.join(' ').includes('回滚'), '日志里要看得到回滚');
});

test('update：同一时刻只允许一个（并发点击直接被拒）', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const first = updater.update();
  const second = await updater.update();
  assert.equal(second.ok, false);
  assert.match(second.error, /进行中/);
  assert.equal((await first).ok, true);
});

test('rollback：回滚到上一次更新前的镜像（没有记录时如实拒绝）', async () => {
  const dir = makeProject();
  const docker = fakeDocker({ dir, state: { running: true, image: 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15' } });
  const updater = makeUpdater(dir, docker);
  const none = await updater.rollback();
  assert.equal(none.ok, false);
  assert.match(none.error, /可回滚/);

  await updater.update();                     // 先升上去
  const up = readComposeEnv(dir).image;
  assert.match(up, /v1\.14\.22$/);
  const back = await updater.rollback();
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(readComposeEnv(dir).image, 'mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15', '回到更新前的镜像');
});
