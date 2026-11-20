#!/usr/bin/env node
'use strict';
// 本机 CLI 上传桥接服务：扩展弹窗 / 同机浏览器面板通过 127.0.0.1 调用。
// 只做三件事：扫描工作区里的小程序项目、串行调用上传脚本或 CLI、回传日志。
// 不联网、不接收任意命令：项目名来自磁盘白名单，参数只拼进 argv（无 shell）。
//
// 配置优先级（只在启动时生效）：环境变量 > 配置文件 > 自动检测。
// 运行期通过 POST /api/config 修改，会立即生效并写回配置文件，下次启动自动沿用。
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HELPER = __dirname;
const PORT = Number(process.env.WRH_UPLOAD_PORT || (process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : 17823));
const PANEL = path.join(HELPER, 'upload-panel.html');
const INSTALL_URL = 'https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html';
const CLI_GUIDE = [
  '1. 安装「微信开发者工具」稳定版：' + INSTALL_URL,
  '2. 打开开发者工具 → 设置 → 安全设置 → 打开「服务端口」（CLI 依赖它）。',
  '3. 在开发者工具里扫码登录（首次必须，CLI 不会弹登录框）。',
  '4. CLI 是开发者工具自带的，不需要 npm install：',
  '   macOS：/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  '   Windows：<安装目录>\\cli.bat（常见 C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat）',
  '5. 装在别处就在「CLI 路径」填绝对路径，或设置环境变量 WECHAT_DEVTOOLS_CLI。',
  '6. 验证：终端执行 "<cli 路径>" islogin，输出 {"login":true} 即就绪。',
].join('\n');

// ---------- 配置：写在用户目录，不落在仓库里，开源时不会带出个人路径 ----------
function configPath() {
  if (process.env.WRH_CONFIG_FILE) return path.resolve(process.env.WRH_CONFIG_FILE);
  const base = process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'wechat-release-helper')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wechat-release-helper');
  return path.join(base, 'config.json');
}
const CONFIG_FILE = configPath();

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) { return {}; }
}
function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ---------- 微信开发者工具 CLI：跨平台自动检测 ----------
function cliCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    path.join(home, 'Applications', 'wechatwebdevtools.app', 'Contents', 'MacOS', 'cli'),
  ];
  if (process.platform === 'win32') return [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', '微信web开发者工具', 'cli.bat'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', '微信web开发者工具', 'cli.bat'),
    path.join(home, 'AppData', 'Local', '微信开发者工具', 'cli.bat'),
  ];
  return []; // Linux 无官方开发者工具，需手动填路径
}
function autoDetectCli() {
  const list = cliCandidates();
  return list.find(item => fs.existsSync(item)) || list[0] || '';
}
function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

const saved = readConfig();
const state = {
  root: path.resolve(process.env.WRH_UPLOAD_ROOT || saved.root || path.resolve(HELPER, '..')),
  rootSource: process.env.WRH_UPLOAD_ROOT ? 'env' : saved.root ? 'config' : 'default',
  cliOverride: process.env.WECHAT_DEVTOOLS_CLI || saved.cliPath || '',
  cliPath: '',
  cliSource: process.env.WECHAT_DEVTOOLS_CLI ? 'env' : saved.cliPath ? 'config' : 'auto',
  expectedHost: process.env.WRH_EXPECTED_HOST ?? saved.expectedHost ?? '',
  labels: saved.labels && typeof saved.labels === 'object' && !Array.isArray(saved.labels) ? saved.labels : {},
};
state.cliPath = state.cliOverride || autoDetectCli();

const EXTRA_PATH = process.platform === 'win32' ? '' : ['/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter);
const CHILD_ENV = {
  ...process.env,
  ...(EXTRA_PATH ? { PATH: `${EXTRA_PATH}${path.delimiter}${process.env.PATH || ''}` } : {}),
};

function cliInfo() {
  return {
    path: state.cliPath,
    exists: !!state.cliPath && fs.existsSync(state.cliPath),
    source: state.cliSource,
    candidates: cliCandidates(),
  };
}
// Windows 的 cli.bat 必须经 cmd.exe 启动；其余平台直接 spawn 可执行文件。
function cliInvocation(args) {
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(state.cliPath)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', state.cliPath, ...args] };
  }
  return { command: state.cliPath, args };
}
function rootUploader() { return path.join(state.root, 'upload-mini-programs.cjs'); }

