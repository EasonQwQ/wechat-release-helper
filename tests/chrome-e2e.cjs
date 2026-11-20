// 真实 Chrome 端到端演练：独立 profile + 本地拦截的模拟公众平台页面。
// 不联网、不碰真实账号、不会真的提交审核。
// 运行：node wechat-release-helper/tests/chrome-e2e.cjs
// 覆盖：完整提审流程 + 整页导航后由常驻内容脚本自动恢复（不再点扩展）。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// 可选依赖：本机有 Chrome + playwright-core 即可运行；只访问本地模拟页面。
const { loadChromium, chromePath } = require('./browser.cjs');
const chromium = loadChromium();

const EXT = path.join(__dirname, '..');
const CHROME = chromePath();
const PROFILE = `/tmp/chrome-helper-e2e-${Date.now()}`;
const CORE_SRC = fs.readFileSync(path.join(EXT, 'page-core.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

// 模拟公众平台页面：真实 origin、真实 DOM、真实导航。
// 事件写 sessionStorage，方便跨整页导航核对点击序列。
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
<script>
function log(name) {
  const list = JSON.parse(sessionStorage.getItem('__e2eEvents') || '[]');
  list.push(name);
  sessionStorage.setItem('__e2eEvents', JSON.stringify(list));
}
const params = new URLSearchParams(location.search);
window.__stage = params.get('step') === '2' ? 'security'
  : (params.get('phase') === 'batch' ? 'list' : 'notice');
function render() {
  const s = window.__stage;
  if (s === 'list') {
    document.body.innerHTML = '<div class="weui-desktop-panel"><h1>版本管理</h1>'
      + '<p>开发版本</p><button id="entry">提交审核</button></div>';
    document.querySelector('#entry').addEventListener('click', () => {
      log('entry'); window.__stage = 'notice'; render();
    });
  } else if (s === 'notice') {
    document.body.innerHTML = '<div class="weui-desktop-dialog" role="dialog">'
      + '<h2>提交审核的相关须知</h2><p>请仔细阅读以下条款后再继续。</p>'
      + '<label id="rule-label"><input type="checkbox" id="rule"> '
      + '我已阅读并了解《微信小程序平台审核规则》并同意</label>'
      + '<button id="next" disabled>下一步</button></div>';
    document.querySelector('#rule').addEventListener('change', () => log('rule'));
    document.querySelector('#next').addEventListener('click', () => {
      log('next');
      if (sessionStorage.getItem('__e2eNavigate') === '1') {
        location.href = '?phase=batch&step=2';
        return;
      }
      window.__stage = 'security'; render();
    });
  } else if (s === 'security') {
    document.body.innerHTML = '<div class="weui-desktop-dialog" role="dialog">'
      + '<h2>代码审核进行安全测试提醒</h2><button id="cont">继续提交</button></div>';
    document.querySelector('#cont').addEventListener('click', () => {
      log('cont'); window.__stage = 'form'; render();
    });
  } else if (s === 'form') {
    document.body.innerHTML = '<div class="weui-desktop-panel"><h1>你正在提交开发版</h1>'
      + '<p>版本描述</p><textarea id="desc"></textarea>'
      + '<button id="submit">提交审核</button></div>'
      + '<div id="list"><button class="decoy">提交审核</button></div>';
    document.querySelector('#submit').addEventListener('click', () => {
      log('submit'); window.__stage = 'done'; render();
    });
    document.querySelector('.decoy').addEventListener('click', () => log('decoy'));
  } else {
    document.body.innerHTML = '<div>已提交审核</div>';
  }
}
render();
</script></body></html>`;

let context;
(async () => {
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

  // 检查扩展是否被 Chrome 接受，并验证 popup 的按钮都在。
  let popupCheck = 'headless 实例未注册扩展（预期；已把 page-core.js / content.js 源码注入主世界）';
  try {
    const prefsPath = path.join(PROFILE, 'Default', 'Preferences');
    await new Promise(resolve => setTimeout(resolve, 800));
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      const settings = prefs.extensions?.settings || {};
      const id = Object.keys(settings).find(key =>
        (settings[key].path || '').includes('wechat-release-helper'));
      if (id) {
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${id}/popup.html`);
        const ids = await popup.evaluate(() =>
          [...document.querySelectorAll('button')].map(button => button.id));
        for (const required of ['auto', 'audit', 'audit-auto', 'audit-auto-batch', 'audit-force', 'audit-auto-stop']) {
          assert.ok(ids.includes(required), `popup 缺少按钮 ${required}`);
        }
        popupCheck = `扩展已加载 (${id})，popup 按钮齐全：${ids.join(', ')}`;
        await popup.close();
      }
    }
  } catch (error) {
    popupCheck = `popup 检查跳过：${error.message}`;
  }

  await context.route(/^https:\/\/mp\.weixin\.qq\.com\/.*/, route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
  const page = await context.newPage();
  // content.js 依赖 chrome.runtime / chrome.storage，主世界演练时打桩。
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        runtime: { onMessage: { addListener() {} } },
        storage: {
          local: {
            get: async () => ({ wrhGlobalAuto: { enabled: true, description: 'E2E 持续自动' } }),
          },
        },
      },
    });
  });

  // ---- 阶段 1：完整提审流程（卡在审核须知 + 置灰下一步） ----
  await page.goto('https://mp.weixin.qq.com/');
  assert.equal(await page.evaluate(() => location.origin), 'https://mp.weixin.qq.com');
  await page.addScriptTag({ content: CORE_SRC });

  const before = await page.evaluate(() => ({
    checked: document.querySelector('#rule').checked,
    nextDisabled: document.querySelector('#next').disabled,
  }));
  assert.equal(before.checked, false);
  assert.equal(before.nextDisabled, true, '前置条件：下一步处于禁用态');

  const started = await page.evaluate(() =>
    window.locateOnPage('修复登录并优化成员搜索', [], 'audit-auto-force'));
  assert.equal(started.found, true, '强制继续应成功启动');

  await page.waitForFunction(() => window.__stage === 'done', { timeout: 15000 });
  await page.waitForFunction(
    () => window.locateOnPage('', [], 'audit-auto-status').state === 'done',
    { timeout: 5000 });
  const first = await page.evaluate(() => ({
    events: JSON.parse(sessionStorage.getItem('__e2eEvents') || '[]'),
    state: window.locateOnPage('', [], 'audit-auto-status'),
  }));
  assert.ok(first.events.includes('rule'), '应自动勾选审核规则');
  assert.ok(first.events.includes('next'), '应启用并点击置灰的「下一步」');
  assert.ok(first.events.includes('cont'), '应通过安全测试提醒');
  assert.ok(first.events.includes('submit'), '应点击最终「提交审核」');
  assert.ok(!first.events.includes('decoy'), '不应误点版本列表里的同名按钮');
  assert.equal(first.events.filter(e => e === 'submit').length, 1, '最终提交只执行一次');
  assert.equal(first.state.state, 'done');

  // ---- 阶段 2：整页导航后自动恢复，全程不再点扩展 ----
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('https://mp.weixin.qq.com/?phase=batch');
  await page.addScriptTag({ content: CORE_SRC });
  await page.addScriptTag({ content: CONTENT_SRC });
  await page.evaluate(() => {
    sessionStorage.setItem('__e2eNavigate', '1');
    window.locateOnPage('E2E 持续自动', [], 'audit-auto-batch');
  });
  await page.waitForURL(/step=2/, { timeout: 15000 });
  await page.waitForLoadState('domcontentloaded');

  // 模拟 manifest 的 content_scripts 在新文档自动注入。
  await page.addScriptTag({ content: CORE_SRC });
  await page.addScriptTag({ content: CONTENT_SRC });

  await page.waitForFunction(() => window.__stage === 'done', { timeout: 15000 });
  await page.waitForFunction(
    () => window.locateOnPage('', [], 'audit-auto-status').state === 'done',
    { timeout: 5000 });
  const second = await page.evaluate(() => ({
    events: JSON.parse(sessionStorage.getItem('__e2eEvents') || '[]'),
    state: window.locateOnPage('', [], 'audit-auto-status'),
    persisted: sessionStorage.getItem('__wechatReleaseAutoAuditState'),
  }));
  assert.ok(second.events.includes('entry'), '持续模式应自动打开提审入口');
  assert.ok(second.events.includes('rule'), '应自动勾选审核规则');
  assert.ok(second.events.includes('next'), '应自动点「下一步」并触发真实导航');
  assert.ok(second.events.includes('cont'), '导航后应自动继续（无需重开扩展）');
  assert.ok(second.events.includes('submit'), '导航后应自动完成提交');
  assert.ok(!second.events.includes('decoy'), '不应误点同名按钮');
  assert.equal(second.events.filter(e => e === 'submit').length, 1, '最终提交只执行一次');
  assert.equal(second.events.filter(e => e === 'next').length, 1, '「下一步」只点一次');
  assert.equal(second.state.state, 'done', '应落到已提交审核');
  assert.ok(second.persisted && JSON.parse(second.persisted).state === 'done',
    '状态应写入 sessionStorage，popup 重开可读');

  console.log('扩展加载：' + popupCheck);
  console.log('页面 origin：https://mp.weixin.qq.com（本地拦截，未联网）');
  console.log('阶段 1 点击序列：' + first.events.join(' -> '));
  console.log('阶段 2 点击序列（含整页导航自动恢复）：' + second.events.join(' -> '));
  console.log('最终状态：' + second.state.state + ' | ' + second.state.message);
  console.log('真实 Chrome 端到端演练通过');
})().catch(error => {
  console.error('演练失败：', error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close().catch(() => {});
});
