// 协议端（SnowLuma）镜像版本与更新：**控制台一键升级**的实现，ops 命令与体检也共用这一份。
//
// 为什么需要它：项目把协议端镜像版本钉在 deploy-all.sh / ops deploy 里（基线），但升级协议端
// 一直是"运维 ssh 进去手动改 .env + docker compose up -d"——别人装完就停在旧版本，于是
// 「贴纸显示成图片」这类"能力有了但协议端太老"的问题，只有手动升级的人才能解决。
//
// 这里的做法只做一件事：**改 .env 里的 SNOWLUMA_IMAGE，然后 compose pull + up -d**——
// 与 deploy-all.sh 起它的方式完全一致（容器名/端口/数据卷都不动，所以 QQ 登录态保留）。
// 安全边界：
//   · 更新前把 .env / docker-compose.yml 备份到 <composeDir>/backups/<ts>/；
//   · pull 失败 → 只还原 .env，不动容器；
//   · 起不来或等不到就绪 → 自动回滚（还原 .env 再 up -d 回旧镜像），并把两次结果一起报出来；
//   · 只认 compose 项目里那份 .env 的 SNOWLUMA_IMAGE 键，其余行原样保留（不重写整份文件）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

/** 项目测过的协议端基线：ops deploy 与"建议版本"都用它（单一真源）。 */
export const SNOWLUMA_BASELINE_IMAGE = 'motricseven7/snowluma:v1.14.22';

/**
 * 低于这个版本，平台能力会**静默降级**：动画表情的"真表情"呈现要 ≥1.14.20
 * （1.14.17 上 sub_type 无效，SnowLuma issue #468）——贴纸仍会显示成图片。
 */
export const SNOWLUMA_MIN_RECOMMENDED = '1.14.20';

const IMAGE_KEY = 'SNOWLUMA_IMAGE';
const CONTAINER_KEY = 'SNOWLUMA_CONTAINER';

/** 从镜像串里取 tag / registry 前缀 / 仓库路径。`a/b/c:tag` → registry='a/b/'，repo='c'。 */
export function parseImage(image = '') {
  const raw = String(image || '').trim();
  if (!raw) return { raw: '', registry: '', repo: '', tag: '', version: '' };
  const at = raw.lastIndexOf('/');
  const colon = raw.lastIndexOf(':');
  const hasTag = colon > at;
  const tag = hasTag ? raw.slice(colon + 1) : '';
  const withoutTag = hasTag ? raw.slice(0, colon) : raw;
  // 第一段含 '.' 或 ':'（含端口）才当 registry（docker 的判定口径）
  const first = withoutTag.split('/')[0] || '';
  const hasRegistry = withoutTag.includes('/') && (first.includes('.') || first.includes(':'));
  const registry = hasRegistry ? `${first}/` : '';
  const repo = hasRegistry ? withoutTag.slice(first.length + 1) : withoutTag;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return { raw, registry, repo, tag, version: m ? `${m[1]}.${m[2]}.${m[3]}` : '' };
}

/** 版本号比较（只认 x.y.z；不认识的按 0 处理）。 */
export function compareVersions(a = '', b = '') {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * 目标镜像：显式 override（配置里手填）优先；否则用项目基线，但**沿用当前镜像的 registry 前缀**
 * ——国内机器上当前是 `mirror.ccs.tencentyun.com/motricseven7/snowluma:v1.14.15`，
 * 直接换成 docker.io 的基线会拉不动（deploy-all.sh 支持 `--image` 就是为了这件事）。
 */
export function targetImageFor({ currentImage = '', override = '', baseline = SNOWLUMA_BASELINE_IMAGE } = {}) {
  const explicit = String(override || '').trim();
  if (explicit) return explicit;
  const cur = parseImage(currentImage);
  const base = parseImage(baseline);
  if (cur.registry && base.registry !== cur.registry) {
    return `${cur.registry}${base.repo}:${base.tag}`;
  }
  return baseline;
}

/** 默认的命令执行器（与 ops.js 的 run() 同口径，可注入替身以便测试）。 */
export function defaultExec(cmd, args = [], { timeout = 180000, cwd } = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeout > 0 ? timeout : undefined,
    maxBuffer: 32 * 1024 * 1024,
    cwd,
    windowsHide: true
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    ok: !result.error && result.status === 0,
    code: result.status ?? -1,
    stdout,
    stderr,
    missing: Boolean(result.error && result.error.code === 'ENOENT'),
    error: result.error ? String(result.error.message || result.error) : ''
  };
}

