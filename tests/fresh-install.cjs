// 「新用户第一次 clone」全流程演练：把助手复制到隔离目录（模拟 clone 到别处），
// 配置为空、工作区在另一个地方、CLI 一开始找不到 —— 完全按 README 的顺序跑通。
// 运行：node wechat-release-helper/tests/fresh-install.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HELPER = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrh-fresh-install-'));
const clone = path.join(tmp, 'wechat-release-helper');
const workspace = path.join(tmp, 'my-workspace');
const configFile = path.join(tmp, 'fresh-config', 'config.json');
const fakeCli = path.join(tmp, 'fake-cli.cjs');
const invocations = path.join(tmp, 'invocations.log');
const PORT = 23000 + Math.floor(Math.random() * 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const servers = [];

async function waitForServer(port) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (error) { /* 等 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`端口 ${port} 服务未启动`);
}
function startServer(port, extra = {}) {
  const proc = spawn(process.execPath, [path.join(clone, 'upload-server.cjs')], {
    env: {
      ...process.env,
      WRH_UPLOAD_PORT: String(port),
      WRH_UPLOAD_ROOT: '',
      WECHAT_DEVTOOLS_CLI: '',
      WRH_CONFIG_FILE: configFile,
      WRH_PICKER: 'none',
      ...extra,
    },
    stdio: 'ignore',
  });
  servers.push(proc);
  return proc;
}
function api(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function main() {
  // README 步骤 2.1：模拟 clone 到任意目录，仓库里不带任何个人路径。
  fs.cpSync(HELPER, clone, { recursive: true, filter: src => !src.includes(`${path.sep}node_modules`) });
  assert.ok(fs.existsSync(path.join(clone, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(clone, 'README.md')));
  assert.ok(fs.existsSync(path.join(clone, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(clone, 'start-upload-server.bat')));
  const serverSrc = fs.readFileSync(path.join(clone, 'upload-server.cjs'), 'utf8');
  assert.equal(/dzpk_all|api\.aitht\.com/.test(serverSrc), false, '服务端不得残留任何业务专属硬编码');
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(clone, 'config.example.json'), 'utf8')), 'object');

  // README 步骤 1：一个全新的小程序工作区（不在助手目录旁边）。
  fs.mkdirSync(path.join(workspace, 'demo-app'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'demo-app', 'project.config.json'),
    JSON.stringify({ appid: 'wxabababababababab', projectname: '我的第一个小程序' }));
  fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.log("fake cli ok");\n');
  fs.chmodSync(fakeCli, 0o755);
  fs.writeFileSync(invocations, '');

  // README 步骤 2.2：刚启动、还没设置、CLI 也检测不到。
  startServer(PORT, { WRH_CONFIG_FILE: configFile, WECHAT_DEVTOOLS_CLI: path.join(tmp, 'missing-cli') });
  await waitForServer(PORT);
  const health = await (await api(PORT, '/api/health')).json();
  assert.equal(health.needsSetup, true, '全新 clone 应提示需要先设置');
  const first = await (await api(PORT, '/api/config')).json();
  assert.equal(first.rootExists, true);
  assert.equal(first.needsSetup, true, '默认根目录（clone 的上一级）里没有小程序');
  assert.equal(first.mode, 'direct');
  assert.equal(first.cliExists, false);
  assert.match(first.installGuide, /服务端口/, '应给出 CLI 安装指引');
  const badDoctor = await (await api(PORT, '/api/doctor')).json();
  assert.equal(badDoctor.ok, false);
  assert.ok(badDoctor.checks.find(item => item.key === 'cli').fix.includes('微信开发者工具'));
  console.log('步骤 1-2 通过：全新 clone 自检如实报告「需设置目录 / 缺 CLI」');

  // README 步骤 2.3 + 1.1：选择根目录、填好 CLI 路径，一次保存。
  const pickup = await (await api(PORT, '/api/pick-root', { method: 'POST' })).json();
  assert.equal(pickup.manual, true, '无图形环境时应提示手动粘贴路径');
  const saved = await (await api(PORT, '/api/config', {
    method: 'POST', body: { root: workspace, cliPath: fakeCli },
  })).json();
  assert.equal(saved.root, workspace);
  assert.equal(saved.needsSetup, false);
  assert.equal(saved.projectCount, 1);
  assert.equal(saved.projects, undefined, '配置接口只回摘要，不重复项目明细');
  const scan = await (await api(PORT, '/api/projects')).json();
  assert.equal(scan.projects.length, 1);
  assert.equal(scan.projects[0].label, '我的第一个小程序');
  assert.equal(scan.projects[0].ready, true, '纯原生项目不该被额外脚本要求拦住');
  assert.equal(fs.existsSync(configFile), true, '设置应写盘');
  const doctor = await (await api(PORT, '/api/doctor')).json();
  assert.ok(doctor.checks.find(item => item.key === 'root').ok);
  assert.ok(doctor.checks.find(item => item.key === 'cli').ok);
  console.log('步骤 3 通过：选择目录 + 填 CLI 路径后自检通过，配置已写盘');

  // README「以后就不用再选择了」：彻底重启服务，不再带任何路径环境变量。
  const restartPort = PORT + 1;
  startServer(restartPort, { WRH_CONFIG_FILE: configFile, WECHAT_DEVTOOLS_CLI: '' });
  await waitForServer(restartPort);
  const restored = await (await api(restartPort, '/api/config')).json();
  assert.equal(restored.root, workspace, '重启后应自动沿用上次选择');
  assert.equal(restored.cliExists, true);
  assert.equal(restored.needsSetup, false);
  console.log('步骤 4 通过：重启后无需再次选择目录，配置自动沿用');

  // README 步骤 4：先「仅预演」，不触碰开发者工具。
  fs.writeFileSync(invocations, '');
  const started = await api(restartPort, '/api/upload', {
    method: 'POST', body: { names: ['demo-app'], desc: '更新', dryRun: true },
  });
  assert.equal(started.status, 202);
  let job;
  for (let i = 0; i < 100; i += 1) {
    job = await (await api(restartPort, '/api/job')).json();
    if (!job.active) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'done');
  assert.deepEqual(job.results.map(item => item.status), ['预演通过']);
  assert.ok(job.logs.some(line => line.includes('cli upload --project')));
  assert.equal(fs.readFileSync(invocations, 'utf8').trim(), '', '预演不应调用任何 CLI');
  console.log('步骤 5 通过：按教程先预演，命令正确且没有真的上传');

  console.log('\n全新 clone 按 README 全流程跑通 ✅');
}

main().catch(error => {
  console.error('全新安装演练失败：', error.message);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
}).finally(() => {
  for (const proc of servers) { try { proc.kill('SIGTERM'); } catch (error) { /* 忽略 */ } }
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (error) { /* 忽略 */ } }, 300);
});
