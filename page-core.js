// 页面侧核心逻辑（单一事实来源）。
// - popup 通过 chrome.scripting.executeScript({ func: locateOnPage }) 注入本函数；
// - manifest 的 content_scripts 也会加载本文件，供 content.js 在页面切换后自动恢复 watcher。
// ⚠️ locateOnPage 必须保持自包含：不能引用本文件里其他顶层函数/常量，否则序列化注入会失效。
function locateOnPage(version, labels, click) {
  if (location.origin !== 'https://mp.weixin.qq.com') return null;
  const interactive = 'button, a, [role="button"], [role="menuitem"]';
  const visible = element => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible';
  const matchesVersion = text => text.split(/[^a-zA-Z0-9_.-]+/).includes(version);

  // 所有跨页面状态都放 sessionStorage（同标签页导航/刷新不会丢）。
  // globalThis 只作同文档内的快取，页面一换就重新从 sessionStorage 读。
  const AUTO = '__wechatReleaseAutoAudit';
  const STATE = '__wechatReleaseAutoAuditState';
  const DESC = '__wechatReleaseAutoAuditDesc';
  const ARM = '__wechatReleaseAutoAuditArm';
  const ACTIONS = '__wechatReleaseAutoAuditActions';
  const DONEURL = '__wechatReleaseAutoAuditDoneUrl';
  const HEARTBEAT = '__wechatReleaseAutoAuditHeartbeat';
  const TOKEN = '__wechatReleaseAutoAuditPageToken';
  const STOP = '__wechatReleaseAutoAuditStop';
  const LEGACY = '__wechatReleaseAuditWatcher';
  const noticeText = '提交审核的相关须知';
  const securityText = '代码审核进行安全测试提醒';
  const dialogSelector = '[role="dialog"], .weui-desktop-dialog, dialog, [class*="dialog"]';
  const auditLabels = labels.length ? labels : ['提交审核', '提交发布审核', '提交审查'];

  const safeGet = key => { try { return sessionStorage.getItem(key); } catch (error) { return null; } };
  const safeSet = (key, value) => { try { sessionStorage.setItem(key, value); } catch (error) {} };
  const safeDel = key => { try { sessionStorage.removeItem(key); } catch (error) {} };
  const readJSON = (key, fallback) => {
    try { const raw = safeGet(key); return raw ? JSON.parse(raw) : fallback; } catch (error) { return fallback; }
  };
  const pageToken = globalThis[TOKEN] || safeGet(TOKEN) || 'default';
  const setHeartbeat = at => safeSet(HEARTBEAT, `${pageToken}|${at}`);
  const readState = () => readJSON(STATE, null) || globalThis[STATE] || null;
  const writeState = (state, message) => {
    const value = { state, message, at: Date.now() };
    globalThis[STATE] = value;
    safeSet(STATE, JSON.stringify(value));
    return value;
  };
  const readDesc = () => globalThis[DESC] || safeGet(DESC) || '';
  const writeDesc = value => { globalThis[DESC] = value; safeSet(DESC, value); };
  const readArm = () => readJSON(ARM, null);
  const writeArm = arm => { globalThis[ARM] = arm; safeSet(ARM, JSON.stringify(arm)); };
  const clearArm = () => { delete globalThis[ARM]; safeDel(ARM); };
  const readActions = () => new Set(readJSON(ACTIONS, []));
  const writeActions = set => safeSet(ACTIONS, JSON.stringify([...set]));
  const stopAll = () => {
    for (const name of [AUTO, LEGACY]) {
      if (globalThis[name]) clearInterval(globalThis[name]);
      delete globalThis[name];
    }
    setHeartbeat(0);
  };

  const autoSteps = [
    'audit-auto', 'audit-auto-force', 'audit-auto-batch', 'audit-auto-status',
    'audit-auto-stop', 'audit-auto-resume', 'audit-auto-disarm', 'audit-auto-arm-batch',
    'audit-auto-context',
  ];

  if (autoSteps.includes(click)) {
    const isChecked = element => element.checked === true ||
      element.getAttribute('aria-checked') === 'true' ||
      /checked|active|selected/.test(String(element.className || '')) ||
      /checked|active|selected/.test(String(element.closest?.('label')?.className || ''));
    // 放宽：不再要求文案精确等于「已阅读并了解平台审核规则」。
    const findRuleTargets = () => {
      const dialogs = [...document.querySelectorAll(dialogSelector)].filter(dialog =>
        visible(dialog) && dialog.innerText.includes(noticeText));
      const scopes = dialogs.length ? dialogs : [document];
      const targets = new Set();
      for (const scope of scopes) {
        const controls = [...scope.querySelectorAll('input[type="checkbox"], [role="checkbox"], label')]
          .filter(visible);
        for (const element of controls) {
          const text = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`.trim();
          if (controls.length > 1 && !/阅读|同意|规则|须知|了解|协议/.test(text)) continue;
          const target = element.control ||
            element.querySelector('input[type="checkbox"]') || element;
          targets.add(target);
        }
      }
      return [...targets];
    };
    const clickRule = element => {
      element.click();
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const labelOf = text => (text || '').replace(/\s+/g, '');
    const clickable = button => visible(button) &&
      !button.matches(':disabled, [aria-disabled="true"], .weui-desktop-btn_disabled') &&
      getComputedStyle(button).pointerEvents !== 'none';
    const findStepButton = (label, allowDisabled = false) => {
      const all = [...document.querySelectorAll(interactive)].filter(button =>
        visible(button) && labelOf(button.innerText) === label &&
        (allowDisabled || clickable(button)));
      if (!all.length) return null;
      const inDialog = all.filter(button =>
        [...document.querySelectorAll(dialogSelector)].some(dialog =>
          visible(dialog) && dialog.contains(button)));
      const matches = inDialog.length ? inDialog : all;
      return matches.length === 1 ? matches[0] : null;
    };
    // 已明确同意：勾选完成后按钮若仍被前端置灰，去掉禁用态再点击。
    const forceClick = button => {
      if (button.disabled) button.removeAttribute('disabled');
      if (button.getAttribute('aria-disabled') === 'true') button.setAttribute('aria-disabled', 'false');
      if (button.classList) button.classList.remove('weui-desktop-btn_disabled');
      if (getComputedStyle(button).pointerEvents === 'none') button.style.pointerEvents = 'auto';
      button.click();
    };

    const startWatcher = (force, initialMessage, options = {}) => {
      const { batch = false, fresh = false } = options;
      stopAll();
      safeDel(STOP);
      if (fresh) {
        delete globalThis[STATE];
        safeDel(STATE);
        delete globalThis[ACTIONS];
        safeDel(ACTIONS);
        safeDel(DONEURL);
      }
      const description = readDesc();
      const doneActions = fresh ? new Set() : readActions();
      const remember = action => { doneActions.add(action); writeActions(doneActions); };
      let checkAttempts = 0;
      let readyTicks = 0;
      let lastReport = '';
      let doneUrlFor = batch ? safeGet(DONEURL) : '';
      const report = (state, message) => {
        const key = `${state}|${message}`;
        if (key !== lastReport) {
          lastReport = key;
          writeState(state, message);
        }
        if (state === 'done') safeSet(DONEURL, location.href);
        if (!batch && ['done', 'failed', 'timeout', 'stopped'].includes(state)) clearArm();
      };
      const deadline = Date.now() + 180000;
      setHeartbeat(Date.now());
      report('running', initialMessage || '自动提审已启动，正在处理审核须知…');
      globalThis[AUTO] = setInterval(() => {
        setHeartbeat(Date.now());
        // 全局停止标记：即使 watcher 跑在另一个世界也能被中止。
        if (safeGet(STOP) === '1') {
          report('stopped', '已停止自动提审，网页保持当前状态，请人工核对。');
          stopAll();
          return;
        }
        const page = document.body.innerText;

        // 持续模式：URL 变了就当作「切到另一个页面」，清掉上一次的动作记录重来。
        if (batch && doneUrlFor && location.href !== doneUrlFor) {
          doneUrlFor = '';
          safeDel(DONEURL);
          safeDel(ACTIONS);
          doneActions.clear();
          checkAttempts = 0;
          readyTicks = 0;
          lastReport = '';
          report('running', '检测到新页面，自动开始下一次提审…');
        }
        if (page.split('\n').some(line => line.trim() === '已提交审核') ||
            (doneActions.has('form.submit') && page.includes('已提交审核'))) {
          report('done', '微信页面显示：已提交审核。');
          if (!batch) { stopAll(); return; }
          doneUrlFor = location.href;
          return;
        }
        if (batch && doneUrlFor === location.href) {
          report('done', '已提交审核；切换到下一个小程序页面将自动继续。');
          return;
        }
        if (!batch && Date.now() >= deadline) {
          report('timeout', '自动提审等待超时，请在网页核对当前步骤。');
          stopAll();
          return;
        }
        if (page.includes(securityText)) {
          report('running', '正在通过代码安全测试提醒…');
          if (!doneActions.has('security')) {
            const next = findStepButton('继续提交') ||
              (force ? findStepButton('继续提交', true) : null);
            if (next) {
              remember('security');
              if (clickable(next)) next.click(); else forceClick(next);
            } else {
              report('waiting', '未找到唯一的「继续提交」按钮，请查看网页。');
            }
          }
          return;
        }
        if (page.includes(noticeText)) {
          // 每 tick 校验勾选是否真的生效，未生效就重试（最多 8 次）。
          const unchecked = findRuleTargets().filter(target => !isChecked(target));
          if (unchecked.length && checkAttempts < 8) {
            checkAttempts += 1;
            for (const target of unchecked) clickRule(target);
            report('running', '已自动勾选审核规则，正在等待「下一步」启用…');
          } else if (unchecked.length && !force) {
            report('waiting', '审核规则勾选框未生效，请点「强制继续当前步骤」或人工勾选。');
            return;
          }
          if (!unchecked.length) {
            remember('notice.check');
            readyTicks += 1;
          }
          // 常规模式先给页面框架约 1 秒自然启用；强制模式立即推进。
          const canForce = force || readyTicks >= 4;
          let next = findStepButton('下一步');
          if (!next && canForce) next = findStepButton('下一步', true);
          if (next && !doneActions.has('notice.next')) {
            remember('notice.next');
            if (clickable(next)) next.click(); else forceClick(next);
            report('running', '已点击「下一步」，正在等待安全测试提醒…');
            return;
          }
          report('running', '正在自动勾选审核规则并等待「下一步」启用…');
          return;
        }
        if (page.includes('你正在提交开发版') && page.includes('版本描述')) {
          const fields = [...document.querySelectorAll('textarea')].filter(field =>
            visible(field) && !field.disabled && !field.readOnly);
          if (fields.length !== 1) {
            report('waiting', '无法唯一定位版本描述输入框，请人工核对。');
            return;
          }
          const [field] = fields;
          if (!field.value.trim()) {
            if (!description) {
              report('failed', '版本描述为空：请在扩展填写版本描述后重试，或在网页手动填写。');
              stopAll();
              return;
            }
            if (!doneActions.has('form.fill')) {
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, description);
              field.dispatchEvent(new Event('input', { bubbles: true }));
              field.dispatchEvent(new Event('change', { bubbles: true }));
              remember('form.fill');
              report('running', '已填写版本描述，正在核对提交按钮…');
              return;
            }
            report('waiting', '版本描述仍未生效，请在网页手动填写。');
            return;
          }
          remember('form.fill');
          // 限定在含输入框的表单容器内，避免误点版本列表里的同名入口。
          const scope = field.closest('[role="dialog"], .weui-desktop-dialog, form, .weui-desktop-panel, [class*="dialog"], [class*="panel"]') || document;
          const inScope = [...scope.querySelectorAll(interactive)].filter(button =>
            clickable(button) && labelOf(button.innerText) === '提交审核');
          const candidates = inScope.length
            ? inScope
            : [...document.querySelectorAll(interactive)].filter(button =>
                clickable(button) && labelOf(button.innerText) === '提交审核');
          if (candidates.length !== 1) {
            report('waiting', '未找到唯一可用的「提交审核」按钮，请人工核对表单。');
            return;
          }
          if (!doneActions.has('form.submit')) {
            remember('form.submit');
            candidates[0].click();
            report('running', '已点击最终「提交审核」，正在等待微信确认…');
          }
          return;
        }
        // 持续模式：停在版本管理页时，自动打开「提交审核」入口（复用通用定位）。
        if (batch && !doneActions.has('batch.open')) {
          const opened = locateOnPage('', auditLabels, 'batch-open');
          if (opened?.found) {
            remember('batch.open');
            report('running', '已在新页面自动打开「提交审核」入口…');
            return;
          }
        }
        report('running', batch ? '正在等待提审入口或页面加载…' : '正在等待提审页面加载…');
      }, 250);
      return { found: true, state: 'running' };
    };

    // 弹窗用来判断「当前是否已经处在提审流程里」：若在，就不必再找版本入口。
    if (click === 'audit-auto-context') {
      const page = document.body.innerText;
      return { found: page.includes(noticeText) || page.includes(securityText) ||
        (page.includes('你正在提交开发版') && page.includes('版本描述')) };
    }
    if (click === 'audit-auto-status') {
      const value = readState();
      const arm = readArm();
      return value
        ? { found: true, state: value.state, message: value.message, at: value.at,
            armed: !!arm, batch: arm?.batch === true }
        : { found: false, state: 'idle', message: '尚未开始自动提审。', armed: !!arm, batch: arm?.batch === true };
    }
    if (click === 'audit-auto-stop' || click === 'audit-auto-disarm') {
      safeSet(STOP, '1');
      stopAll();
      clearArm();
      if (click === 'audit-auto-disarm') return { found: true, disarmed: true };
      const value = writeState('stopped', '已停止自动提审，网页保持当前状态，请人工核对。');
      return { found: true, state: value.state, message: value.message };
    }
    if (click === 'audit-auto-arm-batch') {
      const supplied = (version || '').trim();
      if (supplied) writeDesc(supplied);
      writeArm({ mode: 'batch', force: true, batch: true, startedAt: Date.now() });
      return { found: true, armed: true };
    }
    if (click === 'audit-auto-resume') {
      const arm = readArm();
      if (!arm) return { found: false, state: 'idle', message: '未启用自动提审。' };
      const [beatToken, beatAt] = String(safeGet(HEARTBEAT) || '').split('|');
      if (globalThis[AUTO] || (beatToken === pageToken && Date.now() - Number(beatAt) < 1500)) {
        return { found: true, state: 'running', message: '自动提审正在运行。' };
      }
      startWatcher(!!arm.force, '页面已切换，自动提审已自动恢复…', { batch: !!arm.batch, fresh: false });
      return { found: true, state: 'running', message: '页面已切换，自动提审已自动恢复。' };
    }

    if (click === 'audit-auto-force') {
      const supplied = (version || '').trim();
      if (supplied) writeDesc(supplied);
      writeArm({ mode: 'once', force: true, batch: false, startedAt: Date.now() });
      const targets = findRuleTargets();
      for (const target of targets) if (!isChecked(target)) clickRule(target);
      const message = targets.length
        ? `已自动同意并勾选 ${targets.length} 项审核规则，正在继续提审流程…`
        : '未找到审核规则勾选框，已按强制模式继续当前步骤…';
      startWatcher(true, message, { batch: false, fresh: true });
      return { found: true, state: 'running', message };
    }
    if (click === 'audit-auto-batch') {
      writeDesc((version || '').trim());
      writeArm({ mode: 'batch', force: true, batch: true, startedAt: Date.now() });
      startWatcher(true, '持续自动提审已启动：切换页面会自动继续…', { batch: true, fresh: true });
      return { found: true, state: 'running', message: '持续自动提审已启动，切换页面无需再点扩展。' };
    }

    writeDesc((version || '').trim());
    writeArm({ mode: 'once', force: false, batch: false, startedAt: Date.now() });
    startWatcher(false, undefined, { batch: false, fresh: true });
    return { found: true, state: 'running', message: '自动提审已启动。' };
  }

  // 体验版：刷新识别当前页面的小程序名称与所有「设为体验版」入口。
  // 用入口在 DOM 中的序号定位，不依赖版本号文本解析，页面结构变化也不会错位。
  const trialLabels = ['设为体验版', '选为体验版', '设置为体验版', '设成体验版',
    '上传体验版', '提交体验版', '发布体验版', '设为体验版本'];
  const trialText = element => (element.innerText || element.getAttribute('aria-label') || '').trim();
  const trialControls = () => {
    const all = [...document.querySelectorAll(interactive)]
      .filter(element => visible(element) && trialLabels.includes(trialText(element)));
    // 同一入口可能被嵌套的可点击元素包裹，只保留最内层那个。
    return all.filter(control => !all.some(other =>
      other !== control && control.contains(other)));
  };
  if (click === 'trial-scan') {
    const controls = trialControls();
    const entries = controls.map((control, index) => {
      const record = control.closest('tr, [role="row"], li, article, .weui-desktop-panel, [class*="card"], [class*="item"]') ||
        control.parentElement;
      const text = String(record?.innerText || '').replace(/\s+/g, ' ').trim();
      const matched = text.match(/\d{6}[.\-]\d{3,4}|\d+\.\d+\.\d+|v?\d+\.\d+/);
      return {
        index,
        label: trialText(control),
        version: matched ? matched[0] : '',
        text: text.slice(0, 80),
        disabled: control.matches(':disabled, [aria-disabled="true"], .weui-desktop-btn_disabled'),
      };
    });
    // 小程序名称：后台 DOM 版本差异大，按常见账号位逐个尝试，全部列出去重。
    const nameSelectors = [
      '.weui-desktop-account__name', '.weui-desktop-account-name',
      '[class*="app-name"]', '[class*="appName"]', '[class*="nickname"]',
      '[class*="account-name"]', '[class*="accountName"]',
      '[class*="mini-program-name"]', '[class*="mp-name"]',
      '.weui-desktop-layout__header__title', 'header [class*="name"]',
    ];
    const names = new Set();
    for (const selector of nameSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const text = String(element.innerText || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 40 && !/微信公众平台|版本管理|首页/.test(text)) names.add(text);
      }
    }
    const title = String(document.title || '').replace(/\s*[-–—|]\s*微信公众平台.*$/, '').trim();
    if (title && title.length <= 40 && !/微信公众平台|版本管理|首页/.test(title)) names.add(title);
    const accounts = [...names];
    return {
      found: true,
      appName: accounts[0] || '',
      accounts,
      entries,
      url: location.href,
      message: entries.length
        ? `识别到 ${entries.length} 个体验版入口${accounts.length ? `，小程序：${accounts.join('、')}` : ''}。`
        : '当前页面没有「设为体验版」入口，请切到版本管理页后点「刷新识别」。',
    };
  }
  if (click === 'trial-upload') {
    // version 参数承载扫描快照：{ index, count, label }，用于防止页面变化后误点。
    let picked = { index: 0, count: -1, label: '' };
    try { picked = { ...picked, ...JSON.parse(version || '{}') }; } catch (error) {}
    const controls = trialControls();
    if (!controls.length) return { found: false, message: '页面上没有体验版入口，请先点「刷新识别」。' };
    if (picked.count >= 0 && controls.length !== picked.count) {
      return { found: false, message: '页面入口数量已变化，请重新点「刷新识别」后再上传。' };
    }
    const target = controls[picked.index];
    if (!target) return { found: false, message: '体验版入口已变化，请重新点「刷新识别」。' };
    if (picked.label && trialText(target) !== picked.label) {
      return { found: false, message: '体验版入口文案已变化，请重新点「刷新识别」。' };
    }
    if (target.matches(':disabled, [aria-disabled="true"], .weui-desktop-btn_disabled')) {
      return { found: false, message: '该体验版入口当前不可用（可能已是体验版），请在网页核对。' };
    }
    target.click();
    return { found: true, message: `已点击「${trialText(target)}」，正在确认…` };
  }

  // 体验版结果：确认微信页面已显示设置成功（或该版本已标记为体验版）。
  if (click === 'trial-check') {
    // 只认明确的成功提示：版本列表里本来就可能有「当前体验版」字样，不能当成功。
    const page = document.body.innerText;
    const done = /已设为体验版|已选为体验版|已成功设为体验版|设置成功|体验版已更新/.test(page);
    return { found: done, message: done ? '微信页面显示：已设为体验版。' : '' };
  }

  // 持续模式内部调用：确认当前不在任何提审弹窗/表单里，然后走通用版本定位并点击入口。
  // 不 return 时会自然落到函数尾部的通用定位逻辑，click 为真即点击。
  if (click === 'batch-open') {
    const page = document.body.innerText;
    if (page.includes(noticeText) || page.includes(securityText) ||
        page.includes('你正在提交开发版') || page.includes('已提交审核')) {
      return { found: false };
    }
  }

  if (click === 'audit-watch') {
    const findButton = (heading, label) => {
      const matches = [...document.querySelectorAll(interactive)].filter(button =>
        visible(button) && button.innerText.trim() === label &&
        !button.matches(':disabled, [aria-disabled="true"], .weui-desktop-btn_disabled') &&
        getComputedStyle(button).pointerEvents !== 'none' &&
        [...document.querySelectorAll(dialogSelector)].some(dialog =>
          dialog.contains(button) && visible(dialog) && dialog.innerText.includes(heading)));
      return matches.length === 1 ? matches[0] : null;
    };
    const notice = '提交审核的相关须知';
    if (!document.body.innerText.includes(notice)) return null;
    const key = '__wechatReleaseAuditWatcher';
    if (globalThis[key]) clearInterval(globalThis[key]);
    let stage = 'notice';
    let checkedByHelper = false;
    const deadline = Date.now() + 120000;
    const stop = () => {
      clearInterval(globalThis[key]);
      delete globalThis[key];
    };
    globalThis[key] = setInterval(() => {
      const page = document.body.innerText;
      if (Date.now() >= deadline || page.includes('你正在提交开发版')) {
        stop();
        return;
      }
      if (stage === 'notice') {
        if (!page.includes(notice)) { stop(); return; }
        const next = findButton(notice, '下一步');
        if (!next) {
          if (checkedByHelper) return;
          const rules = [...document.querySelectorAll('label, [role="checkbox"]')].filter(control =>
            visible(control) && control.innerText.trim() === '已阅读并了解平台审核规则' &&
            control.closest(dialogSelector)?.innerText.includes(notice));
          const targets = new Set(rules.map(rule => rule.control || rule.querySelector('input[type="checkbox"]') || rule));
          if (targets.size !== 1) return;
          const [target] = targets;
          if (target.checked || target.getAttribute('aria-checked') === 'true' ||
              target.matches(':disabled, [aria-disabled="true"]')) return;
          checkedByHelper = true;
          target.click();
          return;
        }
        stage = 'security';
        next.click();
      } else {
        const next = findButton('代码审核进行安全测试提醒', '继续提交');
        if (!next) return;
        stop();
        next.click();
      }
    }, 250);
    return { found: true };
  }
  if (['audit-inspect', 'audit-advance', 'audit-fill'].includes(click)) {
    const page = document.body.innerText;
    const controls = [...document.querySelectorAll(interactive)].filter(visible);
    const description = [...document.querySelectorAll('textarea')].filter(visible);
    let label;
    let anchor;
    if (page.includes('代码审核进行安全测试提醒')) {
      label = '继续提交';
      anchor = '代码审核进行安全测试提醒';
    } else if (page.includes('提交审核的相关须知')) {
      label = '下一步';
      anchor = '提交审核的相关须知';
    } else if (page.includes('你正在提交开发版') && page.includes('版本描述')) {
      if (description.length !== 1) return { message: '无法唯一定位版本描述。' };
      const [field] = description;
      if (click === 'audit-fill') {
        if (field.value.trim()) return { message: '页面已有版本描述，已保留。' };
        if (field.disabled || field.readOnly) return { message: '版本描述不可编辑。' };
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, version);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return { message: '已填写版本描述，请核对表单。' };
      }
      if (!field.value.trim()) return { message: '请先填写版本描述。' };
      label = '提交审核';
    } else if (page.split('\n').some(line => line.trim() === '已提交审核')) {
      return { message: '微信页面显示：已提交审核。' };
    }
    if (!label || click === 'audit-fill') return { message: '未识别到对应的提审步骤。' };
    const candidates = controls.filter(button => {
      if (button.innerText.trim() !== label ||
          button.matches(':disabled, [aria-disabled="true"], .weui-desktop-btn_disabled')) return false;
      if (!anchor) return true;
      const dialog = button.closest('[role="dialog"], .weui-desktop-dialog, dialog, [class*="dialog"]');
      return dialog?.innerText.includes(anchor) ||
        (label === '下一步' && page.includes('已阅读并了解平台审核规则'));
    });
    if (candidates.length !== 1) {
      return { message: label === '下一步'
        ? '请在网页阅读并手动勾选审核规则，确保「下一步」已启用。'
        : '未找到唯一可用按钮，请检查网页。' };
    }
    if (click === 'audit-advance' && version !== label) return { message: '网页步骤已变化，请重新识别。' };
    if (click === 'audit-advance') candidates[0].click();
    return { label, message: click === 'audit-advance'
      ? '已点击「' + label + '」，请等待页面更新后再次打开扩展。'
      : '当前步骤为「' + label + '」。' };
  }
  if (click === 'confirm') {
    const dialogs = [...document.querySelectorAll('[role="dialog"], .weui-desktop-dialog')]
      .filter(visible);
    const buttons = new Set();
    for (const dialog of dialogs) {
      if (!/(设为|设置为|选为|设成|上传|提交|发布|覆盖|更换)\s*体验版|体验版\s*(设置|上传|确认)/.test(dialog.innerText)) continue;
      for (const button of dialog.querySelectorAll(interactive)) {
        if (visible(button) && !button.matches(':disabled, [aria-disabled="true"]') &&
            ['确定', '确认'].includes(button.innerText.trim())) buttons.add(button);
      }
    }
    if (buttons.size !== 1) return null;
    [...buttons][0].click();
    return { found: true };
  }
  if (click === 'navigate') {
    const links = [...document.querySelectorAll(interactive)].filter(element =>
      visible(element) && element.innerText.trim() === '版本管理');
    if (links.length !== 1) return null;
    links[0].click();
    return { found: true };
  }
  const versionElements = !version ? [] : [...document.querySelectorAll('body *')].filter(element =>
    visible(element) && matchesVersion(element.textContent.trim()) &&
    ![...element.children].some(child => matchesVersion(child.textContent.trim())));
  const candidates = new Set();

  for (const element of versionElements) {
    // Limit the search to a version record rather than matching a button elsewhere.
    const record = element.closest('tr, [role="row"], li, article, .weui-desktop-panel');
    if (!record) continue;
    const versions = versionElements.filter(item => record.contains(item));
    if (versions.length !== 1) continue;

    for (const control of record.querySelectorAll(interactive)) {
      const label = (control.innerText || control.getAttribute('aria-label') || '').trim();
      if (visible(control) && labels.includes(label) &&
          !control.matches(':disabled, [aria-disabled="true"]')) {
        candidates.add(control);
      }
    }
  }

  if (!version) {
    for (const control of document.querySelectorAll(interactive)) {
      const label = (control.innerText || control.getAttribute('aria-label') || '').trim();
      if (visible(control) && labels.includes(label) &&
          !control.matches(':disabled, [aria-disabled="true"]')) candidates.add(control);
    }
  }
  if (candidates.size !== 1) {
    return candidates.size
      ? '找到多个匹配按钮，请填写要处理的版本号。'
      : '未找到唯一按钮。请确认版本号，或展开目标版本的「更多」菜单后重试。';
  }
  const [control] = candidates;
  if (click) {
    control.click();
    return { found: true, message: '已点击入口。请核对网页显示的结果或确认表单。' };
  }
  control.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const effect = control.animate([
    { outline: '4px solid #16834a', outlineOffset: '4px' },
    { outline: '4px solid #16834a', outlineOffset: '4px' },
  ], { duration: 12000 });
  effect.play();
  return { found: true, message: '已高亮按钮。核对账号和版本后可点击入口。' };
}

globalThis.locateOnPage = locateOnPage;
