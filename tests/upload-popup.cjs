// 本地上传的弹窗端到端测试：真实 Chrome 加载真实 popup.html，真实上传服务，
// 但工作区和 CLI 都是隔离的假对象，只跑预演/假上传，绝不触碰真实小程序或开发者工具。
// 运行：node wechat-release-helper/tests/upload-popup.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadChromium, chromePath } = require('./browser.cjs');
const chromium = loadChromium();
const HELPER = path.join(__dirname, '..');
const CHROME = chromePath();
const PORT = 21000 + Math.floor(Math.random() * 3000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrh-upload-popup-'));
const root = path.join(tmp, 'workspace');
const fakeCli = path.join(tmp, 'fake-cli.cjs');
const invocations = path.join(tmp, 'invocations.log');
const configFile = path.join(tmp, 'config.json');
let server;
let context;

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

function setup() {
  fs.mkdirSync(root, { recursive: true });
  // 业务专属的别名与接口地址校验由本机配置提供，服务端不再硬编码。
  fs.writeFileSync(configFile, JSON.stringify({
    expectedHost: 'https://api.example.com',
    labels: { shark_wx_xiaochengxu: '示例项目 A', blackcat_wx_xiaochengxu: '示例项目 B' },
  }, null, 2));
  makeProject('shark_wx_xiaochengxu', { appid: 'wx0101010101010101' });
  makeProject('blackcat_wx_xiaochengxu', { appid: 'wx0202020202020202' });
  makeProject('devhost_wx', { appid: 'wx1111111111111111', host: 'http://localhost:9010' });
  makeProject('nonpm_wx', { appid: 'wx2222222222222222', npm: false });
  fs.writeFileSync(path.join(root, 'upload-mini-programs.cjs'), `const fs = require('node:fs');
const projects = { shark: 'shark_wx_xiaochengxu', blackcat: 'blackcat_wx_xiaochengxu',
  devhost: 'devhost_wx', nonpm: 'nonpm_wx' };
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(args) + '\\n');
const names = args.filter(a => Object.hasOwn(projects, a));
console.log('批次结果');
for (const n of names) console.log('  ' + n + ': ' + (args.includes('--upload') ? '已上传' : '预演通过'));
`);
  fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.log("fake cli ok");\n');
  fs.chmodSync(fakeCli, 0o755);
  fs.writeFileSync(invocations, '');
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${ORIGIN}/api/health`)).ok) return; } catch (e) { /* 等 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('上传服务未启动');
}

// popup 从服务同源加载，fetch 不需要扩展权限；服务地址通过 localStorage 注入。
async function makePopup(base = ORIGIN) {
  const popup = await context.newPage();
  await popup.addInitScript(({ origin }) => {
    window.confirm = () => true;
    localStorage.setItem('wrhUploadBase', origin);
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      tabs: {
        query: async () => [{ id: 1, url: 'https://mp.weixin.qq.com/' }],
        get: async () => ({ status: 'complete' }),
        create: async () => ({}),
      },
      scripting: { executeScript: async () => [{ result: { found: false, message: '' } }] },
    } });
  }, { origin: base });
  popup.on('pageerror', error => console.log('[popup pageerror]', error.message));
  await popup.goto(`${ORIGIN}/popup.html`);
  return popup;
}

async function main() {
  setup();
  server = spawn(process.execPath, [path.join(HELPER, 'upload-server.cjs')], {
    env: { ...process.env, WRH_UPLOAD_PORT: String(PORT), WRH_UPLOAD_ROOT: root,
      WECHAT_DEVTOOLS_CLI: fakeCli, WRH_CONFIG_FILE: configFile, WRH_PICKER: 'none' },
    stdio: 'ignore',
  });
  await waitForServer();
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  });

  // 场景 1：刷新识别 → 列出项目、appid、上次上传；有问题的项目不可勾选。
  {
    const popup = await makePopup();
    await popup.click('#upload-refresh');
    await popup.waitForFunction(() => /识别到 4 个本地小程序/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 10000 });
    const checks = await popup.locator('#upload-list input[name="upload-project"]').evaluateAll(els => els.map(el => ({
      value: el.value, disabled: el.disabled,
    })));
    assert.equal(checks.length, 4, '应列出 4 个本地小程序');
    assert.deepEqual(checks.filter(c => !c.disabled).map(c => c.value),
      ['blackcat_wx_xiaochengxu', 'shark_wx_xiaochengxu'], '接口地址/依赖有问题的项目必须禁用');
    const listText = await popup.textContent('#upload-list');
    assert.match(listText, /wx0101010101010101/, '应显示 appid');
    assert.match(listText, /示例项目 A/, '应显示友好名称');
    assert.match(listText, /上次 261119\.1430/, '应显示上次上传版本');
    assert.match(listText, /接口地址是 http:\/\/localhost:9010/, '应提示接口地址未还原');
    assert.equal(await popup.inputValue('#upload-desc'), '更新', '版本说明应预填「更新」');
    assert.equal(await popup.isDisabled('#upload-start'), true, '未勾选项目时上传按钮禁用');
    await popup.check('#upload-list input[value="shark_wx_xiaochengxu"]');
    assert.equal(await popup.isDisabled('#upload-start'), false,
      '只勾选项目、不碰版本说明也应能上传');
    console.log('场景 1 通过：刷新识别本地项目、appid、上次上传与阻断提示');
    await popup.close();
  }

  // 场景 2：填写说明 + 勾选 + 预演 → 真实调用本机服务，日志与结果回到弹窗。
  {
    fs.writeFileSync(invocations, '');
    const popup = await makePopup();
    await popup.click('#upload-refresh');
    await popup.waitForFunction(() => /识别到 4 个本地小程序/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 10000 });
    await popup.check('#upload-list input[value="shark_wx_xiaochengxu"]');
    await popup.fill('#upload-desc', '端到端预演说明');
    await popup.fill('#upload-version', '261120.0930');
    await popup.check('#upload-dry-run');
    assert.equal(await popup.isDisabled('#upload-start'), false, '条件齐备后上传按钮应可用');
    await popup.click('#upload-start');
    await popup.waitForFunction(() => /预演完成/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 15000 });
    const result = await popup.textContent('#upload-info');
    assert.match(result, /shark_wx_xiaochengxu: 预演通过/, '应回报每个项目结果');
    assert.match(await popup.textContent('#upload-log'), /预演（不真上传）/, '应显示 CLI 日志');
    const argv = fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(argv.length, 1, '根上传脚本应被调用一次');
    assert.ok(argv[0].includes('shark'), '应传短别名');
    assert.ok(argv[0].includes('261120.0930') && argv[0].includes('端到端预演说明'), '版本与说明应传到脚本');
    assert.equal(argv[0].includes('--upload'), false, '预演绝不能真上传');
    assert.equal(await popup.isDisabled('#upload-start'), false, '任务结束后按钮应可再次使用');
    console.log('场景 2 通过：弹窗点上传 → 本机服务 → CLI 脚本（预演）→ 日志回显');
    await popup.close();
  }

  // 场景 3：正式上传（仍是假脚本）→ --upload 参数必须出现。
  {
    fs.writeFileSync(invocations, '');
    const popup = await makePopup();
    await popup.click('#upload-refresh');
    await popup.waitForFunction(() => /识别到 4 个本地小程序/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 10000 });
    await popup.check('#upload-list input[value="blackcat_wx_xiaochengxu"]');
    await popup.fill('#upload-desc', '正式上传演练');
    await popup.click('#upload-start');
    await popup.waitForFunction(() => /上传批次结束/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 15000 });
    assert.match(await popup.textContent('#upload-info'), /blackcat_wx_xiaochengxu: 已上传/);
    const argv = fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(argv[0].includes('--upload'), '正式上传必须带 --upload');
    console.log('场景 3 通过：正式上传参数正确');
    await popup.close();
  }

  // 场景 4：服务未启动时给出明确指引，不出现 JS 异常。
  {
    const popup = await makePopup('http://127.0.0.1:1');
    await popup.click('#upload-refresh');
    await popup.waitForFunction(() => /识别失败/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 10000 });
    assert.match(await popup.textContent('#upload-info'), /start-upload-server\.command/,
      '应提示启动本机服务');
    assert.match(await popup.textContent('#upload-info'), /打开完整上传面板/,
      '应给出免权限的同源面板兜底');
    assert.equal(await popup.isDisabled('#upload-start'), true, '服务不可用时不能上传');
    console.log('场景 4 通过：服务未启动时的错误指引');
    await popup.close();
  }

  // 场景 5：默认主界面只露 4 个按钮；网页端「设为体验版」在折叠区。
  {
    const popup = await makePopup();
    const layout = await popup.evaluate(() => {
      const visible = el => el.checkVisibility();
      return {
        visible: [...document.querySelectorAll('button')].filter(visible).map(b => b.id),
        uploadCardVisible: document.querySelector('#upload-card').checkVisibility(),
        statusBeforeDetails: !!(document.querySelector('#status')
          .compareDocumentPosition(document.querySelector('#more')) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert.deepEqual(layout.visible.sort(),
      ['audit-auto-batch', 'audit-auto-stop', 'upload-refresh', 'upload-start']);
    assert.equal(layout.uploadCardVisible, true, '本地上传卡片应默认可见');
    assert.equal(layout.statusBeforeDetails, true, '状态栏应在折叠区之前');
    console.log('场景 5 通过：默认 4 个按钮，本地上传卡片为主入口');
    await popup.close();
  }

  // 场景 6：版本说明预填「更新」——全程不碰输入框，勾选后直接预演，说明应原样传到 CLI。
  {
    fs.writeFileSync(invocations, '');
    const popup = await makePopup();
    await popup.click('#upload-refresh');
    await popup.waitForFunction(() => /识别到 4 个本地小程序/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 10000 });
    assert.equal(await popup.inputValue('#upload-desc'), '更新', '打开弹窗即应预填「更新」');
    await popup.check('#upload-list input[value="shark_wx_xiaochengxu"]');
    await popup.check('#upload-dry-run');
    assert.equal(await popup.isDisabled('#upload-start'), false, '预填说明后无需手动填写即可上传');
    await popup.click('#upload-start');
    await popup.waitForFunction(() => /预演完成/.test(document.querySelector('#upload-info').textContent),
      null, { timeout: 15000 });
    const argv = fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(argv.length, 1, '根上传脚本应被调用一次');
    assert.ok(argv[0].includes('更新'), '预填的「更新」应作为 --desc 传给 CLI');
    assert.equal(argv[0].includes('--upload'), false, '预演不真上传');
    console.log('场景 6 通过：不手动填说明，勾选即上传且说明为「更新」');
    await popup.close();
  }

  // 场景 7：完整上传面板同样预填，勾选项目即可上传。
  {
    const panel = await context.newPage();
    await panel.goto(`${ORIGIN}/`);
    await panel.waitForFunction(() => /识别到 4 个项目/.test(document.querySelector('#status').textContent),
      null, { timeout: 10000 });
    assert.equal(await panel.inputValue('#desc'), '更新', '完整面板的版本说明也应预填「更新」');
    await panel.check('#cards input[value="shark_wx_xiaochengxu"]');
    assert.equal(await panel.isDisabled('#upload'), false, '面板勾选后无需填说明即可上传');
    console.log('场景 7 通过：完整上传面板同样预填「更新」');
    await panel.close();
  }

  // 场景 8：完整面板的首次设置 —— 配置回显、安装指引、一键自检、目录选择兜底、保存生效。
  {
    const panel = await context.newPage();
    const errors = [];
    panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`${ORIGIN}/`);
    await panel.waitForFunction(() => /配置文件/.test(document.querySelector('#env-status').textContent),
      null, { timeout: 10000 });
    assert.equal(await panel.inputValue('#cfg-root'), root, '应回显当前项目根目录');
    assert.equal(await panel.inputValue('#cfg-host'), 'https://api.example.com');
    assert.match(await panel.textContent('#cli-guide'), /服务端口/, '应展示 CLI 安装指引');
    await panel.click('#doctor');
    await panel.waitForFunction(() => !document.querySelector('#doctor').disabled
      && /自检/.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
    const report = await panel.textContent('#doctor-log');
    assert.match(report, /Node\.js/, '自检应报告 Node 版本');
    assert.match(report, /根目录/, '自检应检查根目录');
    assert.match(report, /CLI/, '自检应检查 CLI');
    await panel.click('#pick-root');
    await panel.waitForFunction(() => /无法打开目录选择框/.test(document.querySelector('#status').textContent),
      null, { timeout: 10000 });
    await panel.fill('#cfg-host', 'https://api.example.org');
    await panel.click('#save-config');
    await panel.waitForFunction(() => /api\.example\.org/.test(document.querySelector('#cfg-host').value),
      null, { timeout: 10000 });
    const cfg = await (await fetch(`${ORIGIN}/api/config`)).json();
    assert.equal(cfg.expectedHost, 'https://api.example.org', '保存后服务端配置应立即生效');
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).expectedHost,
      'https://api.example.org', '保存后应写入配置文件');
    assert.deepEqual(errors, [], '面板不应有 JS 异常');
    await fetch(`${ORIGIN}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedHost: 'https://api.example.com' }),
    });
    await panel.close();
    console.log('场景 8 通过：完整面板的环境设置、自检、目录选择兜底与配置持久化');
  }

  // 场景 9：扩展弹窗折叠区的设置项同样能读取并保存配置。
  {
    const popup = await makePopup();
    await popup.waitForFunction(() => /目录：/.test(document.querySelector('#config-status').textContent),
      null, { timeout: 10000 });
    assert.equal(await popup.inputValue('#config-root'), root, '应回显项目根目录');
    assert.match(await popup.textContent('#config-status'), /CLI：已找到/);
    await popup.locator('#more').evaluate(el => { el.open = true; });
    await popup.fill('#config-host', '');
    await popup.click('#config-save');
    await popup.waitForFunction(() => /已保存|保存失败/.test(document.querySelector('#config-status').textContent),
      null, { timeout: 10000 });
    assert.match(await popup.textContent('#config-status'), /已保存/, '应提示保存成功');
    const cfg = await (await fetch(`${ORIGIN}/api/config`)).json();
    assert.equal(cfg.expectedHost, '', '清空接口地址后应不再校验');
    await fetch(`${ORIGIN}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedHost: 'https://api.example.com' }),
    });
    await popup.close();
    console.log('场景 9 通过：弹窗内可直接完成首次设置并持久化');
  }

  console.log('\n本地上传弹窗端到端测试全部通过（9 场景）');
}

main().catch(error => {
  console.error('本地上传弹窗测试失败：', error.message);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close().catch(() => {});
  if (server) { try { server.kill('SIGTERM'); } catch (e) { /* 忽略 */ } }
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }, 300);
});
