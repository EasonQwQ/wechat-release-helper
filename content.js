// 常驻内容脚本：页面切换 / 刷新 / 换小程序时自动恢复提审，无需再点扩展弹窗。
// 由 manifest 的 content_scripts 注入（与 page-core.js 同一隔离世界）。
(() => {
  if (globalThis.__WRH_CONTENT_READY) return;
  globalThis.__WRH_CONTENT_READY = true;

  const TOKEN = '__wechatReleaseAutoAuditPageToken';
  const STATE = '__wechatReleaseAutoAuditState';
  const ARM = '__wechatReleaseAutoAuditArm';
  const ACTIONS = '__wechatReleaseAutoAuditActions';
  const DONEURL = '__wechatReleaseAutoAuditDoneUrl';
  const HEARTBEAT = '__wechatReleaseAutoAuditHeartbeat';
  const GLOBAL_KEY = 'wrhGlobalAuto';

  // 每次文档加载生成新 token：旧页面 watcher 留下的心跳带旧 token，不会被误判为存活。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  globalThis[TOKEN] = token;
  const get = key => { try { return sessionStorage.getItem(key); } catch (error) { return null; } };
  const set = (key, value) => { try { sessionStorage.setItem(key, value); } catch (error) {} };
  const del = key => { try { sessionStorage.removeItem(key); } catch (error) {} };
  const parse = key => {
    try { const raw = get(key); return raw ? JSON.parse(raw) : null; } catch (error) { return null; }
  };
  set(TOKEN, token);

  const core = () => globalThis.locateOnPage;
  const isAlive = () => {
    const [beatToken, beatAt] = String(get(HEARTBEAT) || '').split('|');
    return beatToken === token && Date.now() - Number(beatAt) < 1500;
  };
  const readGlobal = async () => {
    try {
      if (!chrome.storage?.local) return { unavailable: true };
      const result = await chrome.storage.local.get(GLOBAL_KEY);
      return result?.[GLOBAL_KEY] || { enabled: false };
    } catch (error) { return { unavailable: true }; }
  };

  // 全局持续模式：由弹窗写入 chrome.storage.local，任意标签页加载后都能自动接上。
  async function ensure() {
    const fn = core();
    if (typeof fn !== 'function') return;
    const globalArm = await readGlobal();
    let arm = parse(ARM);

    if (!globalArm.unavailable) {
      if (globalArm.enabled && !arm) {
        // 本标签页还没启用过：从全局模式继承，覆盖新标签页/新打开的小程序页面。
        fn(globalArm.description || '', [], 'audit-auto-arm-batch');
        arm = parse(ARM);
      } else if (!globalArm.enabled && arm?.mode === 'batch') {
        // 弹窗点了停止：所有标签页在下一次轮询内解除持续模式。
        fn('', [], 'audit-auto-disarm');
        return;
      }
    }
    // storage 不可用时跳过全局判定，保留本标签页已有的 arm 继续工作。
    if (!arm || isAlive()) return;

    const state = parse(STATE);
    // 失败 / 超时 / 明确停止后不自动重启，避免死循环。
    if (state && ['failed', 'timeout', 'stopped'].includes(state.state)) return;
    if (state?.state === 'done') {
      // 上一次已提交完成：只有「换到另一个 URL」才开启下一轮，避免同一页重复提审。
      if (!arm.batch || get(DONEURL) === location.href) return;
      del(ACTIONS);
      del(DONEURL);
    }
    fn('', [], 'audit-auto-resume');
  }

  // 预留消息通道（弹窗也可直接 sendMessage，无需每次注入脚本）。
  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.cmd !== 'wechat-release-helper') return;
    try {
      const fn = core();
      sendResponse({ ok: true, result: fn(message.argument || '', message.labels || [], message.step) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  });

  ensure();
  setInterval(ensure, 800);
})();
