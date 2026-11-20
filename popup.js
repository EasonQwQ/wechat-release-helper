// 弹窗 UI。页面侧逻辑在 page-core.js（本页通过 script 标签先加载），
// 常驻自动恢复在 content.js（manifest 注入），此处只负责发指令和展示状态。
const openAction = document.querySelector('#open-action');
let located;
const status = document.querySelector('#status');

async function run(click) {
  openAction.disabled = true;
  const version = document.querySelector('#version').value.trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(version)) {
    status.textContent = '请填写完整版本号。';
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      status.textContent = '请先切换到微信公众平台的版本管理页。';
      return;
    }
    const action = document.querySelector('#action').value;
    const key = JSON.stringify([tab.id, tab.url, version, action]);
    if (click && located !== key) throw new Error('页面或选项已变更，请重新定位');
    located = undefined;
    const labels = action === 'trial'
      ? ['设为体验版', '选为体验版', '设置为体验版']
      : ['提交审核', '提交发布审核', '提交审查'];
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locateOnPage,
      args: [version, labels, click],
    });
    status.textContent = result.message || result;
    if (!click && result.found) {
      located = key;
      openAction.disabled = false;
    }
  } catch (error) {
    status.textContent = `无法定位：${error.message}`;
  }
}

document.querySelector('#locate').addEventListener('click', () => run(false));
openAction.addEventListener('click', () => run(true));

const auto = document.querySelector('#auto');
const audit = document.querySelector('#audit');
async function automate(isAudit) {
  const version = document.querySelector('#version').value.trim();
  if (version && !/^[a-zA-Z0-9_.-]+$/.test(version)) {
    status.textContent = '版本号格式不正确。';
    return;
  }
  const target = version || '唯一可选开发版本';
  const action = isAudit ? '打开提审（自动勾选「已阅读并了解平台审核规则」并继续通过安全测试提醒）' : '设为体验版';
  if (!window.confirm(`为当前公众平台账号的 ${target} ${action}？`)) return;
  auto.disabled = true;
  audit.disabled = true;
  openAction.disabled = true;
  located = undefined;
  const labels = isAudit
    ? ['提交审核', '提交发布审核', '提交审查']
    : ['设为体验版', '选为体验版', '设置为体验版'];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      throw new Error('请在已登录的微信公众平台标签页操作');
    }
    const execute = async step => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: locateOnPage,
        args: [version, labels, step],
      });
      return result;
    };
    const poll = async step => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const currentTab = await chrome.tabs.get(tab.id);
        if (currentTab.status === 'complete') {
          try {
            const result = await execute(step);
            if (result?.found) return true;
          } catch (error) {
            if (!/frame|document|loading/i.test(error.message)) throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return false;
    };
    status.textContent = '正在查找目标版本…';
    let found = (await execute(false))?.found;
    if (!found) {
      await execute('navigate');
      status.textContent = '正在等待版本管理加载，最多等待 30 秒…';
      found = await poll(false);
    }
    if (!found) {
      const result = await execute(false);
      throw new Error(typeof result === 'string' ? result : '未找到体验版入口');
    }
    if (!(await execute(true))?.found) throw new Error('目标入口已变化，请重新定位');
    if (isAudit) {
      status.textContent = '正在等待审核须知弹窗…';
      status.textContent = await poll('audit-watch')
        ? '正在自动勾选审核规则，并继续打开提审表单。'
        : '未识别到审核须知弹窗，请查看网页当前步骤。';
      return;
    }
    status.textContent = await poll('confirm')
      ? '已点击体验版确认按钮，请核对网页显示的体验版版本号。'
      : '已点击体验版入口。请查看网页结果，或手动处理弹窗。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    auto.disabled = false;
    audit.disabled = false;
  }
}

auto.addEventListener('click', () => automate(false));
audit.addEventListener('click', () => automate(true));
async function auditStep(step, description = '') {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
    throw new Error('请切换到微信公众平台提审页面');
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: locateOnPage,
    args: [description, [], step],
  });
  return result;
}

