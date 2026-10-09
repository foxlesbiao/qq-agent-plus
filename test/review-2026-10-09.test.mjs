// 2026-10-09 全面审查里修掉的缺陷的**跨文件守卫用例**（行为用例在各自文件里，
// 这里只放源码锚点/不变量 —— 与 review-2026-10-08-round3 同一分工）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

test('租约回收的竞态守门：两处调用点都带 liveLeases，且 store 真的按 live 跳过', () => {
  // 2026-10-09 审查：recoverExpired 的 `live` 过滤是"在跑执行不再被回收"的唯一守门，
  // 而此前全仓没有任何用例引用过它（测试里 grep 不到 liveLeases）—— 删掉守卫测试照样全绿。
  const orch = read('src/core/orchestrator.js');
  const calls = orch.match(/recoverExpired\([^\n]*live: this\.liveLeases[^\n]*\)/g) || [];
  assert.ok(calls.length >= 2, `两处 recoverExpired 调用都要带 { live: this.liveLeases }，实际 ${calls.length} 处`);
  const store = read('src/core/store.js');
  assert.ok(/if \(live && live\.has\(run\.id\)\) continue;/.test(store),
    'store.recoverExpired 里必须真的按 live 跳过 —— 否则调用点传了也白搭');
});

test('运行台账（runs）进了每日保留期清理，且启动路径与调度共用 store.pruneRuns 一个口径', () => {
  // 2026-10-09 审查：runs 原来只在 ChatStore 构造时清一次，连跑数月 = 永不清理。
  const app = read('src/console/app.js');
  assert.ok(/name: '运行台账', run: \(\) => store\.pruneRuns\(\)/.test(app),
    'retentionPruneTargets 必须包含运行台账');
  const store = read('src/core/store.js');
  assert.ok(/this\.pruneRuns\(\);/.test(store), '启动路径复用同一方法');
  assert.ok(/DELETE FROM runs WHERE state != 'leased' AND expires_at <= \?/.test(store),
    '只清终态且过期的行；leased 行归 recoverExpired 管');
});