// ---------- 工作区扫描 ----------
function shortNames(uploader) {
  // 复用根脚本里的项目别名表，避免两处维护；读不到时回退为目录名。
  const map = {};
  try {
    const source = fs.readFileSync(uploader, 'utf8');
    const block = /const\s+projects\s*=\s*\{([\s\S]*?)\};/.exec(source)?.[1] || '';
    for (const match of block.matchAll(/(\w+)\s*:\s*['"]([^'"]+)['"]/g)) map[match[2]] = match[1];
  } catch (error) { /* 回退 */ }
  return map;
}

function activeHost(dir) {
  const file = path.join(dir, 'config', 'index.js');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      // 行首空白 + host（多行格式）或 { host（单行对象）都要认；\b 避免误匹配 apiHost。
      const match = /\bhost\s*:\s*['"]([^'"]+)['"]/.exec(line);
      if (!match) continue;
      // URL 里的 // 出现在匹配之后；若 // 在匹配之前，说明这一行是被注释掉的。
      const comment = line.indexOf('//');
      if (comment >= 0 && comment < match.index) continue;
      return match[1];
    }
  } catch (error) { /* 没有该文件 */ }
  return null;
}

function lastUpload(dir) {
  const folder = path.join(dir, '.wechat-upload');
  try {
    const files = fs.readdirSync(folder)
      .filter(name => /^upload-.+-\d{13}\.json$/.test(name))
      .map(name => ({ name, at: fs.statSync(path.join(folder, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files.length) return null;
    const { name, at } = files[0];
    const version = /^upload-(.+)-\d{13}\.json$/.exec(name)?.[1] || '';
    let sizeKB = null;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      if (Number.isFinite(info?.size?.total)) sizeKB = Math.round(info.size.total / 1024);
    } catch (error) { /* 旧格式 */ }
    return { version, at: new Date(at).toISOString(), sizeKB };
  } catch (error) { return null; }
}

function gitInfo(dir) {
  try {
    const run = args => spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const head = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head.status !== 0) return { branch: '', dirty: null };
    const branch = String(head.stdout || '').trim();
    const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { branch, dirty: status.status === 0 ? String(status.stdout || '').trim().length > 0 : null };
  } catch (error) { return { branch: '', dirty: null }; }
}

function isMiniProgram(dir) {
  const file = path.join(dir, 'project.config.json');
  if (!fs.existsSync(file)) return false;
  try { return /^wx[a-f0-9]{16}$/.test(JSON.parse(fs.readFileSync(file, 'utf8')).appid || ''); }
  catch (error) { return false; }
}

function projectDirs() {
  let rootExists = false;
  try { rootExists = fs.statSync(state.root).isDirectory(); } catch (error) { /* 未设置 */ }
  if (!rootExists) return { rootExists, list: [] };
  // 支持两种布局：根目录本身就是一个小程序，或根目录下有多个小程序子目录。
  if (isMiniProgram(state.root)) return { rootExists, list: [{ id: path.basename(state.root), dir: state.root }] };
  const list = [];
  for (const entry of fs.readdirSync(state.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(state.root, entry.name);
    if (isMiniProgram(dir)) list.push({ id: entry.name, dir });
  }
  return { rootExists, list };
}

// batch = 根目录有 upload-mini-programs.cjs（可跑自定义前置检查/测试）；
// direct = 没有该脚本，服务直接调 CLI upload，开箱即用，不需要任何项目内脚本。
function scanProjects() {
  const uploader = rootUploader();
  const batch = fs.existsSync(uploader);
  const aliases = batch ? shortNames(uploader) : {};
  const cli = cliInfo();
  const { rootExists, list } = projectDirs();
  const projects = [];
  for (const item of list) {
    const dir = item.dir;
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf8')); } catch (error) { /* 已校验过 */ }
    const host = activeHost(dir);
    const hasNpm = fs.existsSync(path.join(dir, 'miniprogram_npm'));
    const hasModules = fs.existsSync(path.join(dir, 'node_modules'));
    const hasScript = fs.existsSync(path.join(dir, 'scripts', 'upload-wechat.cjs'));
    let testCount = 0;
    try { testCount = fs.readdirSync(path.join(dir, 'tests')).filter(name => name.endsWith('.test.js')).length; } catch (error) { /* 无 tests */ }
    const blockers = [];
    const warnings = [];
    if (!cli.exists) blockers.push('未找到微信开发者工具 CLI');
    if (batch && !aliases[item.id]) blockers.push('根目录 upload-mini-programs.cjs 里没有登记该项目');
    if (batch && !hasScript) blockers.push('缺少 scripts/upload-wechat.cjs');
    if (state.expectedHost && host && host !== state.expectedHost) {
      blockers.push(`接口地址是 ${host}，上传前必须还原为 ${state.expectedHost}`);
    }
    if (!hasNpm) {
      // 只有批处理脚本会强制要求 miniprogram_npm；通用模式对纯原生小程序只提示。
      if (batch) blockers.push('缺少 miniprogram_npm，请先勾选「上传前构建 npm」');
      else warnings.push('没有 miniprogram_npm：若项目用了 npm 包，请勾选「上传前构建 npm」');
    }
    if (batch && !testCount) warnings.push('没有找到测试文件');
    if (!hasModules) warnings.push('缺少 node_modules，上传脚本跑测试可能失败');
    const git = gitInfo(dir);
    if (git.dirty) warnings.push('有未提交的改动');
    projects.push({
      id: item.id, dir,
      name: aliases[item.id] || '',
      label: state.labels[item.id] || config.projectname || item.id,
      appid: config.appid,
      projectname: config.projectname || '',
      host, hostOk: !state.expectedHost || !host || host === state.expectedHost,
      hasNpm, hasModules, hasScript, testCount,
      gitBranch: git.branch, gitDirty: git.dirty,
      lastUpload: lastUpload(dir),
      blockers, warnings,
      ready: blockers.length === 0,
    });
  }
  projects.sort((a, b) => a.id.localeCompare(b.id));
  return {
    root: state.root, rootExists,
    mode: batch ? 'batch' : 'direct',
    needsSetup: !rootExists || projects.length === 0,
    configFile: CONFIG_FILE,
    cli: cli.path, cliExists: cli.exists, cliSource: cli.source, cliCandidates: cli.candidates,
    installUrl: INSTALL_URL, installGuide: CLI_GUIDE,
    expectedHost: state.expectedHost, port: PORT, projects,
  };
}

function publicConfig() {
  const scan = scanProjects();
  return {
    root: state.root, rootExists: scan.rootExists, rootSource: state.rootSource,
    cliPath: state.cliOverride, cliEffective: scan.cli, cliExists: scan.cliExists,
    cliSource: scan.cliSource, cliCandidates: scan.cliCandidates,
    expectedHost: state.expectedHost, labels: state.labels,
    configFile: CONFIG_FILE, port: PORT, mode: scan.mode,
    projectCount: scan.projects.length, needsSetup: scan.needsSetup,
    installUrl: INSTALL_URL, installGuide: CLI_GUIDE,
    platform: process.platform, nodeVersion: process.version,
  };
}

function applyConfig(body) {
  const next = {
    root: state.root,
    cliOverride: state.cliOverride,
    expectedHost: state.expectedHost,
    labels: { ...state.labels },
  };
  if (Object.hasOwn(body, 'root')) {
    const raw = expandHome(body.root);
    if (!raw || !path.isAbsolute(raw)) throw new Error('项目根目录必须是绝对路径（可用 ~ 开头）');
    let ok = false;
    try { ok = fs.statSync(raw).isDirectory(); } catch (error) { /* 不存在 */ }
    if (!ok) throw new Error(`目录不存在：${raw}`);
    next.root = path.resolve(raw);
  }
  if (Object.hasOwn(body, 'cliPath')) {
    const raw = expandHome(body.cliPath);
    if (raw && !path.isAbsolute(raw)) throw new Error('CLI 路径必须是绝对路径（留空＝自动检测）');
    next.cliOverride = raw;
  }
  if (Object.hasOwn(body, 'expectedHost')) {
    const raw = String(body.expectedHost || '').trim().replace(/\/+$/, '');
    if (raw) {
      let parsed;
      try { parsed = new URL(raw); } catch (error) { throw new Error('接口地址必须是完整的 http(s) URL'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('接口地址必须是 http(s) URL');
    }
    next.expectedHost = raw;
  }
  if (Object.hasOwn(body, 'labels')) {
    const labels = body.labels;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('labels 必须是对象');
    const clean = {};
    for (const [key, value] of Object.entries(labels)) {
      if (Object.keys(clean).length >= 100) break;
      clean[String(key).slice(0, 200)] = String(value).slice(0, 100);
    }
    next.labels = clean;
  }
  state.root = next.root;
  state.cliOverride = next.cliOverride;
  state.cliPath = next.cliOverride || autoDetectCli();
  state.cliSource = next.cliOverride ? 'config' : 'auto';
  state.expectedHost = next.expectedHost;
  state.labels = next.labels;
  if (Object.hasOwn(body, 'root')) state.rootSource = 'config';
  saveConfig({
    root: state.root, cliPath: state.cliOverride,
    expectedHost: state.expectedHost, labels: state.labels,
  });
  return publicConfig();
}

// 原生目录选择：只执行固定脚本，不拼接任何用户输入。
function pickRoot() {
  if (process.env.WRH_PICKER === 'none') return { manual: true, reason: '当前环境禁用了图形选择器' };
  const title = '选择小程序项目根目录';
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt "${title}")`;
    const run = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 120000, env: CHILD_ENV });
    const picked = String(run.stdout || '').trim();
    if (run.status === 0 && picked) return { path: path.resolve(picked) };
    if (/cancel/i.test(String(run.stderr || ''))) return { cancelled: true };
    return { manual: true, reason: String(run.stderr || run.error?.message || '').trim().slice(0, 300) };
  }
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; '
      + '$d = New-Object System.Windows.Forms.FolderBrowserDialog; '
      + `$d.Description = "${title}"; `
      + 'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }';
    const run = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script],
      { encoding: 'utf8', timeout: 120000, env: CHILD_ENV });
    const picked = String(run.stdout || '').trim();
    if (run.status === 0 && picked) return { path: path.resolve(picked) };
    if (run.status === 0) return { cancelled: true };
    return { manual: true, reason: String(run.stderr || run.error?.message || '').trim().slice(0, 300) };
  }
  const run = spawnSync('zenity', ['--file-selection', '--directory', `--title=${title}`],
    { encoding: 'utf8', timeout: 120000, env: CHILD_ENV });
  const picked = String(run.stdout || '').trim();
  if (run.status === 0 && picked) return { path: path.resolve(picked) };
  return { manual: true, reason: '当前系统没有可用的图形目录选择器，请直接粘贴绝对路径' };
}

function isLoginCheck() {
  const cli = cliInfo();
  if (!cli.exists) return { ok: false, loggedIn: false, output: '', error: '未找到微信开发者工具 CLI', installGuide: CLI_GUIDE };
  const inv = cliInvocation(['islogin']);
  const run = spawnSync(inv.command, inv.args, { encoding: 'utf8', timeout: 25000, env: CHILD_ENV });
  const output = String(run.stdout || run.stderr || '').trim().slice(0, 800);
  return {
    ok: run.status === 0 && !run.error,
    loggedIn: run.status === 0 && /"login"\s*:\s*true/.test(output),
    output, error: run.error?.message || '', installGuide: CLI_GUIDE,
  };
}

function doctor() {
  const scan = scanProjects();
  const checks = [];
  const add = (key, ok, message, fix = '') => checks.push({ key, ok, message, fix });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `Node.js ${process.version}`, major >= 18 ? '' : '请安装 Node.js 18 或更高版本');
  add('root', scan.rootExists,
    scan.rootExists ? `根目录：${scan.root}` : `根目录不存在：${scan.root}`,
    scan.rootExists ? '' : '在上方「项目根目录」选择或填写你的工作区');
  add('projects', scan.projects.length > 0, `识别到 ${scan.projects.length} 个小程序项目`,
    scan.projects.length ? '' : '每个项目目录要有 project.config.json，且 appid 为 wx + 16 位十六进制');
  add('cli', scan.cliExists,
    scan.cliExists ? `CLI：${scan.cli}` : '未找到微信开发者工具 CLI',
    scan.cliExists ? '' : CLI_GUIDE);
  const login = isLoginCheck();
  add('login', login.loggedIn,
    login.loggedIn ? '开发者工具已登录' : `未登录或 CLI 未就绪：${login.output || login.error}`,
    login.loggedIn ? '' : '打开微信开发者工具扫码登录，并确认「设置 → 安全设置 → 服务端口」已开启');
  const ready = scan.projects.filter(item => item.ready).length;
  add('ready', ready > 0, `${ready}/${scan.projects.length} 个项目可上传`,
    ready ? '' : '查看项目卡片上的红色阻断提示');
  return { ok: checks.every(item => item.ok), checks, mode: scan.mode, configFile: CONFIG_FILE, installGuide: CLI_GUIDE };
}

// ---------- 上传任务（串行，全局同一时刻只允许一个，IDE 是单实例） ----------
let job = null;
let child = null;

function appendLog(line) {
  if (!job) return;
  for (const part of String(line).split(/\r?\n/)) {
    if (part) job.logs.push(part);
  }
  if (job.logs.length > 4000) job.logs.splice(0, job.logs.length - 4000);
}

function publicJob(cursor = 0) {
  if (!job) return { active: false };
  const from = Math.max(0, Number(cursor) || 0);
  return {
    active: job.status === 'running',
    id: job.id, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt,
    names: job.names, version: job.version, desc: job.desc, dryRun: job.dryRun,
    logs: job.logs.slice(Math.min(from, job.logs.length)),
    next: job.logs.length,
    results: job.results, error: job.error || '',
  };
}

function runStep(command, args, cwd) {
  return new Promise(resolve => {
    appendLog(`\n$ ${[path.basename(command), ...args].join(' ')}`);
    const proc = spawn(command, args, {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV,
    });
    child = proc;
    proc.stdout.on('data', chunk => appendLog(chunk.toString()));
    proc.stderr.on('data', chunk => appendLog(chunk.toString()));
    proc.on('error', error => { appendLog(`启动失败：${error.message}`); });
    proc.on('close', (code, signal) => {
      child = null;
      appendLog(`[退出码 ${code ?? signal}]`);
      resolve(code === 0 ? 0 : (code || 1));
    });
  });
}

function parseResults() {
  const found = {};
  for (const line of job.logs) {
    const match = /^\s{2}(\w+):\s*(已上传|预演通过|失败：.*)$/.exec(line);
    if (match) found[match[1]] = match[2];
  }
  // 根脚本用短别名输出，展示给用户的是目录名，这里做一次映射。
  job.results = job.names.map(dir => ({
    name: dir,
    status: found[job.aliases[dir]] || '未返回结果',
  }));
}

async function runJob(options) {
  const { dirs, version, desc, buildNpm, dryRun, mode } = options;
  appendLog(`任务开始：${job.names.join(', ')} | 版本 ${version} | ${dryRun ? '预演（不真上传）' : '正式上传'}`);
  appendLog(`说明：${desc}`);
  appendLog(mode === 'batch' ? '模式：根目录 upload-mini-programs.cjs 批处理' : '模式：直接调用微信开发者工具 CLI');
  if (buildNpm && !dryRun) {
    for (const dir of dirs) {
      if (job.status !== 'running') break;
      const inv = cliInvocation(['build-npm', '--project', dir]);
      const code = await runStep(inv.command, inv.args, state.root);
      if (code !== 0) { job.error = '构建 npm 失败，已停止后续上传'; break; }
    }
  }
  if (!job.error && job.status === 'running' && mode === 'batch') {
    // 根脚本的位置参数是短别名（shark/blackcat/...），不是目录名。
    const args = [rootUploader(), ...job.names.map(dir => job.aliases[dir] || dir), '--version', version, '--desc', desc];
    if (!dryRun) args.push('--upload');
    const code = await runStep(process.execPath, args, state.root);
    if (code !== 0 && !job.error) job.error = '上传脚本返回非零退出码，请查看日志';
    parseResults();
  } else if (!job.error && job.status === 'running' && dryRun) {
    // 通用模式预演：只打印将要执行的 CLI 命令，完全不调用开发者工具。
    for (const dir of dirs) {
      appendLog(`$ cli upload --project ${dir} --version ${version} --desc ${desc}`);
      job.results.push({ name: path.basename(dir), status: '预演通过' });
    }
  } else if (!job.error && job.status === 'running') {
    for (const dir of dirs) {
      if (job.status !== 'running') break;
      const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_');
      const infoOutput = path.join(dir, '.wechat-upload', `upload-${safeVersion}-${Date.now()}.json`);
      try { fs.mkdirSync(path.dirname(infoOutput), { recursive: true }); } catch (error) { /* 磁盘只读时 CLI 会自行报错 */ }
      const inv = cliInvocation(['upload', '--project', dir, '--version', version, '--desc', desc, '--info-output', infoOutput]);
      const code = await runStep(inv.command, inv.args, state.root);
      job.results.push({ name: path.basename(dir), status: code === 0 ? '已上传' : `失败：退出码 ${code}` });
      if (code !== 0 && !job.error) job.error = 'CLI 上传返回非零退出码，请查看日志';
    }
  }
  if (job.status === 'running') job.status = job.error ? 'failed' : 'done';
  job.endedAt = Date.now();
  if (job.status === 'done') appendLog(dryRun ? '预演完成：命令已核对，没有真正上传。' : '上传批次结束。请到公众平台核对开发版版本号。');
}

function stopJob() {
  if (!job || job.status !== 'running') return false;
  job.status = 'stopped';
  job.endedAt = Date.now();
  appendLog('已收到停止指令…');
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
      try { child.kill('SIGTERM'); } catch (inner) { /* 已退出 */ }
    }
  }
  return true;
}

// ---------- HTTP ----------
function allowedOrigin(origin) {
  if (!origin || origin === 'null') return true; // curl / 本地 file:// / 无 Origin
  if (origin.startsWith('chrome-extension://')) return true;
  return [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin);
}

function send(res, code, data, origin) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function timestamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date()).replace(/[-:]/g, '').replace(' ', '.');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  // 防止 DNS rebinding：只接受指向本机的 Host。
  const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host);
  if (!hostOk || !allowedOrigin(origin)) {
    send(res, 403, { error: '仅允许本机访问' }, origin);
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORT}`); } catch (error) {
    send(res, 400, { error: '无效 URL' }, origin);
    return;
  }
  // 第三方页面可能用 sandbox iframe 伪造 Origin: null 发起 CSRF；写操作一律拒绝。
  if (origin === 'null' && req.method === 'POST') {
    send(res, 403, { error: '仅允许本机或扩展发起写操作' }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const body = fs.readFileSync(PANEL);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) { send(res, 500, { error: `面板文件缺失：${error.message}` }, origin); }
    return;
  }
  // 同源提供扩展 UI：便于在没有扩展环境时用浏览器直接调试，也让端到端测试能跑真实弹窗。
  const STATIC = { '/popup.html': 'text/html; charset=utf-8', '/popup.js': 'text/javascript; charset=utf-8', '/page-core.js': 'text/javascript; charset=utf-8' };
  if (req.method === 'GET' && STATIC[url.pathname]) {
    try {
      const body = fs.readFileSync(path.join(HELPER, url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': STATIC[url.pathname], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) { send(res, 500, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    try { send(res, 200, scanProjects(), origin); }
    catch (error) { send(res, 500, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const scan = scanProjects();
    send(res, 200, {
      ok: true, root: state.root, cli: scan.cli, cliExists: scan.cliExists,
      port: PORT, busy: job?.status === 'running', mode: scan.mode,
      needsSetup: scan.needsSetup, configFile: CONFIG_FILE,
    }, origin);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    try { send(res, 200, publicConfig(), origin); }
    catch (error) { send(res, 500, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body;
    try { body = await readBody(req); } catch (error) {
      send(res, 400, { error: error.message }, origin); return;
    }
    if (job?.status === 'running') {
      send(res, 409, { error: '上传任务进行中，请完成后再修改设置' }, origin); return;
    }
    try { send(res, 200, applyConfig(body), origin); }
    catch (error) { send(res, 400, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-root') {
    try { send(res, 200, pickRoot(), origin); }
    catch (error) { send(res, 400, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/doctor') {
    try { send(res, 200, doctor(), origin); }
    catch (error) { send(res, 500, { error: error.message }, origin); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/job') {
    send(res, 200, publicJob(url.searchParams.get('cursor')), origin);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    send(res, 200, { stopped: stopJob() }, origin);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/islogin') {
    send(res, 200, isLoginCheck(), origin);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    let body;
    try { body = await readBody(req); } catch (error) {
      send(res, 400, { error: error.message }, origin); return;
    }
    if (job?.status === 'running') {
      send(res, 409, { error: '已有上传任务在运行，请先停止' }, origin); return;
    }
    const scan = scanProjects();
    const byId = new Map(scan.projects.map(item => [item.id, item]));
    const byName = new Map(scan.projects.map(item => [item.name, item]));
    const requested = Array.isArray(body.names) ? body.names.map(String) : [];
    const dirs = [];
    const aliases = {};
    for (const key of requested) {
      const project = byId.get(key) || byName.get(key);
      if (!project) { send(res, 400, { error: `未知项目：${key}` }, origin); return; }
      if (!dirs.includes(project.id)) {
        dirs.push(project.id);
        aliases[project.id] = project.name || project.id;
      }
    }
    if (!dirs.length) { send(res, 400, { error: '请至少选择一个项目' }, origin); return; }
    const desc = String(body.desc || '').trim();
    if (!desc || desc.length > 200 || desc.startsWith('--')) {
      send(res, 400, { error: '请填写 1-200 字的版本说明' }, origin); return;
    }
    const version = String(body.version || '').trim() || timestamp();
    if (!/^[\w.-]+$/.test(version) || version.startsWith('--')) {
      send(res, 400, { error: '版本号只能包含字母、数字、点、下划线、连字符' }, origin); return;
    }
    const buildNpm = !!body.buildNpm;
    if (!scan.cliExists) { send(res, 400, { error: '未找到微信开发者工具 CLI' }, origin); return; }
    for (const dir of dirs) {
      const project = byId.get(dir);
      const blockers = project.blockers.filter(item => !buildNpm || !item.includes('miniprogram_npm'));
      if (!project.hostOk) { send(res, 400, { error: `${project.label}：接口地址是 ${project.host}，必须先还原为 ${state.expectedHost}` }, origin); return; }
      if (blockers.length) { send(res, 400, { error: `${project.label}：${blockers.join('；')}` }, origin); return; }
    }
    job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'running', startedAt: Date.now(), endedAt: null,
      names: dirs, aliases, version, desc, dryRun: !!body.dryRun,
      mode: scan.mode, dirs: dirs.map(id => byId.get(id).dir),
      logs: [], results: [], error: '',
    };
    send(res, 202, { jobId: job.id, status: 'running' }, origin);
    runJob({
      dirs: job.dirs, version, desc, buildNpm,
      dryRun: !!body.dryRun, mode: scan.mode,
    });
    return;
  }
  send(res, 404, { error: '未找到接口' }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  const scan = scanProjects();
  console.log(`小程序 CLI 上传服务已启动：http://127.0.0.1:${PORT}/`);
  console.log(`项目根目录：${state.root}（${scan.rootExists ? '已找到' : '目录不存在，请在面板里设置'}）`);
  console.log(`微信开发者工具 CLI：${scan.cli || '未配置'}（${scan.cliExists ? '已找到' : '未找到'}）`);
  console.log(`配置文件：${CONFIG_FILE}`);
  console.log(scan.needsSetup || !scan.cliExists
    ? '首次使用：打开上面的地址，点「一键自检」并按提示完成设置。'
    : '可直接在扩展弹窗点「刷新识别」，或在本页面点上传。');
  console.log('按 Ctrl+C 停止。扩展弹窗需要这个服务保持运行。');
});