/** 读 compose 项目的 .env（只取我们要用的几个键；文件不存在返回空）。 */
export function readComposeEnv(composeDir) {
  const envFile = path.join(composeDir, '.env');
  const out = { envFile, exists: false, image: '', container: '', raw: '' };
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    out.exists = true;
    out.raw = raw;
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === IMAGE_KEY) out.image = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === CONTAINER_KEY) out.container = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 没装协议端/没权限：交给调用方按"不存在"处理 */ }
  return out;
}

/** 把 .env 里的 SNOWLUMA_IMAGE 换成新值：**其余行原样保留**，没有该键就追加。 */
export function renderEnvWithImage(raw = '', image = '') {
  const lines = String(raw || '').split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\s*SNOWLUMA_IMAGE\s*=/.test(line)) { replaced = true; return `${IMAGE_KEY}=${image}`; }
    return line;
  });
  if (!replaced) {
    // 末尾空行就插在它前面，别留一堆空行
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, `${IMAGE_KEY}=${image}`);
    else next.push(`${IMAGE_KEY}=${image}`);
  }
  return next.join('\n');
}

/** 备份 .env 与 compose 文件到 <composeDir>/backups/<ts>/（更新前的保险）。 */
export function backupComposeFiles(composeDir, ts = Date.now()) {
  const dir = path.join(composeDir, 'backups', String(ts));
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const name of ['.env', 'docker-compose.yml']) {
    const from = path.join(composeDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, name));
    copied.push(name);
  }
  return { dir, copied };
}