document.querySelector('#audit-next').addEventListener('click', async () => {
  try {
    const current = await auditStep('audit-inspect');
    status.textContent = current.message;
    if (!current.label) return;
    const final = current.label === '提交审核';
    if (final && !window.confirm('确认将当前网页中的版本和资料正式提交给微信审核？')) return;
    if (current.label === '继续提交' && !window.confirm('确认已阅读安全测试提醒，并继续打开提审表单？')) return;
    status.textContent = (await auditStep('audit-advance', current.label)).message;
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector('#audit-fill').addEventListener('click', async () => {
  try {
    const description = document.querySelector('#audit-description').value.trim();
    if (!description || description.length > 200) throw new Error('请输入 1 至 200 字的版本描述。');
    status.textContent = (await auditStep('audit-fill', description)).message;
  } catch (error) {
    status.textContent = error.message;
  }
});

// 一键自动提交审核：只在开始前确认一次，其余步骤由页面内 watcher 完成。
// 页面切换 / 刷新后会由 content.js 自动恢复，无需重新点扩展。
const autoSubmitBtn = document.querySelector('#audit-auto');
const autoStopBtn = document.querySelector('#audit-auto-stop');
const auditForceBtn = document.querySelector('#audit-force');
const autoBatchBtn = document.querySelector('#audit-auto-batch');
let watcherActive = false;

// 轮询页面内 watcher 的状态；返回终态或超时后的 pending。
async function pollAutoStatus(tabId, execute) {
  for (let attempt = 0; attempt < 380; attempt += 1) {
    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab.status === 'complete') {
      try {
        const current = await execute('audit-auto-status', '');
        if (current?.state) {
          status.textContent = current.message;
          if (['done', 'failed', 'timeout', 'stopped'].includes(current.state)) return current;
        }
      } catch (error) {
        if (!/frame|document|loading/i.test(error.message)) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { state: 'pending', message: '自动提审仍在后台进行，请稍后重新打开扩展查看结果，或点「停止自动提审」。' };
}

const GLOBAL_KEY = 'wrhGlobalAuto';
// storage 权限在扩展重新加载后才生效；缺它时一律降级为本标签页模式，不能抛错。
const storageLocal = () => (typeof chrome !== 'undefined' && chrome.storage?.local) || null;
async function setGlobalMode(value) {
  const local = storageLocal();
  if (!local) return false;
  try { await local.set({ [GLOBAL_KEY]: value }); return true; } catch (error) { return false; }
}
async function getGlobalMode() {
  const local = storageLocal();
  if (!local) return null;
  try {
    const result = await local.get(GLOBAL_KEY);
    return result?.[GLOBAL_KEY] || null;
  } catch (error) { return null;
  }
}

async function autoSubmitAudit() {
  const version = document.querySelector('#version').value.trim();
  if (version && !/^[a-zA-Z0-9_.-]+$/.test(version)) {
    status.textContent = '版本号格式不正确。';
    return;
  }
  const description = document.querySelector('#audit-description').value.trim();
  if (description.length > 200) {
    status.textContent = '版本描述不能超过 200 字。';
    return;
  }
  const target = version || '唯一可选开发版本';
  const warning = `即将为当前公众平台账号的 ${target} 正式提交审核：\n\n` +
    '· 自动勾选审核规则、通过安全测试提醒\n' +
    (description ? `· 自动填写版本描述：${description}\n` : '· 版本描述留空：沿用网页已有值，网页也为空则停止\n') +
    '· 自动点击最终「提交审核」\n' +
    '· 页面切换/刷新会自动恢复，不用重新点扩展\n\n' +
    '提交后不可撤销，请确认账号、版本和代码无误。';
  if (!window.confirm(warning)) return;
  autoSubmitBtn.disabled = true;
  autoStopBtn.disabled = false;
  auto.disabled = true;
  audit.disabled = true;
  autoBatchBtn.disabled = true;
  openAction.disabled = true;
  located = undefined;
  let watcherStarted = false;
  const labels = ['提交审核', '提交发布审核', '提交审查'];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      throw new Error('请在已登录的微信公众平台标签页操作');
    }
    const execute = async (step, argument = version) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: locateOnPage,
        args: [argument, labels, step],
      });
      return result;
    };
    const poll = async (step, argument = version) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const currentTab = await chrome.tabs.get(tab.id);
        if (currentTab.status === 'complete') {
          try {
            const result = await execute(step, argument);
            if (result?.found) return true;
          } catch (error) {
            if (!/frame|document|loading/i.test(error.message)) throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return false;
    };
    // 已经停在审核须知 / 安全提醒 / 提审表单时，直接接管，不再找版本入口。
    const inFlow = (await execute('audit-auto-context'))?.found;
    if (!inFlow) {
      status.textContent = '正在查找目标版本…';
      let found = (await execute(false))?.found;
      if (!found) {
        await execute('navigate');
        status.textContent = '正在等待版本管理加载，最多等待 30 秒…';
        found = await poll(false);
      }
      if (!found) {
        const result = await execute(false);
        throw new Error(typeof result === 'string' ? result : '未找到提交审核入口');
      }
      status.textContent = '正在打开提审入口…';
      if (!(await execute(true))?.found) throw new Error('目标入口已变化，请重新定位');
    }

    const started = await execute('audit-auto', description);
    if (!started?.found) throw new Error('自动提审未能启动');
    watcherStarted = true;
    watcherActive = true;
    status.textContent = '自动提审已启动，请勿关闭该标签页…';

    const final = await pollAutoStatus(tab.id, execute);
    if (final.state !== 'pending') {
      watcherActive = false;
      return;
    }
    status.textContent = final.message;
  } catch (error) {
    status.textContent = error.message;
    if (!watcherStarted) watcherActive = false;
  } finally {
    autoSubmitBtn.disabled = false;
    auto.disabled = false;
    audit.disabled = false;
    autoBatchBtn.disabled = false;
    autoStopBtn.disabled = !watcherActive;
  }
}

// 持续自动提审：开启后任意公众平台页面（含新标签页、换小程序）都会自动接上并提交。
// 只在开启时确认一次；停止前一直有效。
async function startPersistentAuto() {
  const description = document.querySelector('#audit-description').value.trim();
  if (description.length > 200) {
    status.textContent = '版本描述不能超过 200 字。';
    return;
  }
  const warning = '即将开启「持续自动提审」：\n\n' +
    '· 当前页面和之后切换到的每个微信公众平台页面，都会自动打开「提交审核」入口\n' +
    '· 自动同意审核规则、通过安全测试提醒、填写版本描述并提交审核\n' +
    (description ? `· 版本描述：${description}\n` : '· 版本描述留空：沿用网页已有值，网页也为空则停止\n') +
    '· 刷新、换标签页、换小程序都不用再点扩展\n\n' +
    '每一次提交都不可撤销。开启后请确认每个账号和版本无误，随时点「停止自动提审」结束。';
  if (!window.confirm(warning)) return;
  autoBatchBtn.disabled = true;
  autoSubmitBtn.disabled = true;
  autoStopBtn.disabled = false;
  auto.disabled = true;
  audit.disabled = true;
  openAction.disabled = true;
  let started = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      throw new Error('请在已登录的微信公众平台标签页操作');
    }
    const storageOk = await setGlobalMode({ enabled: true, description, startedAt: Date.now() });
    const execute = async (step, argument = description) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: locateOnPage,
        args: [argument, [], step],
      });
      return result;
    };
    const result = await execute('audit-auto-batch');
    if (!result?.found) throw new Error(result?.message || '持续自动提审未能启动');
    started = true;
    watcherActive = true;
    status.textContent = storageOk
      ? '持续自动提审已开启，切换页面无需再点扩展…'
      : '已在本标签页开启持续自动提审（跨标签页需在扩展页点「重新加载」）…';

    const final = await pollAutoStatus(tab.id, execute);
    if (final.state === 'done') {
      status.textContent = '本次已提交审核。持续模式仍在运行：切到下一个页面会自动继续；点「停止自动提审」结束。';
    } else if (final.state === 'pending') {
      status.textContent = `${final.message}（持续模式仍在运行）`;
    } else if (final.state === 'stopped') {
      watcherActive = false;
    }
  } catch (error) {
    status.textContent = error.message;
    if (!started) watcherActive = false;
  } finally {
    autoBatchBtn.disabled = false;
    autoSubmitBtn.disabled = false;
    auto.disabled = false;
    audit.disabled = false;
    autoStopBtn.disabled = !watcherActive;
  }
}

