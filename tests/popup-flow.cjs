// 弹窗层集成测试：在真实 Chrome 里加载真实 popup.html + popup.js + page-core.js，
// 用打桩的 chrome.* 把指令转发到同一个浏览器里的模拟公众平台页面。
// 覆盖「用户实际点的按钮」，避免只测页面逻辑、漏掉 popup 自身的运行时错误。
// 运行：node wechat-release-helper/tests/popup-flow.cjs（需要本机 Chrome + playwright-core）
const path = require('node:path');
const assert = require('node:assert/strict');

const { loadChromium, chromePath } = require('./browser.cjs');
const chromium = loadChromium();

const EXT = path.join(__dirname, '..');
const CHROME = chromePath();
const PROFILE = `/tmp/chrome-helper-popup-${Date.now()}`;

// 模拟公众平台：默认停在「审核须知」；?list=1 时展示带「提交审核」入口的版本管理页。
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
<script>
const params = new URLSearchParams(location.search);
window.__stage = params.get('list') ? 'list' : (params.get('trial') ? 'trial' : (params.get('home') ? 'home' : 'notice'));
window.__trialClicks = 0;
function render() {
  const s = window.__stage;
  if (s === 'list') {
    document.body.innerHTML = '<div class="weui-desktop-panel"><h1>版本管理</h1>'
      + '<button id="entry">提交审核</button></div>';
    document.querySelector('#entry').addEventListener('click', () => {
      window.__stage = 'notice'; render();
    });
  } else if (s === 'home') {
    document.body.innerHTML = '<div class="weui-desktop-account__name">示例俱乐部</div>'
      + '<div><h1>首页</h1><button id="nav">版本管理</button></div>';
    document.getElementById('nav').addEventListener('click', () => {
      window.__stage = 'trial'; render();
    });
  } else if (s === 'trial') {
    document.body.innerHTML = '<div class="weui-desktop-account__name">示例俱乐部</div>'
      + '<div class="weui-desktop-panel"><h1>版本管理</h1>'
      + '<div class="version-card"><span>261120.0930</span><button id="t0">设为体验版</button></div>'
      + '<div class="version-card"><span>261119.1430</span><button id="t1">设为体验版</button></div></div>';
    for (const id of ['t0', 't1']) {
      document.getElementById(id).addEventListener('click', () => {
        window.__trialClicks += 1;
        window.__chosen = id;
        window.__stage = 'trial-confirm'; render();
      });
    }
  } else if (s === 'trial-confirm') {
    document.body.innerHTML = '<div class="weui-desktop-dialog" role="dialog">'
      + '<h2>确认设为体验版</h2><button id="ok">确定</button></div>';
    document.getElementById('ok').addEventListener('click', () => {
      window.__stage = 'trial-done'; render();
    });
  } else if (s === 'trial-done') {
    document.body.innerHTML = '<div>已设为体验版</div>';
  } else if (s === 'notice') {
    document.body.innerHTML = '<div class="weui-desktop-dialog" role="dialog">'
      + '<h2>提交审核的相关须知</h2>'
      + '<label><input type="checkbox" id="rule"> 已阅读并了解平台审核规则</label>'
      + '<button id="next" disabled>下一步</button></div>';
    document.querySelector('#next').addEventListener('click', () => {
      window.__stage = 'security'; render();
    });
  } else if (s === 'security') {
    document.body.innerHTML = '<div class="weui-desktop-dialog" role="dialog">'
      + '<h2>代码审核进行安全测试提醒</h2><button id="cont">继续提交</button></div>';
    document.querySelector('#cont').addEventListener('click', () => {
      window.__stage = 'form'; render();
    });
  } else if (s === 'form') {
    document.body.innerHTML = '<div class="weui-desktop-panel"><h1>你正在提交开发版</h1>'
      + '<p>版本描述</p><textarea id="desc"></textarea>'
      + '<button id="submit">提交审核</button></div>';
    document.querySelector('#submit').addEventListener('click', () => {
      window.__stage = 'done'; render();
    });
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
    args: ['--no-sandbox'],
  });
  await context.route(/^https:\/\/mp\.weixin\.qq\.com\/.*/, route =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
  // 弹窗打开时会静默探测本机上传服务；本套测试聚焦网页提审，桩掉以免控制台噪音。
  await context.route(/^http:\/\/127\.0\.0\.1:17823\/.*/, route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"active":false}' }));

  // withStorage=false 模拟「扩展还没重新加载、manifest 里没有 storage 权限」的情况。
  async function makePair(withStorage) {
    const target = await context.newPage();
    await target.goto('https://mp.weixin.qq.com/');
    const popup = await context.newPage();
    await popup.exposeFunction('__execInPage', async ({ src, args }) =>
      target.evaluate(({ source, params }) => {
        const fn = (0, eval)('(' + source + ')');
        return fn(...params);
      }, { source: src, params: args }));
    await popup.addInitScript((flag) => {
      window.confirm = () => true;
      const store = new Map();
      const chromeStub = {
        tabs: {
          query: async () => [{ id: 1, url: 'https://mp.weixin.qq.com/' }],
          get: async () => ({ status: 'complete' }),
        },
        scripting: {
          executeScript: async ({ func, args }) => [{
            result: await window.__execInPage({ src: func.toString(), args }),
          }],
        },
      };
      if (flag) {
        chromeStub.storage = {
          local: {
            get: async key => (store.has(key) ? { [key]: store.get(key) } : {}),
            set: async obj => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
          },
        };
      }
      Object.defineProperty(window, 'chrome', { configurable: true, value: chromeStub });
    }, withStorage);
    popup.on('pageerror', error => console.log('[popup pageerror]', error.message));
    popup.on('console', message => {
      if (message.type() === 'error') console.log('[popup console]', message.text());
    });
    await popup.goto(`file://${path.join(EXT, 'popup.html')}`);
    return { target, popup };
  }

  async function clickAndWait(pair, button, label) {
    const { target, popup } = pair;
    await popup.fill('#audit-description', '弹窗集成测试版本描述');
    // 次要按钮已收进折叠区：先真实点开「其他操作」，再点目标按钮。
    const needExpand = await popup.evaluate(selector => {
      const el = document.querySelector(selector);
      const more = el && el.closest('details');
      return !!more && !more.open;
    }, button);
    if (needExpand) await popup.click('#more summary');
    await popup.click(button);
    // 状态条应给出「已启动」而非错误；随后页面应自动走到 done。
    try {
      await target.waitForFunction(() => window.__stage === 'done', null, { timeout: 12000 });
    } catch (error) {
      const text = await popup.textContent('#status');
      const stage = await target.evaluate(() => window.__stage);
      throw new Error(`${label} 未完成：popup 状态="${text}"，页面阶段=${stage}；${error.message}`);
    }
    const statusText = await popup.textContent('#status');
    assert.ok(!/Cannot read|undefined|无法|错误/.test(statusText),
      `${label} 弹窗报错：${statusText}`);
    console.log(`${label} 通过：${statusText.trim().slice(0, 60)}`);
  }

  // 场景 0：主界面默认只保留「持续自动提审」+「停止」，其余收进折叠区
  {
    const pair = await makePair(false);
    const layout = await pair.popup.evaluate(() => {
      const more = document.querySelector('#more');
      // <details> 收起时子元素仍有 getClientRects()，必须用 checkVisibility()。
      const visible = el => el.checkVisibility();
      const status = document.getElementById('status');
      const idsOf = root => [...root.querySelectorAll('button')].filter(visible).map(b => b.id);
      return {
        hasDetails: !!more,
        openByDefault: more ? more.open : null,
        auditButtons: idsOf(document.getElementById('audit-main')),
        uploadButtons: idsOf(document.getElementById('upload-card')),
        visible: [...document.querySelectorAll('button')].filter(visible).map(b => b.id),
        inside: more ? [...more.querySelectorAll('button')].map(b => b.id) : [],
        trialInsideDetails: document.getElementById('trial-card').closest('details') === more,
        uploadBeforeDetails: !!document.getElementById('upload-card') && !!more &&
          !!(document.getElementById('upload-card').compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING),
        uploadDisabled: document.getElementById('upload-start').disabled,
        statusBeforeDetails: !!status && !!more &&
          !!(status.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert.equal(layout.hasDetails, true, '应有可折叠的「其他操作」容器');
    assert.equal(layout.openByDefault, false, '折叠区默认应收起');
    assert.equal(layout.statusBeforeDetails, true, '状态栏必须在折叠区之前，展开时仍能看到进度');
    assert.deepEqual(layout.auditButtons.sort(), ['audit-auto-batch', 'audit-auto-stop'],
      '提审主区默认只应有 2 个按钮');
    assert.deepEqual(layout.uploadButtons.sort(), ['upload-refresh', 'upload-start'],
      '本地上传卡片默认应有「刷新识别」和「上传选中的项目（CLI）」两个按钮');
    assert.equal(layout.visible.length, 4, '默认可见按钮共 4 个（提审 2 + 本地上传 2）');
    assert.equal(layout.trialInsideDetails, true, '网页端设为体验版应移入折叠区');
    assert.equal(layout.uploadBeforeDetails, true, '本地上传卡片应在折叠区之外，默认可用');
    assert.equal(layout.uploadDisabled, true, '未识别项目时上传按钮必须禁用');
    for (const id of ['auto', 'audit', 'audit-next', 'audit-fill', 'audit-auto',
                      'audit-force', 'locate', 'open-action', 'trial-refresh', 'trial-upload']) {
      assert.ok(layout.inside.includes(id), `${id} 应收进折叠区`);
    }
    await pair.popup.click('#more summary');
    const opened = await pair.popup.evaluate(() => ({
      open: document.querySelector('#more').open,
      allVisible: [...document.querySelectorAll('#more button')]
        .every(b => b.checkVisibility()),
    }));
    assert.equal(opened.open, true, '点标题后应展开');
    assert.equal(opened.allVisible, true, '展开后所有次要按钮应可见');
    console.log(`布局通过：默认 ${layout.visible.length} 个按钮可见（提审 2 + 本地上传 2），折叠区收纳 ${layout.inside.length} 个`);
    await pair.popup.close(); await pair.target.close();
  }

  // 场景 1：页面已停在审核须知，点「强制继续当前步骤」
  {
    const pair = await makePair(false);
    await clickAndWait(pair, '#audit-force', '无 storage 权限 + 强制继续');
    await pair.popup.close(); await pair.target.close();
  }
  // 场景 2：有 storage 权限，点「一键自动提交审核」（从版本管理页进入）
  {
    const pair = await makePair(true);
    await pair.target.goto('https://mp.weixin.qq.com/?list=1');
    await clickAndWait(pair, '#audit-auto', '有 storage 权限 + 一键自动提交');
    await pair.popup.close(); await pair.target.close();
  }
  // 场景 3：无 storage 权限，点「持续自动提审」
  {
    const pair = await makePair(false);
    await pair.target.goto('https://mp.weixin.qq.com/?list=1');
    await clickAndWait(pair, '#audit-auto-batch', '无 storage 权限 + 持续自动提审');
    await pair.popup.close(); await pair.target.close();
  }
  // 场景 4：页面已卡在审核须知（没有版本入口），点「一键自动提交审核」应直接接管
  {
    const pair = await makePair(false);
    await clickAndWait(pair, '#audit-auto', '无 storage 权限 + 卡在须知时一键自动提交');
    await pair.popup.close(); await pair.target.close();
  }

  // 场景 5：体验版 —— 刷新识别小程序/版本，选中后上传并自动确认弹窗
  {
    const pair = await makePair(true);
    await pair.target.goto('https://mp.weixin.qq.com/?trial=1');
    await pair.popup.click('#more summary'); // 网页端体验版已收进折叠区
    await pair.popup.click('#trial-refresh');
    await pair.popup.waitForFunction(() =>
      /识别到 2 个入口/.test(document.querySelector('#trial-info').textContent), null, { timeout: 8000 });
    const info = await pair.popup.textContent('#trial-info');
    assert.match(info, /示例俱乐部/, '应识别到小程序名称');
    assert.equal(await pair.popup.locator('#trial-list input[name="trial-entry"]').count(), 2,
      '应列出 2 个开发版本');
    const labels5 = await pair.popup.locator('#trial-list label').allTextContents();
    for (const label of labels5) {
      const version = /\d{6}\.\d{4}/.exec(label)?.[0];
      assert.ok(version, `版本项应显示版本号：${label}`);
      assert.equal(label.split(version).length - 1, 1, `版本号不应重复：${label}`);
      assert.ok(!label.includes('设为体验版'), `不应重复按钮文案：${label}`);
    }
    assert.equal(await pair.popup.isDisabled('#trial-upload'), false, '识别后上传按钮应可用');
    await pair.popup.click('#trial-upload');
    await pair.target.waitForFunction(() => window.__stage === 'trial-done', null, { timeout: 12000 });
    assert.equal(await pair.target.evaluate(() => window.__trialClicks), 1, '只应点击一次体验版入口');
    await pair.popup.waitForFunction(() =>
      /已设为体验版/.test(document.querySelector('#trial-info').textContent), null, { timeout: 8000 });
    assert.match(await pair.popup.textContent('#trial-info'), /已设为体验版/, '应回报成功');
    console.log('体验版流程通过：刷新识别 → 列出小程序/版本 → 上传 → 自动确认');
    await pair.popup.close(); await pair.target.close();
  }

  // 场景 6：扫描后页面入口数量变化，上传必须拒绝且不能误点
  {
    const pair = await makePair(true);
    await pair.target.goto('https://mp.weixin.qq.com/?trial=1');
    await pair.popup.click('#more summary'); // 网页端体验版已收进折叠区
    await pair.popup.click('#trial-refresh');
    await pair.popup.waitForFunction(() =>
      /识别到 2 个入口/.test(document.querySelector('#trial-info').textContent), null, { timeout: 8000 });
    await pair.target.evaluate(() => {
      const cards = document.querySelectorAll('.version-card');
      if (cards[1]) cards[1].remove();
    });
    await pair.popup.click('#trial-upload');
    await pair.popup.waitForFunction(() =>
      /失败：|已点击|已设为|请重新点/.test(document.querySelector('#trial-info').textContent), null, { timeout: 8000 });
    assert.match(await pair.popup.textContent('#trial-info'), /重新点「刷新识别」/,
      '入口变化时应拒绝上传');
    assert.equal(await pair.target.evaluate(() => window.__trialClicks), 0,
      '入口变化时不能误点任何版本');
    console.log('体验版快照校验通过：页面变化后拒绝误点');
    await pair.popup.close(); await pair.target.close();
  }

  // 场景 7：停在公众平台首页时，刷新识别应自动进入版本管理页再识别
  {
    const pair = await makePair(true);
    await pair.target.goto('https://mp.weixin.qq.com/?home=1');
    await pair.popup.click('#more summary');
    await pair.popup.click('#trial-refresh');
    await pair.popup.waitForFunction(() =>
      /识别到 2 个入口/.test(document.querySelector('#trial-info').textContent), null, { timeout: 15000 });
    assert.equal(await pair.target.evaluate(() => window.__stage), 'trial',
      '应自动导航到版本管理页');
    assert.match(await pair.popup.textContent('#trial-info'), /示例俱乐部/,
      '导航后仍需识别到小程序名称');
    console.log('首页自动导航识别通过');
    await pair.popup.close(); await pair.target.close();
  }

  console.log('弹窗层集成测试全部通过');
})().catch(error => {
  console.error('弹窗层集成测试失败：', error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close().catch(() => {});
});