/** 探测协议端是否已经起来：WebUI 的公开接口能返回 JSON 就算就绪（无需鉴权）。 */
function probeWebui(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ui/public', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200 && body.trim().startsWith('{'), status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('probe timeout')); resolve({ ok: false, status: 0 }); });
    req.on('error', (error) => resolve({ ok: false, status: 0, error: String(error?.message || error) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 协议端更新器。exec 可注入（测试用替身）；probe 同理。
 * 只做"改 .env + compose pull/up + 等就绪 + 失败自动回滚"，不碰容器名/端口/数据卷。
 */
export function createSnowlumaUpdater({
  composeDir,
  container = 'qq-agent-snowluma',
  webuiPort = 5099,
  baseline = SNOWLUMA_BASELINE_IMAGE,
  exec = defaultExec,
  probe = probeWebui,
  log = () => {},
  readyTimeoutMs = 120000,
  readyPollMs = 2000
} = {}) {
  const dir = String(composeDir || '');
  let busy = null;                  // 同一时刻只允许一个更新在跑
  let lastResult = null;            // 最近一次更新结果（供"回滚到上一版"用）

  function compose(...args) {
    return exec('docker', ['compose', '--project-directory', dir, '--env-file', path.join(dir, '.env'),
      '-f', path.join(dir, 'docker-compose.yml'), ...args], { cwd: dir, timeout: 300000 });
  }

  function inspect(field) {
    const res = exec('docker', ['inspect', '-f', `{{${field}}}`, container], { timeout: 15000 });
    return res.ok ? res.stdout.trim() : '';
  }

  /** 当前状态：跑着的镜像 tag、容器状态、目标镜像、是否落后。 */
  function status() {
    const env = readComposeEnv(dir);
    const runningImage = inspect('.Config.Image');
    const state = inspect('.State.Status');
    const currentImage = runningImage || env.image;
    const cur = parseImage(currentImage);
    const target = targetImageFor({ currentImage, override: '', baseline });
    const tgt = parseImage(target);
    return {
      composeDir: dir,
      installed: env.exists,
      envImage: env.image,
      container: env.container || container,
      runningImage,
      runningState: state,
      running: state === 'running',
      currentImage,
      currentVersion: cur.version,
      targetImage: target,
      targetVersion: tgt.version,
      outdated: Boolean(cur.version && tgt.version) && compareVersions(cur.version, tgt.version) < 0,
      belowRecommended: Boolean(cur.version) && compareVersions(cur.version, SNOWLUMA_MIN_RECOMMENDED) < 0,
      minRecommended: SNOWLUMA_MIN_RECOMMENDED,
      baseline,
      busy: Boolean(busy),
      lastResult
    };
  }

  /** 等容器起来 + WebUI 就绪。 */
  async function waitReady() {
    const startedAt = Date.now();
    for (;;) {
      const state = inspect('.State.Status');
      if (state === 'running') {
        const p = await probe(webuiPort);
        if (p.ok) return { ok: true, waitedMs: Date.now() - startedAt };
      }
      if (Date.now() - startedAt > readyTimeoutMs) {
        return { ok: false, waitedMs: Date.now() - startedAt, state };
      }
      await sleep(readyPollMs);
    }
  }

  async function runUpdate({ to = '', dryRun = false } = {}) {
    const st = status();
    if (!st.installed) return { ok: false, error: `没找到协议端的 compose 项目（${dir}/.env 不存在）` };
    const from = st.currentImage;
    const target = String(to || '').trim() || st.targetImage;
    if (!target) return { ok: false, error: '算不出目标镜像' };
    const steps = [
      { cmd: 'docker', args: ['compose', 'pull'] },
      { cmd: 'docker', args: ['compose', 'up', '-d'] }
    ];
    if (dryRun) {
      return { ok: true, dryRun: true, from, to: target, envChange: `${IMAGE_KEY}=${target}`, steps };
    }
    if (target === from) {
      // 真机验证过的行为：镜像 tag 没变时 `compose up -d` 发现配置无变化，**不会**重启容器
      // （这是好事：没必要为了"更新"平白断一次连接）。要强制重建得手动 --force-recreate。
      log(`[snowluma] 已经是目标镜像 ${target}：只拉取/校验，compose 不会白重启容器`);
    }
    const backup = backupComposeFiles(dir);
    const envFile = path.join(dir, '.env');
    const originalEnv = fs.readFileSync(envFile, 'utf8');
    const lines = [];
    const push = (s) => { const line = String(s).trim(); if (line) { lines.push(line); log(`[snowluma] ${line}`); } };

    try {
      fs.writeFileSync(envFile, renderEnvWithImage(originalEnv, target), 'utf8');
      push(`镜像写入 ${IMAGE_KEY}=${target}（备份在 ${backup.dir}）`);

      const pull = compose('pull');
      push(`pull ${pull.ok ? 'ok' : `失败(code=${pull.code})`}`);
      if (!pull.ok) {
        fs.writeFileSync(envFile, originalEnv, 'utf8');
        const result = { ok: false, stage: 'pull', error: (pull.stderr || pull.stdout || '拉取镜像失败').trim().slice(0, 500), from, to: target, restored: true, backupDir: backup.dir, log: lines };
        lastResult = result;
        return result;
      }

      const up = compose('up', '-d');
      push(`up -d ${up.ok ? 'ok' : `失败(code=${up.code})`}`);
      if (!up.ok) throw new Error((up.stderr || up.stdout || 'compose up 失败').trim().slice(0, 500));

      const ready = await waitReady();
      push(`就绪等待 ${ready.waitedMs}ms → ${ready.ok ? '已就绪' : '超时'}`);
      if (!ready.ok) throw new Error(`容器没有在 ${readyTimeoutMs}ms 内就绪（状态 ${ready.state || 'unknown'}）`);

      const result = { ok: true, from, to: target, waitedMs: ready.waitedMs, backupDir: backup.dir, log: lines };
      lastResult = result;
      return result;
    } catch (error) {
      // 失败即回滚：把 .env 还原再 up -d 回旧镜像（数据卷没动过，登录态不受影响）
      push(`失败：${error?.message ?? error} —— 开始回滚到 ${from}`);
      let rolledBack = false;
      try {
        fs.writeFileSync(envFile, originalEnv, 'utf8');
        const back = compose('up', '-d');
        const ready = await waitReady();
        rolledBack = back.ok && ready.ok;
        push(`回滚 ${rolledBack ? '成功' : '未确认（需要人工看一眼）'}`);
      } catch (rollbackError) {
        push(`回滚也失败了：${rollbackError?.message ?? rollbackError}`);
      }
      const result = { ok: false, stage: 'up', error: String(error?.message ?? error), from, to: target, rolledBack, backupDir: backup.dir, log: lines };
      lastResult = result;
      return result;
    }
  }

  /** 串行化：同一时刻只跑一个更新（并发点击/自动+手动撞车时直接拒绝）。 */
  function update(options = {}) {
    if (busy) return Promise.resolve({ ok: false, error: '已经有一个协议端更新在进行中', busy: true });
    busy = Promise.resolve()
      .then(() => runUpdate(options))
      .finally(() => { busy = null; });
    return busy;
  }

  /** 回滚到"上一次更新前的镜像"（只有在有过一次成功/失败的更新后可用）。 */
  function rollback() {
    const from = lastResult?.from || '';
    if (!from) return Promise.resolve({ ok: false, error: '还没有可回滚的记录（本次进程内没执行过更新）' });
    return update({ to: from });
  }

  return { status, update, rollback, composeDir: dir, webuiPort, container };
}
