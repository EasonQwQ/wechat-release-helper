// 浏览器测试辅助：定位 playwright-core 与本机 Chrome/Edge。
// 这是「可选的开发依赖」，普通使用者不需要安装，也不影响扩展和上传服务运行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadChromium() {
  const candidates = [
    'playwright-core',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core',
    '/opt/homebrew/lib/node_modules/playwright-core',
    '/usr/local/lib/node_modules/playwright-core',
  ];
  for (const name of candidates) {
    try { return require(name).chromium; } catch (error) { /* 换下一个 */ }
  }
  throw new Error('未找到 playwright-core：浏览器测试是可选的，如需运行请执行 npm i -D playwright-core');
}

function chromePath() {
  // 显式指定优先：WRH_CHROME_PATH=/path/to/chrome node tests/xxx.cjs
  if (process.env.WRH_CHROME_PATH) return process.env.WRH_CHROME_PATH;
  const home = os.homedir();
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(item => fs.existsSync(item)) || candidates[0];
}

module.exports = { loadChromium, chromePath };