// 中途卡住（例如「下一步」未启用）时，直接接管并继续，不用重跑整个流程。
auditForceBtn.addEventListener('click', async () => {
  auditForceBtn.disabled = true;
  autoStopBtn.disabled = false;
  watcherActive = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      throw new Error('请切换到微信公众平台标签页');
    }
    const description = document.querySelector('#audit-description').value.trim();
    const execute = async (step, argument = description) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: locateOnPage,
        args: [argument, [], step],
      });
      return result;
    };
    const result = await execute('audit-auto-force');
    if (!result?.found) throw new Error(result?.message || '无法继续当前步骤');
    status.textContent = result.message;
    const final = await pollAutoStatus(tab.id, execute);
    if (final.state !== 'pending') watcherActive = false;
    else status.textContent = final.message;
  } catch (error) {
    status.textContent = error.message;
    watcherActive = false;
  } finally {
    auditForceBtn.disabled = false;
    autoStopBtn.disabled = !watcherActive;
  }
});

autoSubmitBtn.addEventListener('click', autoSubmitAudit);
autoBatchBtn.addEventListener('click', startPersistentAuto);
autoStopBtn.addEventListener('click', async () => {
  try {
    await setGlobalMode({ enabled: false });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') {
      throw new Error('请切换到微信公众平台标签页');
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locateOnPage,
      args: ['', [], 'audit-auto-stop'],
    });
    status.textContent = result?.message || '已停止自动提审。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    watcherActive = false;
    autoStopBtn.disabled = true;
    autoSubmitBtn.disabled = false;
    autoBatchBtn.disabled = false;
    auto.disabled = false;
    audit.disabled = false;
  }
});

