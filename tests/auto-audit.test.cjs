// 一键自动提审状态机的回归测试（只用 Node 内置模块，无第三方依赖）。
// 运行：node wechat-release-helper/tests/auto-audit.test.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const code = fs.readFileSync(path.join(__dirname, '..', 'page-core.js'), 'utf8');

const INTERACTIVE = 'button, a, [role="button"], [role="menuitem"]';
const DIALOGS = '[role="dialog"], .weui-desktop-dialog, dialog, [class*="dialog"]';

class El {
  constructor(props = {}) {
    this.children = [];
    this.clicks = 0;
    this.dispatched = [];
    this._value = props.value || '';
    this._text = props.text || '';
    this._closest = props.closest || null;
    this.disabled = false;
    this.readOnly = false;
    this.disabledMatch = false;
    this._rules = [];
    this.classList = { remove() {} };
    this.style = {};
  }
  get innerText() { return this._text; }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  getClientRects() { return [{}]; }
  matches(sel) { return this.disabledMatch && /disabled/.test(sel); }
  closest() { return this._closest; }
  contains(other) { return this.children.includes(other); }
  querySelectorAll(sel) {
    if (sel === INTERACTIVE) return this.children.filter(child => child._interactive);
    if (sel.includes('checkbox') || sel.includes('label')) return this._rules || [];
    return [];
  }
  querySelector() { return null; }
  getAttribute() { return null; }
  removeAttribute() {}
  setAttribute() {}
  click() { this.clicks += 1; }
  dispatchEvent(event) { this.dispatched.push(event.type); }
}

function HTMLTextAreaElement() {}
Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
  configurable: true,
  get() { return this._value || ''; },
  set(v) { this._value = v; },
});

function createHarness() {
  const scene = { text: '', controls: [], dialogs: [], rules: [], textareas: [] };
  const store = new Map();
  const state = { intervalCb: null, seq: 0, cleared: [] };
  const document = {
    body: { get innerText() { return scene.text; } },
    querySelectorAll(sel) {
      if (sel === INTERACTIVE) return scene.controls;
      if (sel === DIALOGS) return scene.dialogs;
      if (sel === 'label, [role="checkbox"]' || sel.includes('checkbox') || sel.includes('label')) return scene.rules;
      if (sel === 'textarea') return scene.textareas;
      return [];
    },
    querySelector() {
      return { addEventListener() {}, disabled: false, value: '', textContent: '' };
    },
  };
  const sandbox = {
    document,
    location: { origin: 'https://mp.weixin.qq.com', href: 'https://mp.weixin.qq.com/' },
    getComputedStyle: () => ({ visibility: 'visible', pointerEvents: 'auto' }),
    HTMLTextAreaElement,
    Event: class MockEvent {
      constructor(type, options) { this.type = type; this.bubbles = options?.bubbles; }
    },
    sessionStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    setInterval: cb => { state.intervalCb = cb; return ++state.seq; },
    clearInterval: id => {
      state.cleared.push(id);
      if (id === state.seq) state.intervalCb = null;
    },
    URL,
    console,
    window: { confirm: () => true },
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url: 'https://mp.weixin.qq.com/' }],
        get: async () => ({ status: 'complete' }),
      },
      scripting: {
        executeScript: async () => [{ result: { found: false, state: 'idle', message: '尚未开始自动提审。' } }],
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    locate: sandbox.locateOnPage,
    getState: () => sandbox.__wechatReleaseAutoAuditState,
    tick: (times = 3) => {
      for (let i = 0; i < times; i += 1) {
        if (!state.intervalCb) break;
        state.intervalCb();
      }
    },
    cleared: state.cleared,
    scene,
  };
}

function button(text, dialog) {
  const el = new El({ text, closest: dialog });
  el._interactive = true;
  if (dialog) dialog.children.push(el);
  return el;
}

function noticeScene(options = {}) {
  const harness = createHarness();
  const dialog = new El({ text: '提交审核的相关须知 已阅读并了解平台审核规则' });
  const next = button('下一步', dialog);
  if (options.disabledNext) next.disabledMatch = true;
  const checkbox = {
    checked: false, clicks: 0,
    getAttribute: () => null,
    matches: () => false,
    dispatchEvent() {},
    click() { this.clicks += 1; this.checked = true; },
  };
  const rule = new El({
    text: options.ruleText || '已阅读并了解平台审核规则',
    closest: dialog,
  });
  rule.control = checkbox;
  dialog._rules = [rule];
  Object.assign(harness.scene, {
    text: '提交审核的相关须知\n已阅读并了解平台审核规则\n下一步',
    controls: [next], dialogs: [dialog], rules: [rule], textareas: [],
  });
  return { harness, next, checkbox };
}

