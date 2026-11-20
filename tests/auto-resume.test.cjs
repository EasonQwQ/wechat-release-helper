// 跨页面自动恢复 / 持续自动提审的回归测试（只用 Node 内置模块）。
// 运行：node wechat-release-helper/tests/auto-resume.test.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const DIR = path.join(__dirname, '..');
const CORE_SRC = fs.readFileSync(path.join(DIR, 'page-core.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(DIR, 'content.js'), 'utf8');

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

function button(text, dialog) {
  const el = new El({ text, closest: dialog });
  el._interactive = true;
  if (dialog) dialog.children.push(el);
  return el;
}

function noticeParts(options = {}) {
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
  const rule = new El({ text: options.ruleText || '已阅读并了解平台审核规则', closest: dialog });
  rule.control = checkbox;
  dialog._rules = [rule];
  return {
    dialog, next, checkbox, rule,
    scene: {
      text: '提交审核的相关须知\n已阅读并了解平台审核规则\n下一步',
      controls: [next], dialogs: [dialog], rules: [rule], textareas: [],
    },
  };
}

// 一个「文档」= 新的 vm 沙箱（globalThis 全新）+ 可复用的 sessionStorage。
// 用来模拟真实的整页导航：JS 上下文销毁，但 sessionStorage 保留。
function makeDoc(options = {}) {
  const store = options.store || new Map();
  const scene = Object.assign(
    { text: '', controls: [], dialogs: [], rules: [], textareas: [] },
    options.scene || {},
  );
  const timers = new Map();
  let seq = 0;
  const document = {
    body: { get innerText() { return scene.text; } },
    querySelectorAll(sel) {
      if (sel === INTERACTIVE) return scene.controls;
      if (sel === DIALOGS) return scene.dialogs;
      if (sel.includes('checkbox') || sel.includes('label')) return scene.rules;
      if (sel === 'textarea') return scene.textareas;
      return [];
    },
    querySelector() {
      return { addEventListener() {}, disabled: false, value: '', textContent: '' };
    },
  };
  const sandbox = {
    document,
    location: {
      origin: 'https://mp.weixin.qq.com',
      href: options.href || 'https://mp.weixin.qq.com/wxopen/version',
    },
    getComputedStyle: () => ({ visibility: 'visible', pointerEvents: 'auto' }),
    HTMLTextAreaElement,
    Event: class MockEvent {
      constructor(type, opts) { this.type = type; this.bubbles = opts?.bubbles; }
    },
    sessionStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    setInterval: (cb, ms) => { const id = ++seq; timers.set(id, { cb, ms }); return id; },
    clearInterval: id => timers.delete(id),
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({ wrhGlobalAuto: options.globalMode || { enabled: false } }) } },
    },
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(CORE_SRC, sandbox);
  vm.runInContext(CONTENT_SRC, sandbox);
  return {
    sandbox, store, scene, timers,
    locate: (...args) => sandbox.locateOnPage(...args),
    tick: (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        for (const entry of [...timers.values()]) entry.cb();
      }
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const readState = doc => JSON.parse(doc.store.get('__wechatReleaseAutoAuditState') || 'null');

(async () => {
  // 用例 1：整页导航后 content.js 自动恢复 watcher，且不重复点击已做过的动作
  {
    const parts = noticeParts({ ruleText: '我已阅读并了解《微信小程序平台审核规则》并同意' });
    const store = new Map();
    const doc1 = makeDoc({ store, scene: parts.scene, href: 'https://mp.weixin.qq.com/a' });
    assert.equal(doc1.locate('修复登录', [], 'audit-auto').found, true);
    doc1.tick(2);
    assert.equal(parts.checkbox.clicks, 1, '第一页应勾选一次');
    assert.equal(parts.next.clicks, 1, '第一页应点击「下一步」一次');

    // 模拟整页导航：同一个 sessionStorage、全新 JS 上下文、新的 URL。
    // 页面仍停在审核须知（最容易重复点击的场景）。
    const doc2 = makeDoc({ store, scene: parts.scene, href: 'https://mp.weixin.qq.com/b' });
    await settle();
    doc2.tick(3);
    assert.equal(parts.next.clicks, 1, '导航后不能重复点「下一步」');
    // 关键：确认 watcher 真的被自动重启了（否则上面那条「没重复点」会假通过）。
    const secDialog = new El({ text: '代码审核进行安全测试提醒' });
    const cont = button('继续提交', secDialog);
    Object.assign(doc2.scene, {
      text: '代码审核进行安全测试提醒\n继续提交',
      controls: [cont], dialogs: [secDialog], rules: [], textareas: [],
    });
    doc2.tick(2);
    assert.equal(cont.clicks, 1, '导航后 watcher 应已自动恢复并继续下一步');
    assert.equal(readState(doc2)?.state, 'running', '应自动恢复运行态');
    assert.equal(doc2.locate('', [], 'audit-auto-status').armed, true, '应保持启用');
    console.log('用例 1 通过：整页切换自动恢复，动作不重复');
  }

  // 用例 2：恢复后接着走完安全提醒、填描述、最终提交
  {
    const store = new Map();
    const parts = noticeParts();
    const doc1 = makeDoc({ store, scene: parts.scene, href: 'https://mp.weixin.qq.com/a' });
    doc1.locate('新版本修复若干问题', [], 'audit-auto-force');
    doc1.tick(2);

    const secDialog = new El({ text: '代码审核进行安全测试提醒' });
    const cont = button('继续提交', secDialog);
    const form = new El({ text: '你正在提交开发版 版本描述' });
    const field = new El({ value: '', closest: form });
    const submit = button('提交审核', form);
    const decoy = button('提交审核', null);

    const doc2 = makeDoc({ store, href: 'https://mp.weixin.qq.com/b', scene: {
      text: '代码审核进行安全测试提醒\n继续提交',
      controls: [cont], dialogs: [secDialog], rules: [], textareas: [],
    } });
    await settle();
    doc2.tick(2);
    assert.equal(cont.clicks, 1, '恢复后应通过安全测试提醒');

    Object.assign(doc2.scene, {
      text: '你正在提交开发版\n版本描述',
      controls: [decoy, submit], dialogs: [], rules: [], textareas: [field],
    });
    doc2.tick(4);
    assert.equal(field.value, '新版本修复若干问题', '版本描述应自动填入');
    assert.equal(submit.clicks, 1, '最终只提交一次');
    assert.equal(decoy.clicks, 0, '不误点同名入口');

    Object.assign(doc2.scene, { text: '已提交审核', controls: [], dialogs: [], rules: [], textareas: [] });
    doc2.tick();
    assert.equal(readState(doc2)?.state, 'done');
    console.log('用例 2 通过：恢复后完整走完剩余流程');
  }

  // 用例 3：持续模式在新页面自动打开「提交审核」入口，完成后换 URL 自动开始下一轮
  {
    const doc = makeDoc({ href: 'https://mp.weixin.qq.com/app1', scene: {
      text: '版本管理 开发版本', controls: [], dialogs: [], rules: [], textareas: [],
    } });
    const entry1 = button('提交审核', null);
    doc.scene.controls = [entry1];
    assert.equal(doc.locate('自动提交测试', [], 'audit-auto-batch').found, true);
    doc.tick();
    assert.equal(entry1.clicks, 1, '应自动打开提审入口');

    const parts = noticeParts();
    Object.assign(doc.scene, parts.scene);
    doc.tick(3);
    assert.equal(parts.next.clicks, 1, '入口打开后应自动勾选并继续');

    Object.assign(doc.scene, { text: '已提交审核', controls: [], dialogs: [], rules: [], textareas: [] });
    doc.tick();
    assert.equal(readState(doc)?.state, 'done', '应识别已提交审核');

    // 换到另一个小程序页面：同一个 watcher 检测到 URL 变化，自动重开入口。
    const entry2 = button('提交审核', null);
    doc.sandbox.location.href = 'https://mp.weixin.qq.com/app2';
    Object.assign(doc.scene, {
      text: '版本管理 开发版本', controls: [entry2], dialogs: [], rules: [], textareas: [],
    });
    doc.tick();
    assert.equal(entry2.clicks, 1, '换页面后应自动打开下一个提审入口');
    assert.equal(readState(doc)?.state, 'running', '应开始新一轮');
    console.log('用例 3 通过：持续模式自动开入口 + 换页面自动续下一轮');
  }

  // 用例 4：点停止后解除启用，切页面也不会自己重启
  {
    const store = new Map();
    const parts = noticeParts();
    const doc1 = makeDoc({ store, scene: parts.scene, href: 'https://mp.weixin.qq.com/a' });
    doc1.locate('描述', [], 'audit-auto');
    doc1.tick();
    assert.equal(doc1.locate('', [], 'audit-auto-stop').state, 'stopped');
    assert.equal(doc1.locate('', [], 'audit-auto-status').armed, false, '停止后应解除启用');

    const doc2 = makeDoc({ store, scene: parts.scene, href: 'https://mp.weixin.qq.com/b' });
    await settle();
    doc2.tick(2);
    assert.equal(parts.next.clicks, 1, '停止后切页面不得再自动点击');
    assert.equal(readState(doc2)?.state, 'stopped');
    console.log('用例 4 通过：停止后跨页面不再自动恢复');
  }

  // 用例 5：全局持续模式在全新标签页自动接管（chrome.storage.local 生效）
  {
    const doc = makeDoc({
      globalMode: { enabled: true, description: '全局自动' },
      href: 'https://mp.weixin.qq.com/newtab',
      scene: { text: '版本管理 开发版本', controls: [], dialogs: [], rules: [], textareas: [] },
    });
    const entry = button('提交审核', null);
    doc.scene.controls = [entry];
    await settle();
    doc.tick(2);
    assert.equal(entry.clicks, 1, '新标签页应自动打开提审入口');
    assert.equal(doc.locate('', [], 'audit-auto-status').batch, true, '应处于持续模式');
    console.log('用例 5 通过：全局持续模式在新标签页自动接管');
  }

  console.log('跨页面自动恢复测试全部通过');
})().catch(error => {
  console.error('测试失败：', error);
  process.exitCode = 1;
});