// 体验版：刷新识别当前页面的小程序和开发版本，选中后一键设为体验版。
const trialRefreshBtn = document.querySelector('#trial-refresh');
const trialUploadBtn = document.querySelector('#trial-upload');
const trialInfo = document.querySelector('#trial-info');
const trialList = document.querySelector('#trial-list');
let trialSnapshot = null;

async function scanTrial() {
  trialRefreshBtn.disabled = true;
  trialUploadBtn.disabled = true;
  trialSnapshot = null;
  trialList.replaceChildren();
  trialInfo.textContent = '正在识别当前页面的小程序和开发版本…';
  try {
    let result = await auditStep('trial-scan');
    if (!result?.found) throw new Error(result?.message || '无法读取当前页面');
    if (!result.entries?.length) {
      // 登录后的首页不是版本管理页：自动点进「版本管理」再重扫，最多等 10 秒。
      const navigated = await auditStep('navigate');
      if (navigated?.found) {
        trialInfo.textContent = '正在打开版本管理页…';
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            const retry = await auditStep('trial-scan');
            if (retry?.found && retry.entries?.length) { result = retry; break; }
          } catch (error) {
            if (!/frame|document|loading/i.test(error.message)) throw error;
          }
        }
      }
    }
    const accounts = result.accounts || [];
    const entries = result.entries || [];
    trialSnapshot = { count: entries.length, entries, accounts };
    if (!entries.length) {
      trialInfo.textContent = `${accounts.length ? `小程序：${accounts.join('、')}。` : ''}` +
        '当前页面没有「设为体验版」入口，请切到版本管理页后点「刷新识别」。';
      return;
    }
    trialInfo.textContent = `${accounts.length ? `小程序：${accounts.join('、')}` : '未能识别小程序名称（请核对网页账号）'}` +
      ` · 识别到 ${entries.length} 个入口：`;
    let firstEnabled = -1;
    for (const entry of entries) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'trial-entry';
      radio.value = String(entry.index);
      radio.disabled = !!entry.disabled;
      if (!entry.disabled && firstEnabled < 0) {
        firstEnabled = entry.index;
        radio.checked = true;
      }
      const text = document.createElement('span');
      // entry.text 里通常已含版本号和按钮文案，先剥掉再展示备注，避免重复。
      let detail = String(entry.text || '');
      if (entry.version) detail = detail.split(entry.version).join('');
      if (entry.label) detail = detail.split(entry.label).join('');
      detail = detail.replace(/^[\s·:：-]+|[\s·:：-]+$/g, '').trim();
      const suffix = detail ? ` · ${detail.slice(0, 42)}` : '';
      text.textContent = `${entry.version || entry.label}${entry.disabled ? '（当前不可用）' : ''}${suffix}`;
      label.append(radio, text);
      trialList.append(label);
    }
    trialUploadBtn.disabled = firstEnabled < 0;
  } catch (error) {
    trialInfo.textContent = `识别失败：${error.message}`;
  } finally {
    trialRefreshBtn.disabled = false;
  }
}