// 用例 1：完整流程 —— 须知 → 安全提醒 → 填描述 → 最终提交 → 已提交审核
{
  const { harness, next, checkbox } = noticeScene();
  const description = '修复登录并优化成员搜索';
  assert.equal(harness.locate(description, [], 'audit-auto').found, true, 'watcher 应成功启动');

  harness.tick();
  assert.equal(checkbox.clicks, 1, '审核规则只勾选一次');
  assert.equal(next.clicks, 1, '「下一步」只点击一次');

  const securityDialog = new El({ text: '代码审核进行安全测试提醒' });
  const cont = button('继续提交', securityDialog);
  Object.assign(harness.scene, {
    text: '代码审核进行安全测试提醒\n继续提交',
    controls: [cont], dialogs: [securityDialog], rules: [], textareas: [],
  });
  harness.tick();
  assert.equal(cont.clicks, 1, '「继续提交」只点击一次');

  const form = new El({ text: '你正在提交开发版 版本描述' });
  const field = new El({ text: '', value: '', closest: form });
  const submit = button('提交审核', form);
  const decoy = button('提交审核', null); // 背景版本列表里的同名入口
  Object.assign(harness.scene, {
    text: '你正在提交开发版\n版本描述',
    controls: [decoy, submit], dialogs: [], rules: [], textareas: [field],
  });
  harness.tick(4);
  assert.equal(field.value, description, '版本描述应自动填入');
  assert.ok(field.dispatched.includes('input') && field.dispatched.includes('change'),
    '应派发 input/change 让框架感知');
  assert.equal(submit.clicks, 1, '最终「提交审核」只点击一次');
  assert.equal(decoy.clicks, 0, '不应误点版本列表里的同名入口');

  Object.assign(harness.scene, {
    text: '已提交审核', controls: [], dialogs: [], rules: [], textareas: [],
  });
  harness.tick();
  assert.equal(harness.getState().state, 'done', '应识别到已提交审核');
  assert.equal(harness.getState().message, '微信页面显示：已提交审核。');
  assert.ok(harness.cleared.length > 0, '完成后应停止 watcher');
  console.log('用例 1 通过：完整流程，各动作只执行一次，未误点同名入口');
}

// 用例 2：版本描述为空且网页也为空 —— 停止，绝不提交
{
  const { harness, next } = noticeScene();
  harness.locate('', [], 'audit-auto');
  harness.tick();
  assert.equal(next.clicks, 1);

  const form = new El({ text: '你正在提交开发版 版本描述' });
  const field = new El({ text: '', value: '', closest: form });
  const submit = button('提交审核', form);
  Object.assign(harness.scene, {
    text: '你正在提交开发版\n版本描述',
    controls: [submit], dialogs: [], rules: [], textareas: [field],
  });
  harness.tick(3);
  assert.equal(harness.getState().state, 'failed', '描述为空应停止');
  assert.equal(field.value, '', '不应填入任何内容');
  assert.equal(submit.clicks, 0, '描述为空时绝不能提交');
  console.log('用例 2 通过：版本描述为空时安全停止');
}

// 用例 3：页面已有描述 —— 保留原值并继续提交
{
  const { harness } = noticeScene();
  harness.locate('扩展里的描述', [], 'audit-auto');
  harness.tick();
  const form = new El({ text: '你正在提交开发版 版本描述' });
  const field = new El({ text: '', value: '网页原有描述', closest: form });
  const submit = button('提交审核', form);
  Object.assign(harness.scene, {
    text: '你正在提交开发版\n版本描述',
    controls: [submit], dialogs: [], rules: [], textareas: [field],
  });
  harness.tick(3);
  assert.equal(field.value, '网页原有描述', '应保留网页已有描述');
  assert.equal(submit.clicks, 1, '应继续自动提交');
  console.log('用例 3 通过：保留网页已有版本描述');
}

// 用例 4：停止按钮可中止，状态可跨 popup 关闭读取
{
  const { harness, next } = noticeScene();
  harness.locate('描述', [], 'audit-auto');
  harness.tick();
  assert.equal(next.clicks, 1);
  assert.equal(harness.locate('', [], 'audit-auto-stop').state, 'stopped');
  assert.equal(harness.getState().state, 'stopped');
  assert.equal(harness.locate('', [], 'audit-auto-status').state, 'stopped',
    '重新打开 popup 应能读到终态');
  console.log('用例 4 通过：停止与状态读取');
}

// 用例 5：强制继续 —— 文案不再要求精确匹配，按钮置灰也能启用并点击
{
  const { harness, next, checkbox } = noticeScene({
    ruleText: '我已阅读并了解《微信小程序平台审核规则》并同意',
    disabledNext: true,
  });
  const resumed = harness.locate('修复若干问题', [], 'audit-auto-force');
  assert.equal(resumed.found, true, '强制继续应成功接管');
  assert.match(resumed.message, /已自动同意并勾选/);
  harness.tick(2);
  assert.equal(checkbox.clicks, 1, '应自动勾选（放宽文案匹配）');
  assert.equal(next.clicks, 1, '按钮置灰时应被强制启用并点击');
  console.log('用例 5 通过：强制继续可接管卡住的审核须知步骤');
}

// 用例 6：常规一键流程仍给页面约 1 秒自然启用，不立刻强行点击
{
  const { harness, next, checkbox } = noticeScene({ disabledNext: true });
  harness.locate('描述', [], 'audit-auto');
  harness.tick(3);
  assert.equal(checkbox.clicks, 1, '常规流程也会自动勾选');
  assert.equal(next.clicks, 0, '宽限期内不应强行点击置灰按钮');
  console.log('用例 6 通过：常规流程保留约 1 秒宽限期');
}
