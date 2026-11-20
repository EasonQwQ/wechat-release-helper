// 本机上传桥接服务测试：用隔离的假工作区 + 假 CLI，绝不触碰真实项目或开发者工具。
// 运行：node wechat-release-helper/tests/upload-server.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HELPER = path.join(__dirname, '..');
const SERVER = path.join(HELPER, 'upload-server.cjs');
const PORT = 19000 + Math.floor(Math.random() * 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrh-upload-test-'));
const root = path.join(tmp, 'workspace');
const fakeCli = path.join(tmp, 'fake-cli.cjs');
const invocations = path.join(tmp, 'invocations.log');
const configFile = path.join(tmp, 'config.json');
const ws2 = path.join(tmp, 'workspace2');
const servers = [];

function makeProject(dir, { appid, host = 'https://api.example.com', npm = true } = {}) {
  const base = path.join(root, dir);
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.writeFileSync(path.join(base, 'project.config.json'), JSON.stringify({ appid, projectname: dir }));
  fs.writeFileSync(path.join(base, 'config', 'index.js'),
    `module.exports = {\n  host: '${host}',\n  // host: 'http://localhost:9010',\n};\n`);
  fs.writeFileSync(path.join(base, 'scripts', 'upload-wechat.cjs'), '// 假上传脚本\n');
  if (npm) fs.mkdirSync(path.join(base, 'miniprogram_npm', 'tdesign-miniprogram'), { recursive: true });
  fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(base, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(base, 'tests', 'a.test.js'), '// test\n');
  fs.mkdirSync(path.join(base, '.wechat-upload'), { recursive: true });
  fs.writeFileSync(path.join(base, '.wechat-upload', 'upload-261119.1430-1792087924737.json'),
    JSON.stringify({ size: { total: 204800 } }));
}

function setupWorkspace() {
  fs.mkdirSync(root, { recursive: true });
  // 隔离的配置文件：业务专属的别名/接口地址校验不再硬编码在服务端，改由配置提供。
  fs.writeFileSync(configFile, JSON.stringify({
    expectedHost: 'https://api.example.com',
    labels: { shark_wx_xiaochengxu: '示例项目 A', blackcat_wx_xiaochengxu: '示例项目 B' },
  }, null, 2));
  // 第二个工作区：没有 upload-mini-programs.cjs，走「直接 CLI」通用模式。
  fs.mkdirSync(path.join(ws2, 'demo_miniapp'), { recursive: true });
  fs.writeFileSync(path.join(ws2, 'demo_miniapp', 'project.config.json'),
    JSON.stringify({ appid: 'wxaaaaaaaaaaaaaaaa', projectname: 'Demo Mini' }));
  makeProject('shark_wx_xiaochengxu', { appid: 'wx0101010101010101' });
  makeProject('blackcat_wx_xiaochengxu', { appid: 'wx0202020202020202' });
  makeProject('devhost_wx', { appid: 'wx1111111111111111', host: 'http://localhost:9010' });
  makeProject('nonpm_wx', { appid: 'wx2222222222222222', npm: false });
  fs.mkdirSync(path.join(root, 'not-a-project'), { recursive: true });
  // 根上传脚本：保持 projects 别名表可被解析，记录收到的参数，输出与真脚本一致的批次结果。
  fs.writeFileSync(path.join(root, 'upload-mini-programs.cjs'), `const fs = require('node:fs');
const projects = {
  shark: 'shark_wx_xiaochengxu',
  blackcat: 'blackcat_wx_xiaochengxu',
  devhost: 'devhost_wx',
  nonpm: 'nonpm_wx',
};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(args) + '\\n');
const names = args.filter(a => Object.hasOwn(projects, a));
console.log('批次结果');
for (const n of names) console.log('  ' + n + ': ' + (args.includes('--upload') ? '已上传' : '预演通过'));
if (process.env.WRH_TEST_SLOW) { const end = Date.now() + 3500; while (Date.now() < end) {} }
`);
  fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.log("fake cli ok");\n');
  fs.chmodSync(fakeCli, 0o755);
}

function startServer(port, extra = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WRH_UPLOAD_PORT: String(port),
      WRH_UPLOAD_ROOT: root,
      WECHAT_DEVTOOLS_CLI: fakeCli,
      WRH_CONFIG_FILE: configFile,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { proc, getStderr: () => stderr };
}

async function waitForServer(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch (error) { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`端口 ${port} 服务未在 6 秒内启动`);
}

function api(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function waitForJob(port) {
  for (let i = 0; i < 120; i += 1) {
    const data = await (await api(port, '/api/job')).json();
    if (!data.active) return data;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('任务未在 12 秒内结束');
}

async function main() {
  setupWorkspace();
  const { getStderr } = startServer(PORT);
  await waitForServer(PORT);
  assert.equal(getStderr().trim(), '', '服务启动不应报错');

  // 1) 扫描：只认 project.config.json + 上传脚本 + 合法 appid，读接口地址与上次上传记录。
  const scan = await (await api(PORT, '/api/projects')).json();
  assert.equal(scan.root, root);
  assert.equal(scan.cliExists, true);
  assert.deepEqual(scan.projects.map(p => p.id),
    ['blackcat_wx_xiaochengxu', 'devhost_wx', 'nonpm_wx', 'shark_wx_xiaochengxu'],
    '应识别 4 个项目，忽略 not-a-project');
  const shark = scan.projects.find(p => p.id === 'shark_wx_xiaochengxu');
  assert.equal(shark.appid, 'wx0101010101010101');
  assert.equal(shark.name, 'shark', '应从根脚本解析出短别名');
  assert.equal(shark.label, '示例项目 A');
  assert.equal(shark.hostOk, true, '注释掉的本地 host 不应误判');
  assert.equal(shark.lastUpload.version, '261119.1430');
  assert.equal(shark.lastUpload.sizeKB, 200);
  assert.equal(shark.ready, true);
  assert.equal(scan.projects.find(p => p.id === 'devhost_wx').hostOk, false);
  assert.match(scan.projects.find(p => p.id === 'nonpm_wx').blockers.join(), /miniprogram_npm/);
  console.log('用例 1 通过：项目识别、别名、接口地址与上传记录');

  // 2) 参数校验：未知项目 / 空说明 / 非法版本号 / 未还原的接口地址 / 缺 npm。
  for (const [body, pattern, label] of [
    [{ names: ['nope'], desc: 'x' }, /未知项目/, '未知项目'],
    [{ names: ['shark'], desc: '' }, /版本说明/, '空说明'],
    [{ names: ['shark'], desc: 'x', version: 'bad version!' }, /版本号/, '非法版本号'],
    [{ names: ['devhost'], desc: 'x' }, /api\.example\.com/, '接口地址未还原'],
    [{ names: ['nonpm'], desc: 'x' }, /miniprogram_npm/, '缺 miniprogram_npm'],
  ]) {
    const res = await api(PORT, '/api/upload', { method: 'POST', body });
    assert.equal(res.status, 400, label);
    assert.match((await res.json()).error, pattern, label);
  }
  console.log('用例 2 通过：5 类非法请求全部被拒绝');

  // 3) 预演：真调用根脚本，但 --upload 不出现；别名正确、日志与结果可回读。
  fs.writeFileSync(invocations, '');
  const started = await api(PORT, '/api/upload', {
    method: 'POST',
    body: { names: ['shark_wx_xiaochengxu', 'blackcat'], desc: '测试预演', version: '261120.0930', dryRun: true },
  });
  assert.equal(started.status, 202);
  const job = await waitForJob(PORT);
  assert.equal(job.status, 'done');
  assert.equal(job.dryRun, true);
  assert.deepEqual(job.names, ['shark_wx_xiaochengxu', 'blackcat_wx_xiaochengxu']);
  assert.deepEqual(job.results.map(r => r.status), ['预演通过', '预演通过']);
  const argv = fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(argv.length, 1, '根脚本只应调用一次');
  assert.ok(argv[0].includes('shark') && argv[0].includes('blackcat'), '应传短别名而不是目录名');
  assert.equal(argv[0].includes('--upload'), false, '预演不能真上传');
  assert.ok(job.logs.some(line => line.includes('任务开始')));
  console.log('用例 3 通过：预演上传、短别名、日志与结果回读');

  // 4) 正式上传参数：--upload 会出现在根脚本参数里（假脚本，不会碰真实 CLI）。
  fs.writeFileSync(invocations, '');
  await api(PORT, '/api/upload', {
    method: 'POST',
    body: { names: ['shark'], desc: '正式上传演练', buildNpm: true },
  });
  const real = await waitForJob(PORT);
  assert.equal(real.status, 'done');
  assert.deepEqual(real.results.map(r => r.status), ['已上传']);
  const realArgv = fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(realArgv[0].includes('--upload'), '正式上传必须带 --upload');
  assert.ok(real.logs.some(line => line.includes('build-npm')), '勾选后应先构建 npm');
  console.log('用例 4 通过：正式上传参数与构建 npm 前置步骤');

  // 5) 并发保护 + 停止：慢任务运行期间，第二个任务必须被 409 拒绝。
  const slowPort = PORT + 1;
  startServer(slowPort, { WRH_TEST_SLOW: '1' });
  await waitForServer(slowPort);
  const first = await api(slowPort, '/api/upload', { method: 'POST', body: { names: ['shark'], desc: '慢任务' } });
  assert.equal(first.status, 202);
  const second = await api(slowPort, '/api/upload', { method: 'POST', body: { names: ['shark'], desc: '并发' } });
  assert.equal(second.status, 409, '已有任务时应拒绝新任务');
  assert.match((await second.json()).error, /已有上传任务/);
  const stopped = await api(slowPort, '/api/stop', { method: 'POST' });
  assert.equal((await stopped.json()).stopped, true);
  const afterStop = await (await api(slowPort, '/api/job')).json();
  assert.equal(afterStop.status, 'stopped');
  console.log('用例 5 通过：并发 409 保护与停止任务');

  // 6) 安全：Host 必须指向本机；写操作拒绝 Origin: null（防 CSRF）。
  const http = require('node:http');
  const denied = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/projects', method: 'GET',
      headers: { Host: 'evil.example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(denied, 403, '伪造 Host 应被拒绝（DNS rebinding 防护）');
  const nullOrigin = await api(PORT, '/api/upload', {
    method: 'POST', body: { names: ['shark'], desc: 'csrf' }, headers: { Origin: 'null' },
  });
  assert.equal(nullOrigin.status, 403, 'Origin: null 的写操作应被拒绝');
  const extOrigin = await api(PORT, '/api/projects', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(extOrigin.status, 200, '扩展来源应被允许');
  console.log('用例 6 通过：Host / Origin 来源校验');

  // 7) 可选：真实工作区只读扫描。别人 clone 后没有小程序项目时自动跳过。
  const realRoot = process.env.WRH_REAL_ROOT || path.resolve(HELPER, '..');
  const hasProjects = (() => {
    try {
      return fs.readdirSync(realRoot, { withFileTypes: true }).some(entry => entry.isDirectory()
        && fs.existsSync(path.join(realRoot, entry.name, 'project.config.json')));
    } catch (error) { return false; }
  })();
  if (!hasProjects) {
    console.log('用例 7 跳过：本机没有真实小程序工作区（设置 WRH_REAL_ROOT 可启用）');
  } else {
    const realPort = PORT + 2;
    const realConfig = path.join(tmp, 'config-real.json');
    fs.writeFileSync(realConfig, JSON.stringify({ root: realRoot }));
    const realServer = spawn(process.execPath, [SERVER], {
      env: { ...process.env, WRH_UPLOAD_PORT: String(realPort), WRH_UPLOAD_ROOT: realRoot,
        WECHAT_DEVTOOLS_CLI: fakeCli, WRH_CONFIG_FILE: realConfig },
      stdio: 'ignore',
    });
    servers.push(realServer);
    await waitForServer(realPort);
    const realScan = await (await api(realPort, '/api/projects')).json();
    assert.ok(realScan.projects.length > 0, `真实工作区应识别到项目，实际 ${realScan.projects.length}`);
    assert.equal(realScan.projects.every(p => /^wx[a-f0-9]{16}$/.test(p.appid)), true, 'AppID 都应合法');
    assert.equal(realScan.projects.every(p => p.hostOk), true, '未配置接口地址校验时不应误拦');
    console.log(`用例 7 通过：真实工作区只读扫描到 ${realScan.projects.length} 个项目`);
  }

  // 8) 首次设置：配置读/写、非法路径拒绝、改根目录立即生效并写盘。
  {
    const cfg = await (await api(PORT, '/api/config')).json();
    assert.equal(cfg.root, root);
    assert.equal(cfg.expectedHost, 'https://api.example.com');
    assert.equal(cfg.cliExists, true);
    assert.equal(cfg.mode, 'batch');
    assert.equal(cfg.configFile, configFile);
    const relative = await api(PORT, '/api/config', { method: 'POST', body: { root: 'relative/path' } });
    assert.equal(relative.status, 400);
    assert.match((await relative.json()).error, /绝对路径/);
    const absent = await api(PORT, '/api/config', { method: 'POST', body: { root: path.join(tmp, 'nope') } });
    assert.equal(absent.status, 400);
    assert.match((await absent.json()).error, /目录不存在/);
    const badHost = await api(PORT, '/api/config', { method: 'POST', body: { expectedHost: 'not-a-url' } });
    assert.equal(badHost.status, 400);
    const switched = await (await api(PORT, '/api/config', { method: 'POST', body: { root: ws2 } })).json();
    assert.equal(switched.root, ws2);
    assert.equal(switched.mode, 'direct', '没有根上传脚本时应切到通用模式');
    assert.equal(switched.projectCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).root, ws2, '设置应持久化到配置文件');
    const scan2 = await (await api(PORT, '/api/projects')).json();
    assert.equal(scan2.root, ws2);
    assert.equal(scan2.projects[0].id, 'demo_miniapp');
    await api(PORT, '/api/config', { method: 'POST', body: { root } });
    console.log('用例 8 通过：项目根目录可选、写盘持久化、非法输入被拒');
  }

  // 9) 通用模式：没有任何项目内脚本，也能直接调 CLI；预演只打印命令不碰开发者工具。
  {
    const config2 = path.join(tmp, 'config2.json');
    fs.writeFileSync(config2, JSON.stringify({ root: ws2 }));
    const directPort = PORT + 3;
    startServer(directPort, { WRH_CONFIG_FILE: config2, WRH_UPLOAD_ROOT: ws2, WRH_PICKER: 'none' });
    await waitForServer(directPort);
    const scan = await (await api(directPort, '/api/projects')).json();
    assert.equal(scan.mode, 'direct');
    assert.equal(scan.projects.length, 1);
    assert.equal(scan.projects[0].ready, true, '纯原生小程序不该被 miniprogram_npm 拦住');
    assert.equal(scan.projects[0].hasScript, false);
    assert.ok(scan.projects[0].warnings.join().includes('miniprogram_npm'), '缺少 npm 时应给警告而非阻断');
    fs.writeFileSync(invocations, '');
    const started = await api(directPort, '/api/upload', {
      method: 'POST', body: { names: ['demo_miniapp'], desc: '通用模式预演', dryRun: true },
    });
    assert.equal(started.status, 202);
    const done = await waitForJob(directPort);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.results.map(item => item.status), ['预演通过']);
    assert.ok(done.logs.some(line => line.includes('cli upload --project')), '应打印要执行的 CLI 命令');
    assert.equal(fs.readFileSync(invocations, 'utf8').trim(), '', '预演绝不能调用任何上传脚本');
    console.log('用例 9 通过：通用模式无需项目内脚本，预演只打印命令');
  }

  // 10) CLI 检测 + 一键自检 + islogin：缺 CLI 时给出安装指引并阻断上传。
  {
    const config3 = path.join(tmp, 'config3.json');
    fs.writeFileSync(config3, JSON.stringify({ root: ws2, cliPath: path.join(tmp, 'missing-cli') }));
    const envPort = PORT + 4;
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, WRH_UPLOAD_PORT: String(envPort), WRH_UPLOAD_ROOT: ws2,
        WECHAT_DEVTOOLS_CLI: '', WRH_CONFIG_FILE: config3, WRH_PICKER: 'none' },
      stdio: 'ignore',
    });
    servers.push(proc);
    await waitForServer(envPort);
    const cfg = await (await api(envPort, '/api/config')).json();
    assert.equal(cfg.cliExists, false, '手动指定的 CLI 路径不存在应如实报告');
    assert.ok(cfg.installGuide.includes('服务端口'), '应给出安装指引');
    const doc = await (await api(envPort, '/api/doctor')).json();
    assert.equal(doc.ok, false);
    assert.ok(doc.checks.some(item => item.key === 'cli' && !item.ok && item.fix.includes('服务端口')));
    const blocked = await api(envPort, '/api/upload', {
      method: 'POST', body: { names: ['demo_miniapp'], desc: 'x' },
    });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /未找到微信开发者工具 CLI/);
    const manual = await (await api(envPort, '/api/pick-root', { method: 'POST' })).json();
    assert.equal(manual.manual, true, '无图形选择器时应提示手动粘贴路径');
    // 保存一个可用的 CLI 路径后立即恢复
    const fixed = await (await api(envPort, '/api/config', {
      method: 'POST', body: { cliPath: fakeCli },
    })).json();
    assert.equal(fixed.cliExists, true);
    assert.equal(fixed.cliPath, fakeCli);
    const login = await (await api(envPort, '/api/islogin', { method: 'POST' })).json();
    assert.equal(login.ok, true, '假 CLI 应能被成功调用');
    assert.equal(login.loggedIn, false, '假 CLI 没有输出 {"login":true}，不得谎报已登录');
    console.log('用例 10 通过：CLI 自动/手动检测、安装指引、自检与登录状态');
  }

  console.log('\n上传服务测试全部通过（10 例）');
}

main().catch(error => {
  console.error('测试失败：', error.message);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
}).finally(() => {
  for (const proc of servers) { try { proc.kill('SIGTERM'); } catch (e) { /* 忽略 */ } }
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }, 300);
});