trialRefreshBtn.addEventListener('click', scanTrial);

trialUploadBtn.addEventListener('click', async () => {
  if (!trialSnapshot) {
    trialInfo.textContent = '请先点「刷新识别」。';
    return;
  }
  const checked = trialList.querySelector('input[name="trial-entry"]:checked');
  if (!checked) {
    trialInfo.textContent = '请选择要设为体验版的版本。';
    return;
  }
  const index = Number(checked.value);
  const entry = trialSnapshot.entries.find(item => item.index === index);
  if (!entry || entry.disabled) {
    trialInfo.textContent = '该版本当前不可用，请重新点「刷新识别」。';
    return;
  }
  const appName = trialSnapshot.accounts.length
    ? trialSnapshot.accounts.join('、') : '当前小程序（网页未显示名称，请核对账号）';
  const target = entry.version || entry.label;
  if (!window.confirm(`即将为「${appName}」把 ${target} 设为体验版：\n\n` +
    '· 会覆盖当前体验版\n' +
    '· 自动点击网页上的确认弹窗\n\n' +
    '请确认账号与版本无误。')) return;

  trialRefreshBtn.disabled = true;
  trialUploadBtn.disabled = true;
  let clicked = false;
  try {
    const payload = JSON.stringify({ index, count: trialSnapshot.count, label: entry.label });
    const result = await auditStep('trial-upload', payload);
    if (!result?.found) throw new Error(result?.message || '未找到体验版入口');
    clicked = true;
    status.textContent = result.message;
    trialInfo.textContent = result.message;

    // 网页确认弹窗可能延迟出现；同时轮询成功提示（有些情况不弹确认直接生效）。
    let confirmed = false;
    let succeeded = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const check = await auditStep('trial-check');
      if (check?.found) { succeeded = true; break; }
      const confirmResult = await auditStep('confirm');
      if (confirmResult?.found) confirmed = true;
      if (confirmed) {
        const after = await auditStep('trial-check');
        if (after?.found) { succeeded = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (succeeded) {
      status.textContent = '微信页面显示：已设为体验版。';
      trialInfo.textContent = `已设为体验版：${target}。请核对网页显示的体验版版本号。`;
    } else if (confirmed) {
      status.textContent = '已点击网页确认按钮，但未检测到成功提示，请在网页核对体验版版本号。';
      trialInfo.textContent = status.textContent;
    } else {
      status.textContent = '已点击体验版入口；网页未出现确认弹窗，请在网页核对结果。';
      trialInfo.textContent = status.textContent;
    }
  } catch (error) {
    status.textContent = error.message;
    trialInfo.textContent = `失败：${error.message}`;
  } finally {
    if (!clicked) { /* 点击失败时保留识别结果，方便重试 */ }
    trialRefreshBtn.disabled = false;
    trialUploadBtn.disabled = false;
  }
});

// ---------- 本地上传：扫描工作区项目，通过本机桥接服务调用小程序 CLI ----------
// 扩展不能启动进程，所以只发 HTTP；真正的 spawn 在 upload-server.cjs 里。
const DEFAULT_UPLOAD_BASE = 'http://127.0.0.1:17823';
const OPTIONAL_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];
const uploadRefreshBtn = document.querySelector('#upload-refresh');
const uploadStartBtn = document.querySelector('#upload-start');
const uploadInfo = document.querySelector('#upload-info');
const uploadList = document.querySelector('#upload-list');
const uploadLog = document.querySelector('#upload-log');
const uploadBaseInput = document.querySelector('#upload-base');
const uploadOpenPanel = document.querySelector('#upload-open-panel');
let uploadRunning = false;
let uploadCursor = 0;
let uploadPoller = null;
let uploadProjects = [];

function uploadBase() {
  const value = String(uploadBaseInput.value || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_UPLOAD_BASE;
}
try {
  const saved = localStorage.getItem('wrhUploadBase');
  if (saved) uploadBaseInput.value = saved;
} catch (error) { /* file:// 或隐私模式下忽略 */ }
uploadBaseInput.value = uploadBaseInput.value || DEFAULT_UPLOAD_BASE;
uploadBaseInput.addEventListener('change', () => {
  try { localStorage.setItem('wrhUploadBase', uploadBase()); } catch (error) { /* 忽略 */ }
});
uploadOpenPanel.addEventListener('click', event => {
  event.preventDefault();
  const url = uploadBase() + '/';
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
});

// ---------- 首次设置：根目录 / CLI / 接口地址校验，持久化在本机服务配置里 ----------
const configRootInput = document.querySelector('#config-root');
const configCliInput = document.querySelector('#config-cli');
const configHostInput = document.querySelector('#config-host');
const configStatus = document.querySelector('#config-status');

function renderUploadConfig(cfg) {
  if (!cfg || !cfg.configFile) return; // 服务没开或返回桩数据时，保持默认界面
  configRootInput.value = cfg.root || '';
  configCliInput.value = cfg.cliPath || '';
  configHostInput.value = cfg.expectedHost || '';
  configStatus.textContent = [
    `目录：${cfg.root || '未设置'}（${cfg.rootExists ? '已找到' : '不存在'}）`,
    `模式：${cfg.mode === 'batch' ? '批量脚本' : '直接 CLI'} · 识别 ${cfg.projectCount} 个项目`,
    `CLI：${cfg.cliExists ? '已找到' : '未找到'}${cfg.cliSource === 'auto' ? '（自动检测）' : ''}`,
    `配置：${cfg.configFile}`,
  ].join('\n');
  if (cfg.needsSetup) {
    uploadInfo.textContent = '首次使用：展开「其他操作 → 本机服务设置」选择项目根目录，或点下方「打开完整上传面板」一键自检。';
  } else if (!cfg.cliExists) {
    uploadInfo.textContent = '未找到微信开发者工具 CLI：展开「其他操作 → 本机服务设置」看安装指引，或打开完整上传面板自检。';
  }
}
async function loadUploadConfig() {
  try { renderUploadConfig(await uploadApi('/api/config', {}, true)); }
  catch (error) { /* 服务没开时保持默认界面 */ }
}
async function saveUploadConfig() {
  configStatus.textContent = '正在保存…';
  try {
    const cfg = await uploadApi('/api/config', {
      method: 'POST',
      body: {
        root: configRootInput.value.trim(),
        cliPath: configCliInput.value.trim(),
        expectedHost: configHostInput.value.trim(),
      },
    });
    renderUploadConfig(cfg);
    configStatus.textContent = `已保存，下次启动自动沿用。\n${configStatus.textContent}`;
    uploadInfo.textContent = '设置已保存，点「刷新识别」重新扫描项目。';
  } catch (error) {
    configStatus.textContent = `保存失败：${error.message}`;
  }
}
document.querySelector('#config-save').addEventListener('click', saveUploadConfig);
document.querySelector('#config-pick').addEventListener('click', async () => {
  configStatus.textContent = '正在打开系统目录选择框…';
  try {
    const result = await uploadApi('/api/pick-root', { method: 'POST' });
    if (result.path) {
      configRootInput.value = result.path;
      await saveUploadConfig();
    } else if (result.cancelled) {
      configStatus.textContent = '已取消选择。';
    } else {
      configStatus.textContent = '无法打开目录选择框，请把绝对路径粘贴到「项目根目录」再点保存。';
    }
  } catch (error) { configStatus.textContent = `选择失败：${error.message}`; }
});

async function requestUploadPermission() {
  try {
    if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
    const has = chrome.permissions.contains
      ? await chrome.permissions.contains({ origins: OPTIONAL_ORIGINS }) : false;
    if (has) return true;
    return await chrome.permissions.request({ origins: OPTIONAL_ORIGINS });
  } catch (error) { return false; }
}

async function uploadApi(pathname, options = {}, retried = false) {
  let response;
  try {
    response = await fetch(uploadBase() + pathname, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (!retried && await requestUploadPermission()) return uploadApi(pathname, options, true);
    throw new Error('连不上本机服务：请双击 start-upload-server.command 启动；若已启动，可能是扩展缺少本机访问权限，请点卡片底部「打开完整上传面板」');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `服务返回 ${response.status}`);
  return data;
}

function uploadSelected() {
  return [...uploadList.querySelectorAll('input[name="upload-project"]:checked')].map(el => el.value);
}
function syncUploadButton() {
  uploadStartBtn.textContent = uploadRunning ? '停止上传' : '上传选中的项目（CLI）';
  uploadStartBtn.classList.toggle('stop', uploadRunning);
  uploadStartBtn.disabled = uploadRunning ? false : (!uploadSelected().length || !document.querySelector('#upload-desc').value.trim());
}
function appendUploadLogs(lines) {
  if (!lines.length) return;
  uploadLog.hidden = false;
  for (const text of lines) uploadLog.textContent += text + '\n';
  uploadLog.scrollTop = uploadLog.scrollHeight;
}

async function scanUploadProjects() {
  // 权限请求必须发生在用户点击的手势链里，不能等 fetch 失败后再补。
  await requestUploadPermission();
  uploadRefreshBtn.disabled = true;
  uploadList.replaceChildren();
  uploadInfo.textContent = '正在扫描本地小程序项目…';
  try {
    const data = await uploadApi('/api/projects');
    uploadProjects = data.projects || [];
    if (!data.cliExists) {
      uploadInfo.textContent = '未找到微信开发者工具 CLI，请先安装并登录开发者工具。';
    } else if (!uploadProjects.length) {
      uploadInfo.textContent = '没有识别到带 project.config.json 的小程序项目；可在「其他操作 → 本机服务设置」更换根目录。';
    } else {
      uploadInfo.textContent = `识别到 ${uploadProjects.length} 个本地小程序，勾选后上传：`;
      uploadInfo.title = `工作区：${data.root}`;
    }
    for (const project of uploadProjects) {
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.name = 'upload-project';
      check.value = project.id;
      check.disabled = !project.ready;
      const span = document.createElement('span');
      const title = document.createTextNode(project.label);
      const appid = document.createElement('span');
      appid.className = 'appid';
      appid.textContent = `${project.appid}${project.lastUpload ? ` · 上次 ${project.lastUpload.version}` : ''}`;
      span.append(title, appid);
      if (project.blockers.length) {
        const issue = document.createElement('span');
        issue.className = 'appid issue';
        issue.textContent = project.blockers.join('；');
        span.append(issue);
      }
      label.append(check, span);
      uploadList.append(label);
    }
    syncUploadButton();
  } catch (error) {
    uploadInfo.textContent = `识别失败：${error.message}`;
  } finally {
    uploadRefreshBtn.disabled = false;
  }
}
uploadRefreshBtn.addEventListener('click', scanUploadProjects);
uploadList.addEventListener('change', syncUploadButton);
document.querySelector('#upload-desc').addEventListener('input', syncUploadButton);

async function pollUploadJob() {
  clearTimeout(uploadPoller);
  try {
    const data = await uploadApi(`/api/job?cursor=${uploadCursor}`);
    appendUploadLogs(data.logs || []);
    uploadCursor = data.next || 0;
    if (data.active) {
      uploadInfo.textContent = '上传进行中，CLI 日志实时显示…';
      uploadPoller = setTimeout(pollUploadJob, 600);
      return;
    }
    uploadRunning = false;
    syncUploadButton();
    const summary = (data.results || []).map(item => `${item.name}: ${item.status}`).join('；');
    if (data.status === 'done') {
      uploadInfo.textContent = `${data.dryRun ? '预演完成（没有真正上传）' : '上传批次结束'}。${summary}`;
      status.textContent = uploadInfo.textContent;
    } else {
      uploadInfo.textContent = `${data.status === 'stopped' ? '已停止' : '上传失败'}：${data.error || summary || '请看日志'}`;
    }
  } catch (error) {
    uploadRunning = false;
    syncUploadButton();
    uploadInfo.textContent = `读取日志失败：${error.message}`;
  }
}

async function startUploadJob() {
  const names = uploadSelected();
  const desc = document.querySelector('#upload-desc').value.trim();
  const version = document.querySelector('#upload-version').value.trim();
  if (!names.length) return;
  if (!desc) { uploadInfo.textContent = '请填写版本说明。'; return; }
  const dryRun = document.querySelector('#upload-dry-run').checked;
  if (!window.confirm(`即将通过小程序 CLI ${dryRun ? '预演' : '上传'} ${names.length} 个项目：\n${names.join('、')}\n\n` +
    `版本 ${version || '自动生成'}\n说明 ${desc}\n\n` +
    (dryRun ? '仅核对命令，不会真正上传。' : '会真实上传开发版，请确认代码和接口地址无误。'))) return;
  uploadStartBtn.disabled = true;
  try {
    const data = await uploadApi('/api/upload', {
      method: 'POST',
      body: {
        names, desc, version, dryRun,
        buildNpm: document.querySelector('#upload-build-npm').checked,
      },
    });
    uploadRunning = true;
    uploadCursor = 0;
    uploadLog.textContent = `任务 ${data.jobId} 已创建\n`;
    uploadLog.hidden = false;
    uploadInfo.textContent = '已提交任务，正在启动 CLI…';
    syncUploadButton();
    pollUploadJob();
  } catch (error) {
    uploadInfo.textContent = `启动失败：${error.message}`;
  } finally {
    if (!uploadRunning) syncUploadButton();
  }
}

uploadStartBtn.addEventListener('click', async () => {
  if (uploadRunning) {
    try {
      await uploadApi('/api/stop', { method: 'POST' });
      uploadInfo.textContent = '已发送停止指令…';
    } catch (error) {
      uploadInfo.textContent = `停止失败：${error.message}`;
    }
    return;
  }
  await startUploadJob();
});

async function restoreUploadJob() {
  try {
    const data = await uploadApi('/api/job', {}, true); // 静默探测，不触发权限请求
    if (!data.active) return;
    uploadRunning = true;
    uploadCursor = 0;
    uploadLog.hidden = false;
    appendUploadLogs([`恢复到进行中的任务 ${data.id}`]);
    syncUploadButton();
    pollUploadJob();
  } catch (error) { /* 服务没开时保持默认界面 */ }
}

// 重新打开 popup 时恢复运行态，保证随时能中止页面内的 watcher。
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).origin !== 'https://mp.weixin.qq.com') return;
    const globalMode = await getGlobalMode();
    if (globalMode?.enabled) {
      status.textContent = '持续自动提审进行中：切换页面会自动继续；点「停止自动提审」结束。';
      watcherActive = true;
      autoStopBtn.disabled = false;
      return;
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locateOnPage,
      args: ['', [], 'audit-auto-status'],
    });
    if (result?.armed && ['running', 'waiting'].includes(result.state)) {
      status.textContent = `${result.message}（页面切换会自动恢复；可点「停止自动提审」）`;
      watcherActive = true;
      autoStopBtn.disabled = false;
      return;
    }
    if (!result?.at || Date.now() - result.at > 600000) return;
    if (!['running', 'waiting'].includes(result.state)) return;
    status.textContent = `${result.message}（可展开「其他操作」点「强制继续当前步骤」，或点「停止自动提审」）`;
    watcherActive = true;
    autoStopBtn.disabled = false;
    autoSubmitBtn.disabled = true;
  } catch (error) {
    // 页面正在加载或未授权时忽略，保持默认界面。
  }
})();

// 重开弹窗时恢复本机上传任务（服务运行中且任务未结束），并读取一次本机配置。
restoreUploadJob();
loadUploadConfig();