test('NNP（NoNewPrivileges）三个口径修正都在：先判再试 / 巡检不假绿 / 文档不再承诺捷径', () => {
  // 2026-10-09 审查：标准 unit 默认带 NNP，sudo 回退必失败 —— "有免密 sudo 就能用"是错的。
  const updater = read('src/core/snowluma-update.js');
  assert.ok(/if \(hasNoNewPrivs\(\)\) \{/.test(updater),
    'runDocker 必须先判 NNP，再决定要不要试 sudo');
  assert.ok(/processHasNoNewPrivs/.test(updater));
  const health = read('src/core/health-check.js');
  assert.ok(/mainServiceHasNoNewPrivs/.test(health), '巡检要读主进程的 NNP 状态');
  assert.ok(/noNewPrivsStatus \?\? mainServiceHasNoNewPrivs\(service\)/.test(health),
    '加固时不许拿巡检进程自己的 sudo 结果当"能用"的证据');
  const linux = read('docs/LINUX.md');
  assert.equal(/不必先重启\s*user manager/.test(linux), false,
    '文档不许再承诺"有免密 sudo 就能用、不必重启 user manager"');
  assert.ok(/NoNewPrivileges/.test(linux), '文档要说明默认配置带加固');
});

test('deploy-all 轮换失败不再假回滚：保持三方凭据一致，trap 尊重旗标', () => {
  // 2026-10-09 审查：回拷 .env 会把"config.json/compose 是新凭据"搞成不一致，
  // 下次部署被自家预检拒、新控制台令牌只剩 config.json 一份。
  const sh = read('deploy-all.sh');
  assert.ok(/KEEP_ENV_ON_ROTATE_FAILURE=true/.test(sh), '轮换失败要立旗标');
  assert.ok(/\$\{KEEP_ENV_ON_ROTATE_FAILURE:-false\}" != true/.test(sh), '退出 trap 要尊重旗标、别再回拷 .env');
  assert.equal(/cp -p "\$ENV_FILE\.pre-deploy" "\$ENV_FILE"\n\s*die 'SnowLuma password rotation/.test(sh), false,
    '不许再"回拷 .env 后 die"');
});

test('test-suite 兜底清理不碰运行中服务的 tmp 目录前缀', () => {
  // 2026-10-09 审查：在部署机上跑 npm test 时，兜底清理会删掉服务正在用的 ffmpeg 工作目录。
  const suite = read('scripts/test-suite.mjs');
  assert.ok(/RUNTIME_TMP_PREFIXES/.test(suite));
  assert.ok(/'qq-ffmpeg-'/.test(suite) && /'qq-ffprobe-'/.test(suite));
  assert.ok(/RUNTIME_TMP_PREFIXES\.some\(\(p\) => entry\.name\.startsWith\(p\)\)\) continue;/.test(suite),
    '清理循环里要真的跳过这些前缀');
});

test('禁言文案的日期与时刻同口径（都走上海时区，TZ=UTC 部署不再差一天）', () => {
  // 2026-10-09 审查：muteError 用本地时区 getMonth()/getDate() 取日期，formatClockTime 却是
  // 上海时区 —— 部署在 TZ=UTC 的机器上，北京 0-8 点之间解禁日期会报错一天。
  const sender = read('src/onebot/sender.js');
  assert.ok(/const dayKey = todayKey\(untilTs\);/.test(sender), '日期要走 todayKey（上海口径）');
  assert.ok(/dayKey === todayKey\(\)/.test(sender), '"是否同一天"也要同口径');
  assert.equal(/until\.getMonth\(\)|until\.getDate\(\)/.test(sender), false,
    '不许再用本地时区的 getMonth()/getDate()');
});

test('readBounded 的 truncated 由读取路径给出（> 而非 >=，边界不误标）', () => {
  // 2026-10-09 审查：正好等于上限的完整响应被 >= 误标 truncated；截断后的英文页长度
  // 恰好也是上限，拿长度反推又会漏标 —— 标记必须来自"是否真的中断"。
  const sf = read('src/llm/safe-fetch.js');
  assert.ok(/if \(total > maxBytes\) \{/.test(sf), '中断条件是 > 不能是 >=');
  assert.ok(/truncated: true,/.test(sf) && /truncated: false,/.test(sf));
  assert.equal(/Buffer\.byteLength\(body, 'utf8'\) >= 50000/.test(sf), false,
    '不许再拿 body 长度反推 truncated');
});

test('docker 组自愈做进了部署收尾：加组 + stop→sleep→start 重建（systemd 发行版通用件）', () => {
  // Issue #30 的根因之一：标准部署从不碰 docker 组成员关系 —— 控制台「更新协议端」
  // 从第一天起就报权限不足。收尾里把"加组 + 让管理器读到"都做掉（2026-10-09）。
  const sh = read('deploy.sh');
  assert.ok(/sudo usermod -aG docker/.test(sh), '要把部署用户加进 docker 组');
  assert.ok(/sudo systemctl stop "\$MANAGER_UNIT"/.test(sh),
    '重建要先 stop —— restart 会撞 status=219/CGROUP（cgroup 回收竞态，实测）');
  assert.ok(/sleep 3/.test(sh) && /sudo systemctl start "\$MANAGER_UNIT"/.test(sh),
    'stop 之后留回收间隔、再单独 start');
  assert.equal(/systemctl restart [^\n]*(MANAGER_UNIT|user@)/.test(sh), false,
    '不许用 restart 重建管理器：实测（systemd 249）219/CGROUP 失败后不会自动回来（服务停摆到人工 start）');
  // 自动更新场景必须跳过重建：无人值守时不做停服动作（位置序：分流判断在 stop 之前）
  const heal = sh.indexOf('# ── docker 组自愈');
  const skipBranch = sh.indexOf('if [[ -z "${QQ_AGENT_SOURCE_REVISION:-}" ]]; then', heal);
  const stopPos = sh.indexOf('sudo systemctl stop "$MANAGER_UNIT"', heal);
  assert.ok(heal > 0 && skipBranch > heal && stopPos > skipBranch,
    '自动更新（QQ_AGENT_SOURCE_REVISION 有值）要在重建动作之前分流跳过');
  // 自愈块必须在"部署已成功之后的收尾"段里（trap - ERR 之后）：失败不许改动退出码
  const cleanup = sh.indexOf('trap - ERR INT TERM');
  assert.ok(cleanup > 0 && heal > cleanup, '自愈块要在收尾段（尽力而为、不改退出码）');
});

test('terminate-user 与 restart user@ 两颗雷都拆干净了：提示与文档都不再当修复手段', () => {
  // 2026-10-09 实测（systemd 249）两颗雷：terminate-user 后管理器不会自动重建（服务停到下次登录）；
  // restart user@ 撞 status=219/CGROUP 同样不会自动回来。教用户照做 = 把机器人弄停。
  const js = read('src/core/snowluma-update.js');
  assert.equal(/sudo loginctl terminate-user/.test(js), false,
    'DOCKER_SOCKET_HINT 不许再把 terminate-user 当修复步骤');
  assert.equal(/sudo systemctl restart user@/.test(js), false,
    'restart user@ 也不许当修复命令（给 stop/sleep/start）');
  assert.ok(/sudo systemctl stop user@/.test(js) && /sudo systemctl start user@/.test(js));
  const md = read('docs/LINUX.md');
  assert.equal(/sudo loginctl terminate-user/.test(md), false);
  assert.equal(/sudo systemctl restart user@/.test(md), false);
  assert.ok(/不要用\s*`?systemctl restart user@/.test(md), '文档要写明为什么不用 restart user@');
  assert.ok(/不要用\s*`?loginctl terminate-user/.test(md), '文档要写明为什么不用 terminate-user');
});
