'use strict';
const __TIMING = process.argv.includes('--timing');
const __tl = (k) => { if (__TIMING) { try { console.log('[BOOT] ' + k + ' uptime=' + Math.round(process.uptime() * 1000) + 'ms'); } catch (e) {} } };

/* ================================================================
 * SFS 启动器 - 主进程
 * 仿 WeGame 风格：Steam 自动检测 / 游戏启动 / 内嵌浏览器 / 模组一键导入
 * ================================================================ */

const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, Tray, nativeImage } = require('electron');
__tl('require_electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');
// 启动提速：adm-zip(模组/备份) 与 webdav(云盘) 仅在实际用到时才加载，缩短冷启动 require 阶段
let AdmZip = null;
function getAdmZip() { return AdmZip || (AdmZip = require('adm-zip')); }

// ZIP 外部属性高 16 位是 Unix mode；0xA000 表示 symlink。解压前拒绝，防止链接把写入带出目标目录。
function zipEntryIsSymlink(e) {
  try {
    const mode = ((e && e.attr) || 0) >>> 16;
    return (mode & 0xF000) === 0xA000;
  } catch (_) { return false; }
}
let __webdavMod = null;
function getWebdav() { return __webdavMod || (__webdavMod = require('./webdav')); }
let iconv = null;
try { iconv = require('iconv-lite'); } catch (e) {}
__tl('top_requires_done');

// 首次启动迁移：旧版 userData 目录名是「SFS启动器」(无空格)，新版是「SFS 启动器」。
// 新目录还没有配置时，把旧目录的配置/实例/缓存整体复制过来，不丢数据；之后不再触碰旧目录。
(function migrateLegacyUserData() {
  try {
    const newDir = app.getPath('userData');
    const oldDir = path.join(app.getPath('appData'), 'SFS启动器');
    const newCfg = path.join(newDir, 'sfs-launcher-config.json');
    if (!fs.existsSync(oldDir)) return;
    if (fs.existsSync(newCfg)) return; // 新目录已有配置，不覆盖
    const oldCfg = path.join(oldDir, 'sfs-launcher-config.json');
    if (!fs.existsSync(oldCfg)) return;
    fs.mkdirSync(newDir, { recursive: true });
    const copyDir = (src, dst) => {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.name === 'logs') continue; // 跳过运行日志，避免旧日志干扰
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
        else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
      }
    };
    copyDir(oldDir, newDir);
    console.log('[MIGRATE] 已从旧目录迁移配置：' + oldDir + ' -> ' + newDir);
  } catch (e) { console.warn('[MIGRATE] 失败：' + e.message); }
})();

// ===== 文件日志（异步缓冲，不阻塞主线程） =====
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'launcher.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
let logBuffer = [];
let logTimer = null;
function flushLog() {
  if (!logBuffer.length) return;
  const lines = logBuffer.join('');
  logBuffer = [];
  logTimer = null;
  try { fs.appendFile(LOG_FILE, lines, 'utf8', () => {}); } catch (e) {}
}
function writeLog(level, ...args) {
  try {
    const line = '[' + new Date().toLocaleString() + '] [' + level + '] ' + args.map(a => typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a)).join(' ') + '\n';
    logBuffer.push(line);
    // 攒够 10 条或 1 秒刷一次，避免频繁写磁盘
    if (logBuffer.length >= 10) flushLog();
    else if (!logTimer) logTimer = setTimeout(flushLog, 1000);
  } catch (e) {}
}
// 退出时把缓冲区日志写完，并把去抖中的配置强制落盘
app.on('will-quit', () => {
  try { flushConfig(); } catch (e) {}
  try { if (logBuffer.length) fs.writeFileSync(LOG_FILE, logBuffer.join(''), 'utf8'); } catch (e) {}
  // 备份进行中：杀掉 tar 子进程，避免孤儿进程 + temp 残留
  try {
    if (_activeBackup) {
      const cp = _activeBackup.childProc && _activeBackup.childProc();
      if (cp) { try { cp.kill(); } catch (e) {} }
      if (_activeBackup.tmpFile) { try { fs.unlinkSync(_activeBackup.tmpFile); } catch (e) {} }
      _activeBackup = null;
    }
  } catch (e) {}
});
// 接管 console
const origLog = console.log, origErr = console.error, origWarn = console.warn;
console.log = (...args) => { origLog(...args); writeLog('INFO', ...args); };
console.error = (...args) => { origErr(...args); writeLog('ERROR', ...args); };
console.warn = (...args) => { origWarn(...args); writeLog('WARN', ...args); };
console.log('启动器日志系统初始化完成，日志文件：' + LOG_FILE);

// 全局安全网：未捕获异常/拒绝只记日志，不弹原生错误框、不崩主进程
process.on('uncaughtException', (e) => { try { console.error('UNCAUGHT_EXCEPTION', (e && e.stack) || e); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { console.error('UNHANDLED_REJECTION', (e && e.stack) || e); } catch (_) {} });
let fsWorker = null, fsSeq = 0;
const fsWaiting = new Map();
function fsTask(task, arg) {
  return new Promise((resolve, reject) => {
    if (!fsWorker) {
      const { Worker } = require('worker_threads');
      fsWorker = new Worker(path.join(__dirname, 'fs-worker.js'));
      fsWorker.on('message', (m) => {
        const w = fsWaiting.get(m.id);
        if (!w) return;
        fsWaiting.delete(m.id);
        if (m.ok) w.resolve(m.r); else w.reject(new Error(m.err || '后台任务失败'));
      });
      fsWorker.on('error', (e) => { fsWaiting.forEach(w => w.reject(e)); fsWaiting.clear(); fsWorker = null; });
    }
    const id = ++fsSeq;
    fsWaiting.set(id, { resolve, reject });
    fsWorker.postMessage({ id, task, arg });
  });
}

// 正确解码 ZIP 内文件名：UTF-8 标志位未置位时按 GBK 解码，解决中文乱码
function entryNameOf(entry) {
  try {
    if (entry.efs) return entry.entryName;
    const buf = entry.rawEntryName;
    if (iconv && buf) return iconv.decode(buf, 'gbk');
  } catch (e) {}
  return entry.entryName;
}

// ============ 字体渲染（Windows ClearType + GPU DPI 缩放，文字清晰不糊） ============
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');   // 色彩统一，避免渲染偏差
// 硬件加速沿用 Chromium 默认策略：按驱动白名单自动启用 GPU 合成/光栅化，默认开启垂直同步，
// 帧率跟随屏幕（60/120/144Hz），后台不空耗 GPU。不再强制 ignore-gpu-blocklist / Vulkan /
// 关闭 vsync——这些激进开关在老核显上反而触发软件渲染或空转，是旧版发热、卡顿、启动变慢的来源。

const SFS_APPID = '1718870';
const isSmokeWP = process.argv.includes('--smoke-wp'); // 保留壁纸与琉璃，专门复核深浅切换后的显示
const isSmokeLive = process.argv.includes('--smoke-live'); // 独立 profile + 真实壁纸，供 CDP 手动检查，不自动截图退出
const isSmoke = process.argv.includes('--smoke') || isSmokeWP || isSmokeLive;
const isSelfTest = process.argv.includes('--selftest');
// 渲染端在加载时同步问一次是否冒烟模式：冒烟抓图时不弹新手引导，避免污染截图
ipcMain.on('app:is-smoke', (e) => { e.returnValue = isSmoke; });
// 冒烟专用独立 userData：不与用户正在运行的实例抢单实例锁；配置从真实配置快照复制
if (isSmoke) {
  try {
    const smokeProfile = path.join(app.getPath('temp'), 'sfs-smoke-profile');
    app.setPath('userData', smokeProfile);
    fs.mkdirSync(smokeProfile, { recursive: true });
    const realCfg = path.join(process.env.APPDATA || '', 'SFS 启动器', 'sfs-launcher-config.json');
    if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, path.join(smokeProfile, 'sfs-launcher-config.json'));
    // 冒烟快照要干净的界面证据：清掉壁纸、关掉毛玻璃，否则截图里全是壁纸花纹，
    // 无法判断界面本身的排版和对比度（只改这份临时副本，真实配置不动）
    try {
      const smokeCfgPath = path.join(smokeProfile, 'sfs-launcher-config.json');
      if (fs.existsSync(smokeCfgPath)) {
        const c = JSON.parse(fs.readFileSync(smokeCfgPath, 'utf8'));
        if (isSmokeWP) {
          // --smoke-wp：保留真实壁纸，强制浅色 + 琉璃，专门看壁纸透底与深浅切换
          c.glass = true;
          c.glassMode = 'liuli';
          c.theme = 'light';
          c.onboardingDone = true;
        } else if (isSmokeLive) {
          // --smoke-live：保留真实壁纸与毛玻璃，供 CDP 检查对比度；不自动截图
          c.onboardingDone = true;
        } else {
          c.glass = false;
          c.glassMode = 'off';
          c.wallpaper = Object.assign({}, c.wallpaper || {}, { path: '' });
          c.onboardingDone = true; // 指引气泡会遮挡点击、污染截图，冒烟快照里直接标记为已完成
        }
        fs.writeFileSync(smokeCfgPath, JSON.stringify(c, null, 2));
      }
    } catch (e) {}
  } catch (e) {}
}
// 毛玻璃材质：Win11（22000+）用系统 acrylic；Win10 经 DWM 原生接口启用系统亚克力（state4），
// 不支持时降级 Aero（state3），都不可用则实色。koffi / DWM 全部懒加载——默认关闭毛玻璃时
// 启动阶段不加载任何原生二进制，保持与无玻璃版本一致的启动速度。
const winBuildNum = (() => { const m = /(\d+)\s*$/.exec(os.release() || ''); return m ? parseInt(m[1], 10) : 0; })();
const isWin11 = process.platform === 'win32' && winBuildNum >= 22000;
let _dwmGlass = null; // null=未加载, false=加载失败
function dwmGlass() {
  if (_dwmGlass === null) {
    try { _dwmGlass = require('./dwm-glass.js'); } catch (e) { _dwmGlass = false; }
  }
  return _dwmGlass || null;
}
let _glassCap = null;
function glassCap() {
  if (_glassCap) return _glassCap;
  if (isWin11) { _glassCap = { acrylic: true, aero: false, remote: false, dwm: true, transparency: true, build: winBuildNum }; return _glassCap; }
  const d = dwmGlass();
  _glassCap = d ? d.capabilities({ build: winBuildNum }) : { acrylic: false, aero: false, remote: false, dwm: false, transparency: true, build: winBuildNum };
  return _glassCap;
}
// 性能分档（决定 Win10 毛玻璃材质与拖动策略）：
//   · weak   内存 <6GB 或 CPU 核心 ≤2（GPU 探测到基础渲染驱动也可能下调到此档）：全程 Aero(state3)，
//            state3 模糊比 state4 亚克力廉价，弱核显移动/滚动分层窗也能跟手、不残影；
//   · medium 内存 <16GB 或核心 ≤8（或探测到 Intel 集显被封顶）：平时亚克力(state4)，拖动窗口开始的瞬间
//            一次性降到 Aero，停止 150ms 后一次性恢复，全程仅 2 次 DWM 调用；
//   · strong 内存 ≥16GB 且核心 ≥8 且未被集显封顶：全程亚克力。
// 同步档只取 os 内存/核心（零启动开销）；GPU 信息在首窗 did-finish-load 后异步探测一次并持久化封顶，
// 只下调不上调，不臆测具体显卡型号，仅区分基础渲染驱动 / Intel 集显 / 其他。
const GLASS_TIER_RANK = { weak: 0, medium: 1, strong: 2 };
function perfTier(cfg) {
  let base;
  const memGB = os.totalmem() / (1024 * 1024 * 1024);
  const cores = (os.cpus() || []).length || 4;
  if (memGB < 6 || cores <= 2) base = 'weak';
  else if (memGB >= 16 && cores >= 8) base = 'strong';
  else base = 'medium';
  let tier = base;
  if (cfg && cfg.gpuTierCap === 'weak') tier = 'weak';
  else if (cfg && cfg.gpuTierCap === 'medium' && GLASS_TIER_RANK[base] > GLASS_TIER_RANK.medium) tier = 'medium';
  return tier;
}
// 依据配置与机器能力决定材质：acrylic(Win11 系统材质) / dwm(Win10 亚克力,分层窗) /
// aero(老版本 DWM 模糊,分层窗) / off(普通实色窗)。
function glassModeFor(cfg) {
  if (!cfg || cfg.glass === false) return 'off';
  // 优先读前端胶囊的显式选择；旧版本可能没有该字段，回退到自动判断
  // 琉璃(liuli)不新增 DWM 材质：底层按亚克力映射，壁纸/配色/半透层由渲染端叠加。
  const prefRaw = cfg.glassMode || 'acrylic';
  const pref = prefRaw === 'liuli' ? 'acrylic' : prefRaw;

  if (isWin11) {
    // Win11 支持 mica / acrylic；aero 不支持，降级 acrylic
    if (pref === 'mica') return cfg.glassMicaFallback === true ? 'acrylic' : 'mica';
    if (pref === 'aero') return 'acrylic';
    if (pref === 'acrylic') return 'acrylic';
    // 兼容旧字段 win11Material
    if (cfg.win11Material === 'acrylic') return 'acrylic';
    if (cfg.win11Material === 'mica') return 'mica';
    return cfg.glassMicaFallback === true ? 'acrylic' : 'mica';
  }

  // Win10：亚克力=DWM state4(dwm)，Aero=state3(aero)，云母不支持→降级亚克力
  const c = glassCap();
  const tier = perfTier(cfg);
  const canDwm = !!c.acrylic;
  const canAero = !!c.aero || !!c.acrylic;

  if (pref === 'aero') {
    return canAero ? 'aero' : 'off';
  }
  if (pref === 'mica' || pref === 'acrylic') {
    // 弱机默认走更省的 Aero(state3) 保拖动跟手；用户已在知情弹窗确认（glassForceAcrylic）才上 state4
    if (tier === 'weak') {
      if (cfg.glassForceAcrylic === true && canDwm) return 'dwm';
      return canAero ? 'aero' : 'off';
    }
    if (canDwm) return 'dwm';
    if (c.aero) return 'aero';
    return 'off';
  }
  // 无显式选择时自动判断
  if (tier === 'weak') return canAero ? 'aero' : 'off';
  if (canDwm) return 'dwm';
  if (c.aero) return 'aero';
  return 'off';
}
// 窗口“轮廓”相同才无需重建：系统材质或分层透明属性只能在创建窗口时指定，变化必须销毁重建。
function glassProfile(mode) {
  if (isWin11) { if (mode === 'mica') return 'mat-mica'; if (mode === 'acrylic') return 'mat'; return 'solid'; }
  return (mode === 'dwm' || mode === 'aero') ? 'layered' : 'solid';
}
function resolveSystemTheme() {
  try { return require('electron').nativeTheme.shouldUseDarkColors === false ? 'light' : 'dark'; }
  catch (e) { return 'dark'; }
}

// ---------- 配置 ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'sfs-launcher-config.json');
// 入库壁纸目录：选图后复制/压缩落盘到这里，避免依赖原图位置；移除/切换时清理旧副本
const WP_DIR = path.join(app.getPath('userData'), 'wallpapers');

function defaultConfig() {
  return {
    instances: [],
    devMode: false,
    steamPath: '',
    autoShowOnLaunch: false,
    autoOpenWithGame: true,
    closeAction: 'ask',
    theme: 'dark',
    glass: false, // 毛玻璃默认关闭：日常普通窗最流畅；手动开启才承担分层窗/系统材质成本
    glassHeavyAnim: false, // 毛玻璃下是否启用高级 View Transition 动画：关=轻量淡入流畅，开=华丽但可能掉帧
    win11Material: 'auto', // Win11 材质：auto=默认云母 mica，检测不可用/持续掉帧自动回退亚克力；可显式 mica/acrylic
    glassMode: 'acrylic', // 材质胶囊的显式选择：off/aero/acrylic/mica/liuli（开启玻璃时生效，按系统能力映射）
    glassForceAcrylic: false, // 弱机档默认降级更省的 Aero(state3)；用户在知情弹窗确认后强制亚克力(state4)
    glassMicaFallback: false, // auto 下渲染端检测到云母滚动持续掉帧后置 true，下次启动改用亚克力
    wallpaper: { path: '', fit: 'cover', storageMode: 'compress' }, // 主题背景壁纸：本地图片路径 + 适应模式 + 入库方式 compress=压缩JPEG / copy=复制原图
    accentOverride: '', // 手动强调色覆盖（hex）；留空则按壁纸自动取色派生
    onboardingDone: false, // 新手引导是否已看过（首启自动播放一次，设置页可重看）
    configVersion: 1,
    downloadDir: '',
    cloudBackupDir: '',
    webdav: { url: '', user: '', pass: '' },
    proxy: '',
    winBounds: null,
    mods: { pending: [], installed: [] }
  };
}

const CONFIG_VERSION = 1;
// 配置改成「内存为准 + 去抖异步原子写」：
// - 原来每次 load 都读 700KB 文件、每次 save 同步写 700KB，窗口拖动 / 开关动作里会卡主线程；
// - 现在首次读盘后常驻内存，save 只标脏并合并写，退出前强制落盘；
// - 写入先落 .tmp 再 rename，避免断电/崩溃留下半截 JSON。
let __cfgCache = null;
let __cfgDirty = false;
let __cfgTimer = null;

function loadConfig() {
  if (__cfgCache) return __cfgCache;
  let raw = null;
  try {
    if (fs.existsSync(CONFIG_PATH)) raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) { raw = null; /* 损坏则回退默认 */ }
  if (!raw) { __cfgCache = defaultConfig(); return __cfgCache; }
  const base = defaultConfig();
  const cfg = Object.assign(base, raw);
  __cfgCache = cfg;
  if (!Array.isArray(cfg.mods)) cfg.mods = base.mods;
  cfg.mods = Object.assign({ pending: [], installed: [] }, cfg.mods);
  if (!Array.isArray(cfg.mods.pending)) cfg.mods.pending = [];
  if (!Array.isArray(cfg.mods.installed)) cfg.mods.installed = [];
  // 一次性迁移：旧版本默认毛玻璃为开、且 Win10 无条件创建分层窗拖慢启动，升级后统一重置为关闭。
  if (raw.configVersion !== CONFIG_VERSION) {
    if (raw.glass === true) cfg.glass = false;
    cfg.configVersion = CONFIG_VERSION;
    try { saveConfig(cfg); } catch (e) {}
  }
  // 材质胶囊字段迁移：旧版 Win11 用 win11Material 表达，补齐到新的 glassMode
  if (!['off', 'aero', 'acrylic', 'mica', 'liuli'].includes(cfg.glassMode)) {
    if (cfg.win11Material === 'mica' || cfg.win11Material === 'acrylic') cfg.glassMode = cfg.win11Material;
    else cfg.glassMode = 'acrylic';
  }
  // 壁纸 / 琉璃参数对象归一化，避免旧配置缺字段导致渲染端取值中断
  if (!cfg.wallpaper || typeof cfg.wallpaper !== 'object') cfg.wallpaper = { path: '', fit: 'cover' };
  if (typeof cfg.wallpaper.path !== 'string') cfg.wallpaper.path = '';
  if (!['cover', 'contain', 'stretch'].includes(cfg.wallpaper.fit)) cfg.wallpaper.fit = 'cover';
  if (!['compress', 'copy'].includes(cfg.wallpaper.storageMode)) cfg.wallpaper.storageMode = 'compress';
  if (!cfg.accentOverride || typeof cfg.accentOverride !== 'string') cfg.accentOverride = '';
  if (typeof cfg.onboardingDone !== 'boolean') cfg.onboardingDone = false;
  // 琉璃材质参数已固定为默认值，旧配置中的 liuli 字段不再读取，直接移除
  if ('liuli' in cfg) { try { delete cfg.liuli; saveConfig(cfg); } catch (e) {} }
  return cfg;
}

function flushConfig() {
  if (!__cfgDirty || !__cfgCache) return;
  __cfgDirty = false;
  const tmp = CONFIG_PATH + '.tmp';
  try {
    const text = JSON.stringify(__cfgCache, null, 2);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    __cfgDirty = true;
    try { console.error('CONFIG_FLUSH_FAILED', e && e.message); } catch (_) {}
  }
}

function saveConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  __cfgCache = cfg;
  __cfgDirty = true;
  if (__cfgTimer) return;
  __cfgTimer = setTimeout(() => { __cfgTimer = null; flushConfig(); }, 120);
}

// ---------- 递归下降 VDF 解析器 ----------
function parseVDF(text) {
  const root = {};
  let i = 0;
  const n = text.length;
  function skipWs() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else break;
    }
  }
  function readToken() {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      i++;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && text[i + 1] === '"') { out += '"'; i += 2; }
        else { out += text[i]; i++; }
      }
      i++;
      return out;
    }
    let out = '';
    while (i < n && !/[\s{}]/.test(text[i])) { out += text[i]; i++; }
    return out;
  }
  function parseObj() {
    const obj = {};
    while (true) {
      const key = readToken();
      if (key == null || key === '}') return obj;
      if (key === '{') continue;
      const next = readToken();
      if (next === '{') {
        obj[key] = parseObj();
      } else if (next === '}' || next == null) {
        obj[key] = '';
        if (next === '}') return obj;
      } else {
        obj[key] = next;
      }
    }
  }
  return parseObj();
}

// ---------- Steam 路径解析 ----------
function resolveSteamPath() {
  const cfg = loadConfig();
  if (cfg.steamPath && fs.existsSync(path.join(cfg.steamPath, 'steam.exe'))) return cfg.steamPath;

  const regPaths = [
    ['HKCU', 'SOFTWARE\\Valve\\Steam', 'SteamPath'],
    ['HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM', 'SOFTWARE\\Valve\\Steam', 'InstallPath']
  ];
  for (const [hive, key, val] of regPaths) {
    try {
      const out = execFileSyncSafe('reg', ['query', `${hive}\\${key}`, '/v', val]);
      const m = out && out.match(new RegExp(val + '\\s+REG_SZ\\s+(.+)'));
      if (m) {
        const p = m[1].trim().replace(/\//g, '\\');
        if (fs.existsSync(path.join(p, 'steam.exe'))) return p;
      }
    } catch (e) { /* 继续 */ }
  }
  const candidates = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam', 'E:\\Steam', 'F:\\Steam', 'F:\\steam',
    'D:\\Program Files (x86)\\Steam', 'E:\\Program Files (x86)\\Steam'
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'steam.exe'))) return p;
  }
  return '';
}

function execFileSyncSafe(cmd, args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  } catch (e) { return ''; }
}

// ---------- 扫描 Steam 库 ----------
function scanSteamLibraries(steamPath) {
  const libFile = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  const libs = [steamPath];
  try {
    if (fs.existsSync(libFile)) {
      const vdf = parseVDF(fs.readFileSync(libFile, 'utf8'));
      const lf = vdf.libraryfolders || vdf.LibraryFolders || {};
      for (const k of Object.keys(lf)) {
        const v = lf[k];
        if (v && v.path) libs.push(String(v.path).replace(/\//g, '\\'));
      }
    }
  } catch (e) { /* 忽略 */ }
  return [...new Set(libs)];
}

function scanSteamGames(steamPath) {
  const libs = scanSteamLibraries(steamPath);
  const games = [];
  const seen = new Set();
  for (const lib of libs) {
    const appsDir = path.join(lib, 'steamapps');
    if (!fs.existsSync(appsDir)) continue;
    let files = [];
    try { files = fs.readdirSync(appsDir); } catch (e) { continue; }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      try {
        const acf = parseVDF(fs.readFileSync(path.join(appsDir, f), 'utf8'));
        const st = acf.AppState || acf.appstate || {};
        const appId = String(st.appid || '');
        if (!appId || seen.has(appId)) continue;
        seen.add(appId);
        const installdir = st.installdir || '';
        const name = st.name || installdir || ('App ' + appId);
        const installDir = installdir ? path.join(appsDir, 'common', installdir) : '';
        let exePath = '';
        if (installDir && fs.existsSync(installDir)) {
          try {
            for (const sub of fs.readdirSync(installDir)) {
              if (/\.exe$/i.test(sub) && !/uninstall|unitycrash|crash|setup/i.test(sub)) {
                exePath = path.join(installDir, sub); break;
              }
            }
          } catch (e) { /* 忽略 */ }
        }
        games.push({ appId, name, installDir, exePath, libPath: lib });
      } catch (e) { /* 单个解析失败跳过 */ }
    }
  }
  return games;
}

function findSfs(games) {
  return games.find(g => g.appId === SFS_APPID) ||
         games.find(g => /spaceflight/i.test(g.name));
}

// ---------- 模组目录定位 ----------
function currentInstance() {
  const cfg = loadConfig();
  return cfg.instances.find(i => i.current) || cfg.instances[0] || null;
}

function sfsDataDir() {
  const inst = currentInstance();
  if (!inst) throw new Error('请先在「游戏库」中添加 SFS 游戏实例');
  const base = inst.installDir || (inst.exePath ? path.dirname(inst.exePath) : '');
  if (!base) throw new Error('该实例没有安装目录，请重新添加');
  if (!fs.existsSync(base)) throw new Error('游戏目录不存在：' + base + '，请重新添加实例');
  return base;
}

function relPath(root, p) { return path.relative(root, p).replace(/\//g, '\\'); }

// 扩展包必须同时具备 Heightmap Data / Planet Data / Texture Data 三个文件夹
function isValidSolarPackage(dir) {
  if (!fs.existsSync(dir)) return false;
  const need = ['heightmapdata', 'planetdata', 'texturedata'];
  let subs = [];
  try { subs = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isDirectory()); } catch (e) { return false; }
  const norm = new Set(subs.map(s => s.replace(/\s+/g, '').toLowerCase()));
  return need.every(n => norm.has(n));
}

const TYPE_LABEL_CN = { parts: '部件', texture: '涂装包', blueprint: '蓝图', dll: 'DLL', solar: '扩展包', packed: '压缩包', unknown: '未知' };
function typeLabel(type) {
  return tx('type_' + (type || 'unknown'), TYPE_LABEL_CN[type] || type || '');
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const dir = path.dirname(p);
  const base = path.basename(p, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base}_${i}${ext}`))) i++;
  return path.join(dir, `${base}_${i}${ext}`);
}

// ---------- 模组类型识别 ----------
function zipEntries(zipPath) {
  const zip = new (getAdmZip())(zipPath);
  return zip.getEntries().filter(e => !e.isDirectory);
}

function detectZipType(zipPath) {
  try {
    const entries = zipEntries(zipPath);
    const hasBp = entries.some(e => /(^|\/)blueprints\//i.test(entryNameOf(e)));
    if (hasBp) return 'blueprint';
    const hasTex = entries.some(e => /(^|\/)textures\//i.test(entryNameOf(e)));
    if (hasTex) return 'texture';
    if (entries.some(e => /\.pack$/i.test(path.basename(entryNameOf(e))))) return 'parts';
    if (entries.some(e => /\.dll$/i.test(path.basename(entryNameOf(e))))) return 'dll';
    return 'unknown';
  } catch (e) { return 'unknown'; }
}

// ---------- 模组部署 ----------
async function deployModFile(zipPath, type) {
  return fsTask('deploy', { zipPath, type, dataDir: sfsDataDir() });
}

// ---------- 原生界面文案（托盘 / 文件对话框 / 导出文件）----------
// 文案由渲染层按当前语言推送，主进程不维护英文；未收到推送时（窗口尚未创建）退回内置中文，
// 保证托盘在启动最早期也能正常显示，推送到达后再刷新。
let TXT = {};
function tx(key, fallback, a, b, c) {
  let s = TXT[key];
  if (s == null || s === '') s = fallback;
  if (s == null) return key;
  const args = [a, b, c];
  return String(s).replace(/\{(\d)\}/g, (m, n) => {
    const v = args[Number(n) - 1];
    return v == null ? '' : String(v);
  });
}

function applyTrayTexts(t) {
  if (!t || t.isDestroyed()) return;
  try { t.setToolTip(tx('trayTip', 'SFS 启动器')); } catch (e) {}
  try {
    t.setContextMenu(Menu.buildFromTemplate([
      { label: tx('trayShow', '显示主界面'), click: () => showMainWindow() },
      { type: 'separator' },
      { label: tx('trayQuit', '退出'), click: () => quitApp() }
    ]));
  } catch (e) {}
}

// ---------- 系统托盘 ----------
let tray = null;
function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const bindTray = (t) => {
    t.on('click', () => showMainWindow());
    applyTrayTexts(t);
  };
  // 托盘图标固定用产品图标（与桌面快捷方式、任务栏同源）。之前优先取 process.execPath 的图标，
  // 开发态那是 electron.exe，托盘会变成 Electron 的蓝球；打包态才正常，两头不一致。
  try {
    const img0 = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'assets', 'app-icon.ico'));
    if (!img0.isEmpty()) { tray = new Tray(img0); bindTray(tray); return; }
  } catch (e) {}
  // 图标文件缺失时退回 exe 自带图标，保证托盘不空
  app.getFileIcon(process.execPath, { size: 'large' })
    .then(ic => {
      if (ic.isEmpty()) return;
      if (tray && !tray.isDestroyed()) tray.setImage(ic);
      else { tray = new Tray(ic); bindTray(tray); }
    })
    .catch(() => {});
}

// 托盘在登录早期资源管理器/任务栏未就绪时可能创建失败，定时复检直到建成（最多约 12 秒）
let _trayTries = 0;
function ensureTray() {
  try { if (tray && !tray.isDestroyed()) return; } catch (e) {}
  if (_trayTries++ >= 6) return;
  createTray();
  setTimeout(ensureTray, 2000);
}

// 渲染层推送原生界面文案（切语言时会再推一次）
ipcMain.handle('app:set-texts', (_e, bundle) => {
  TXT = (bundle && typeof bundle === 'object' && !Array.isArray(bundle)) ? bundle : {};
  try { if (tray && !tray.isDestroyed()) applyTrayTexts(tray); } catch (e) {}
  return { success: true };
});
// 开机自启（--hidden）延迟建窗：等桌面 / DWM / 显卡就绪；期间被唤起则立即建窗并强制显示
let hiddenCreateTimer = null;
let forceShowNext = false;
let windowWantedVisible = false; // 本次窗口完成首帧后是否应当可见（唤起早于 ready-to-show 时用于裁决）
function flushHiddenWindowCreation(forceShow) {
  if (hiddenCreateTimer !== null) { clearTimeout(hiddenCreateTimer); hiddenCreateTimer = null; }
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (forceShow) forceShowNext = true;
    try { createWindow(); } catch (e) {}
    return true;
  }
  return false;
}

// ---------- 开机自启（隐藏到托盘常驻），用于手动开游戏自动唤起 ----------
function syncLoginItem(enable) {
  try {
    // 开发模式（process.execPath 为 node_modules 内裸 electron.exe）绝不写开机自启，避免污染注册表
    if (!app.isPackaged) return;
    // 直接经 Win32 Unicode API 写 HKCU\...\Run：打包后的 Electron 用 child_process 调 reg.exe 时，
    // 含引号/中文/长路径的命令行会被 reg.exe 判为“无效语法”（开发宿主不复现），故改走 win-reg（koffi/advapi32）。
    // 键名沿用 Electron 约定 electron.app.<productName>，值为 '"exe" --hidden'：登录时以隐藏模式启动，
    // 由延迟建窗 + 托盘/双击/游戏守望唤起，避免开机早期首窗被硬建而打不开。
    const valName = 'electron.app.' + app.getName();
    const winReg = require('./win-reg');
    if (enable) {
      // 便携版 process.execPath 位于 %TEMP% 解压目录（重启失效），自启指向便携 exe 真实稳定位置；安装版即 process.execPath
      const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      winReg.setRunValue(valName, '"' + target + '" --hidden');
    } else {
      winReg.deleteRunValue(valName);
    }
  } catch (e) {}
}

// ---------- 真正退出（绕过关闭询问与托盘最小化） ----------
let appQuiting = false;
function quitApp() {
  appQuiting = true;
  try { if (hiddenCreateTimer !== null) { clearTimeout(hiddenCreateTimer); hiddenCreateTimer = null; } } catch (e) {}
  try { app.quit(); } catch (e) {}
}
function showMainWindow() {
  const createdNow = flushHiddenWindowCreation(true); // 开机延迟期被唤起：立即建窗并强制显示
  windowWantedVisible = true; // 任何唤起都表示期望窗口可见；即使窗口刚 new、首帧未就绪，ready-to-show 也会据此显示而非隐藏
  if (createdNow) return;                            // 新窗将在 ready-to-show 自行显示并聚焦
  if (!mainWindow || mainWindow.isDestroyed()) { try { forceShowNext = true; createWindow(); } catch (e) {} return; }
  try { if (typeof mainWindow.getOpacity === 'function' && mainWindow.getOpacity() === 0) mainWindow.setOpacity(1); } catch (e) {}
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // 二次兜底：未完成首帧合成的窗口首次 show() 偶发不生效，短延时复检，仍不可见则补一次
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.setOpacity(1);
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {}
  }, 350);
  try {
    // 从托盘/游戏守望唤起：隐藏期间未施材质，显示后立即补一次，避免透明窗发黑或不透明
    const layeredNow = !isWin11 && (glassState.mode === 'dwm' || glassState.mode === 'aero');
    if (layeredNow) reapplyDwmOnly(true); else applyWindowGlass();
  } catch (e) {}
}

// ---------- 全局游戏进程守望：手动打开游戏时唤起已在托盘的启动器 ----------
// 用 koffi 进程快照在内存里枚举（毫秒级、无子进程），替代旧的 tasklist / PowerShell 轮询。
let _winProc = null;
function winProc() {
  if (_winProc === null) {
    try { _winProc = require('./win-proc.js'); } catch (e) { _winProc = false; }
  }
  return _winProc || null;
}
// 守望目标：所有已添加实例的 exe 名 + 官方默认名
function watchProcNames() {
  const names = ['Spaceflight Simulator'];
  try {
    const c = loadConfig();
    for (const inst of (c.instances || [])) {
      if (inst && inst.exePath) {
        const b = path.basename(inst.exePath).replace(/\.exe$/i, '');
        if (b) names.push(b);
      }
    }
  } catch (e) {}
  return names;
}
function isGameProcessRunning() {
  const w = winProc();
  if (!w) return false;
  try { return w.processRunning(watchProcNames()); } catch (e) { return false; }
}
let globalWatchTimer = null;
let globalGameSeen = false;
// 仅在“手动开游戏自动唤起”开启时轮询（4 秒），关闭即停，不做空转检测。
// 外部启动（Steam / 双击 exe / 桌面快捷方式）时补挂崩溃监视的钩子：registerIpc 内注入实现。
let onExternalGameStarted = null;
function setGlobalGameWatch(on) {
  if (on && globalWatchTimer === null) {
    globalGameSeen = false;
    globalWatchTimer = setInterval(() => {
      try {
        const cfg = loadConfig();
        if (!cfg || cfg.autoOpenWithGame === false) { globalGameSeen = false; return; }
        const running = isGameProcessRunning();
        if (running && !globalGameSeen) {
          globalGameSeen = true;
          showMainWindow();
          // 非启动器拉起的情况（Steam、双击 exe）也要挂崩溃监视，否则这条路径永远不检测崩溃
          try { if (typeof onExternalGameStarted === 'function') onExternalGameStarted(); } catch (e) {}
        }
        else if (!running) { globalGameSeen = false; }
      } catch (e) {}
    }, 4000);
  } else if (!on && globalWatchTimer !== null) {
    clearInterval(globalWatchTimer);
    globalWatchTimer = null;
  }
}

// ---------- 主窗口 ----------
let mainWindow = null;
let recreating = false;     // 毛玻璃切换导致的销毁重建
let pendingBounds = null;   // 重建时保留窗口位置与尺寸
let recreateOldWin = null;          // 无缝重建：暂存旧窗，新窗就绪显示后再销毁
let pendingGlassTransition = false; // 本次建窗为毛玻璃开关重建（新窗首帧盖过渡遮罩）
let bootReveal = null;              // 当前窗口的"内容就绪后显示"回调，由 createWindow 绑定

// ---------- 毛玻璃应用（Win11 系统 acrylic / Win10 DWM 亚克力或 Aero） ----------
const glassState = { enabled: false, theme: 'dark', mode: 'off' };
function solidColorForTheme() {
  const c = require('./glass-config').solidColor;
  return glassState.theme === 'light' ? c.light : c.dark;
}
function dwmStateFor(mode) { return mode === 'aero' ? 3 : 4; }
function applyWindowGlass() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const mode = glassState.mode;
    if (mode === 'off' || glassState.enabled === false) {
      const d = dwmGlass();
      if (d) { try { d.apply(mainWindow.getNativeWindowHandle(), { enabled: false }); } catch (e) {} }
      try { mainWindow.setBackgroundColor(solidColorForTheme()); } catch (e) {}
      return false;
    }
    if (mode === 'acrylic') {
      // Win11：材质在创建窗口时由 backgroundMaterial 指定，这里只保证透明底色让材质透出
      try { mainWindow.setBackgroundColor('#00000000'); } catch (e) {}
      return true;
    }
    // Win10 分层透明窗：state4 亚克力 / state3 Aero，tint 跟随深浅主题
    const d = dwmGlass();
    // 透明底已在建窗时给定，此处不得再 setBackgroundColor（会产生裸透单帧闪烁），只提交 DWM 材质属性。
    if (d) {
      const ok = d.apply(mainWindow.getNativeWindowHandle(), {
        enabled: true, theme: glassState.theme, build: winBuildNum, state: dwmStateFor(mode)
      });
      if (ok) { glassDwmAppliedKey = mode + '|' + glassState.theme; glassDwmAppliedAt = Date.now(); }
      return ok;
    }
    return false;
  } catch (e) { return false; }
}
let glassReapplyTimer = null;
function scheduleGlassReapply(delay, source, force) {
  if (glassState.mode !== 'dwm' && glassState.mode !== 'aero') return;
  if (glassReapplyTimer) clearTimeout(glassReapplyTimer);
  glassReapplyTimer = setTimeout(() => { reapplyDwmOnly(!!force); }, delay || 120);
}
// 拖动 / 缩放过程中分层窗 DWM 材质可能瞬时丢失，节流重施，停止后补一次，避免黑/白边。
let glassGeoTrail = null;
let glassDwmAppliedKey = '', glassDwmAppliedAt = 0;
function reapplyDwmOnly(force) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (glassState.mode !== 'dwm' && glassState.mode !== 'aero') return;
  const d = dwmGlass(); if (!d) return;
  const key = glassState.mode + '|' + glassState.theme;
  const nowTs = Date.now();
  // 开窗瞬间 geo/ready2show/show/ipc 会在数百毫秒内连发同一材质；短窗去重，
  // 真正持续的拖动/缩放会越过 300ms 窗，force 用于几何突变与停止后的兜底补全。
  if (!force && glassDwmAppliedKey === key && nowTs - glassDwmAppliedAt < 300) return;
  try {
    // 透明底在建窗时已给定；这里只幂等重提 DWM 材质属性。
    // 绝不能再 setBackgroundColor('#00000000')：那会重置透明合成表面，产生一帧无材质裸透，表现为玻璃开/关闪烁。
    const ok = d.apply(mainWindow.getNativeWindowHandle(), {
      enabled: true, theme: glassState.theme, build: winBuildNum, state: dwmStateFor(glassState.mode)
    });
    if (ok) { glassDwmAppliedKey = key; glassDwmAppliedAt = nowTs; }
  } catch (e) {}
}
// 移动窗口时 DWM 亚克力由系统自动跟随，绝不能在 move 里重设材质：拖动期间每帧重提
// ACCENT 属性会打断 DWM 合成，表现为窗口跟手延迟、拖影。仅在尺寸缩放停止后补一次，
// 兜底边缘材质刷新（移动不触发）。
function onGlassResize() {
  if (glassState.mode !== 'dwm' && glassState.mode !== 'aero') return;
  if (glassGeoTrail) clearTimeout(glassGeoTrail);
  glassGeoTrail = setTimeout(() => { reapplyDwmOnly(true); }, 180);
}
// 一次性直接指定 DWM AccentState（3=Aero / 4=亚克力），仅用于中档机拖动开始/结束的两次材质切换。
// 不重建窗口、不改透明底色（state3/state4 同为分层窗），故无裸透闪烁；全程只调两次、不是每帧重提，不会拖影。
function applyDwmStateOnce(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const d = dwmGlass(); if (!d) return;
  try { d.apply(mainWindow.getNativeWindowHandle(), { enabled: true, theme: glassState.theme, build: winBuildNum, state }); } catch (e) {}
}
// 中档机拖动亚克力窗降级：连续两次 move（间隔<120ms）才判定为真拖动（避开单次程序化 setBounds/还原），
// 判定后一次性降到更廉价的 Aero；停止 move 150ms 后一次性恢复亚克力。弱机已全程 Aero、强机不降级，均不进入。
let _dragLastAt = 0, _dragHits = 0, _dragLite = false, _dragRestoreT = null, _dragTier = null;
let _moveLastAt = 0, _dragNotified = false, _dragNotifyT = null;
function onGlassMove() {
  // 通用拖动检测（不分材质/系统）：连续两帧 move(<120ms) 判定拖动，通知渲染端暂停内嵌 webview 渲染。
  // 弱机首页内嵌网页是 GPU/CPU 大头，拖动时它仍在持续合成是跟手延迟的主因；停止 180ms 后恢复。
  const now = Date.now();
  if (_moveLastAt && now - _moveLastAt < 120) {
    if (!_dragNotified) { _dragNotified = true; try { mainWindow.webContents.send('window:dragging', true); } catch (e) {} }
  }
  _moveLastAt = now;
  if (_dragNotifyT) clearTimeout(_dragNotifyT);
  _dragNotifyT = setTimeout(() => {
    if (_dragNotified) { _dragNotified = false; try { mainWindow.webContents.send('window:dragging', false); } catch (e) {} }
  }, 180);

  if (isWin11) return;
  if (!glassState.enabled || glassState.mode !== 'dwm') return; // weak 档全程 Aero(state3)：直接返回，移动期间零 DWM 调用、零读盘
  if (now - _dragLastAt >= 120) { _dragHits = 1; _dragLastAt = now; _dragTier = null; return; } // 一串 move 的第一帧：只计数，不读盘不降级
  _dragLastAt = now;
  _dragHits++;
  if (_dragHits < 2) return;
  // 档位在这一串拖动内只在判定帧读一次配置并缓存（move 高频触发，严禁每帧同步读/解析约 160KB 配置，否则拖动掉帧）
  if (_dragTier === null) {
    _dragTier = 'medium';
    try { _dragTier = perfTier(loadConfig()); } catch (e) {}
  }
  if (_dragTier === 'strong') return; // 独显强机亚克力拖动不降级；weak/medium 拖动都临时降到廉价 Aero
  if (!_dragLite) { _dragLite = true; applyDwmStateOnce(3); } // 拖动开始：一次性降到廉价 Aero
  if (_dragRestoreT) clearTimeout(_dragRestoreT);
  _dragRestoreT = setTimeout(() => {
    _dragRestoreT = null; _dragHits = 0; _dragTier = null;
    if (_dragLite) { _dragLite = false; applyDwmStateOnce(4); } // 停止拖动：一次性恢复亚克力
  }, 150);
}
// 首窗加载完成后异步探测 GPU（不阻塞启动）：基础渲染驱动→weak，Intel 集显→封顶 medium，独显不封顶。
// 结果持久化、只探测一次；若因此改变当前材质（如基础渲染驱动 dwm→aero），dwm/aero 同为分层窗可当场
// 无缝切换并通知渲染端换材质类；仅封顶 medium（强机集显）时静态材质不变，只激活拖动降级策略。
let _gpuProbed = false;
function probeGpuTier() {
  if (isWin11 || _gpuProbed) return;
  _gpuProbed = true;
  try {
    const wc = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents : null;
    if (!wc || typeof wc.getGPUInfo !== 'function') return;
    Promise.resolve(wc.getGPUInfo('hardware')).then((info) => {
      try {
        const cfg = loadConfig();
        if (cfg.gpuTierProbed) return;
        let renderer = '';
        try { renderer = String((info && info.auxAttributes && info.auxAttributes.glRenderer) || ''); } catch (e) {}
        if (!renderer) { try { renderer = JSON.stringify((info && info.gpuDevice) || []); } catch (e) {} }
        renderer = renderer.toLowerCase();
        let cap = null;
        if (/microsoft basic|basic render|render driver/.test(renderer)) cap = 'weak';
        else if (/intel\(r\)\s*(hd|uhd|iris)|intel\(r\)[^)]*(graphics)/.test(renderer)) cap = 'medium';
        if (cap) {
          cfg.gpuTierCap = cap;
          cfg.gpuTierProbed = true;
          saveConfig(cfg);
          applyGpuTierCap();
        } else if (renderer.length > 4) {
          cfg.gpuTierProbed = true; // 独显等无需封顶：标记已探测，避免每次启动都查询
          saveConfig(cfg);
        }
      } catch (e) {}
    }).catch(() => {});
  } catch (e) {}
}
function applyGpuTierCap() {
  if (isWin11) return;
  const before = glassState.mode;
  const target = glassModeFor(loadConfig());
  if (target === before || !glassState.enabled) return;
  glassState.mode = target;
  applyWindowGlass();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('glass:mode-changed', { mode: target }); } catch (e) {}
  }
}
// 毛玻璃开关会改变窗口分层透明 / 系统材质属性（只能创建时设定）。
// 无缝重建：先在后台建好新窗（首帧盖不透明遮罩），就绪显示后再销毁被遮住的旧窗，
// 避免“先销毁旧窗、新窗尚未出现”期间露出后方桌面。
function recreateWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  // 重建进行中：禁止再次创建，避免旧窗口引用丢失、窗口泄漏
  if (recreating) return;
  try { pendingBounds = mainWindow.getBounds(); } catch (e) { pendingBounds = null; }
  recreateOldWin = mainWindow;
  pendingGlassTransition = true;
  recreating = true;
  createWindow();
  // 兜底：3 秒后若重建状态仍未被 ready-to-show 正常清掉（极端加载异常），强制收尾，杜绝旧窗口残留
  setTimeout(() => {
    if (recreating) {
      try { if (recreateOldWin && !recreateOldWin.isDestroyed()) recreateOldWin.destroy(); } catch (e) {}
      recreateOldWin = null;
      recreating = false;
      pendingGlassTransition = false;
    }
  }, 3000);
}

function createWindow() {
  __tl('createWindow_start');
  const cfg0 = loadConfig();
  const b = pendingBounds || cfg0.winBounds || {};
  pendingBounds = null;
  // 毛玻璃开关重建出的新窗用于替换当前可见窗口，不受开机常驻 --hidden 影响，必须显示
  const startHidden = !forceShowNext && process.argv.includes('--hidden') && !pendingGlassTransition;
  forceShowNext = false;
  windowWantedVisible = !startHidden;
  // 初始材质与主题：决定窗口是否分层透明及首帧背景色（玻璃态全透明交给 DWM/系统材质，否则实色）
  const mode = glassModeFor(cfg0);
  const layered = !isWin11 && (mode === 'dwm' || mode === 'aero');
  glassState.enabled = mode !== 'off';
  glassState.mode = mode;
  glassState.theme = (cfg0.theme === 'light' || cfg0.theme === 'dark') ? cfg0.theme : resolveSystemTheme();
  // 过渡重建到 Win10 透明材质(dwm/aero)时：新窗先以不透明实色打底 show（窗口级硬遮罩，不依赖页面首帧合成），
  // ready-to-show 后等页面遮罩稳定上屏，再切透明并淡出遮罩，杜绝切换第一帧露出后方桌面/窗口。
  const opaqueHold = pendingGlassTransition === true && layered === true;
  const initBgColor = (mode !== 'off' && !opaqueHold) ? '#00000000' : solidColorForTheme();
  mainWindow = new BrowserWindow({
    width: b.width || 1440,
    height: b.height || 900,
    x: (typeof b.x === 'number') ? b.x : undefined,
    y: (typeof b.y === 'number') ? b.y : undefined,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'renderer', 'assets', 'app-icon.ico'),
    backgroundColor: initBgColor,
    // Win11 用系统 acrylic（普通窗即可）；Win10 亚克力/Aero 必须分层透明窗，
    // 普通窗会忽略 backgroundColor 的 alpha、材质透不出来。
    backgroundMaterial: (isWin11 && (mode === 'acrylic' || mode === 'mica')) ? mode : undefined,
    transparent: layered,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 最小化/被遮挡时降频：原来关掉节流，窗口隐藏后仍全速渲染，白占 CPU/GPU
      backgroundThrottling: true,
      paintWhenInitiallyHidden: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  // 主页面 window.open 一律拒绝，改为外部浏览器打开（避免弹出空白白窗口）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch (e) {} }
    return { action: 'deny' };
  });
  __tl('browserWindow_created');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  __tl('loadFile_called');
  // 首窗加载完成后异步探测一次 GPU，用于毛玻璃材质/拖动策略分档（内部有全局只跑一次守卫，不阻塞启动）
  mainWindow.webContents.once('did-finish-load', () => { try { probeGpuTier(); } catch (e) {} });
  if (__TIMING) { mainWindow.webContents.on('did-finish-load', () => { __tl('did_finish_load'); mainWindow.webContents.executeJavaScript('JSON.stringify(window.__BOOTR||{})').then(j => console.log('[BOOT] renderer_dfl=' + j)).catch(() => {}); setTimeout(() => { mainWindow.webContents.executeJavaScript('JSON.stringify(window.__BOOTR||{})').then(j => console.log('[BOOT] renderer_late=' + j)).catch(() => {}); }, 1500); }); }

  // 记住窗口大小与位置（移动/缩放/关闭时保存）
  const saveBounds = () => {
    try {
      if (mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
      const c = loadConfig();
      c.winBounds = mainWindow.getBounds();
      saveConfig(c);
    } catch (e) {}
  };
  let boundsTimer = null;
  const scheduleSaveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);
  // Win10 分层窗口：缩放停止后补一次材质；移动时材质由系统自动跟随，不逐帧重设（消除跟手延迟）。
  // 中档亚克力机另在拖动开始/结束各切一次廉价 Aero（onGlassMove 内部判定，弱机/强机直接返回）。
  mainWindow.on('resize', onGlassResize);
  mainWindow.on('move', onGlassMove);
  // 最大化 / 还原 / 显示等状态切换后重新施加
  mainWindow.on('restore', () => scheduleGlassReapply(60, 'restore', true));
  mainWindow.on('maximize', () => scheduleGlassReapply(60, 'maximize', true));
  mainWindow.on('unmaximize', () => scheduleGlassReapply(60, 'unmaximize', true));
  mainWindow.on('show', () => scheduleGlassReapply(120, 'show', true)); // 隐藏后重新显示是材质恢复关键时机，强制重施，不被短窗去重误杀
  // 关闭行为：按设置 直接退出 / 最小化到托盘 / 每次询问（记住选择后不再问）
  mainWindow.on('close', (e) => {
    if (recreating) return; // 毛玻璃切换触发的销毁重建：直接放行，不弹询问、不拦截
    saveBounds();
    if (appQuiting || isSmoke) return;
    const action = loadConfig().closeAction || 'ask';
    if (action === 'quit') { appQuiting = true; return; }
    if (action === 'tray') { e.preventDefault(); mainWindow.hide(); return; }
    e.preventDefault();
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.webContents.send('close:prompt');
    } catch (err) {
      mainWindow.hide();
    }
  });
  // ── 首次显示时机：等渲染端首批内容落地，不要在空玻璃上先亮一帧 ──
  // ready-to-show 只代表首帧画出来了，此时壁纸/玻璃材质还在逐层铺，实例数据也在等 IPC，
  // 合起来就是用户看到的"只有毛玻璃、一个字都没有"。改由渲染端 ui:ready 决定，3 秒兜底强制显示。
  let bootShowPending = false;
  let bootShowTimer = null;
  function scheduleBootShow() {
    bootShowPending = true;
    if (bootShowTimer) clearTimeout(bootShowTimer);
    bootShowTimer = setTimeout(() => { revealBootWindow('timeout'); }, 3000);
  }
  function revealBootWindow(why) {
    if (!bootShowPending) return;
    bootShowPending = false;
    if (bootShowTimer) { clearTimeout(bootShowTimer); bootShowTimer = null; }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (startHidden && !windowWantedVisible) return;
    try {
      mainWindow.show(); __tl('window_shown_' + why);
      if (!isSmoke) mainWindow.focus();
      if (!layered) applyWindowGlass();
      // 开机首启时系统玻璃可能还没就绪：显示后分三次复核材质，失败就让渲染端垫实色底，成功再撤掉
      [1000, 3000, 8000].forEach(ms => setTimeout(() => reportGlassMaterial(probeGlassMaterial()), ms));
    } catch (e) {}
  }
  // 复核当前系统玻璃是否真的挂上了。Win10 分层窗看 DWM apply 的返回值；
  // Win11 的亚克力/云母在创建窗口时由系统指定，查不到状态，按成功处理，避免误判成故障垫底。
  function probeGlassMaterial() {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      if (glassState.enabled === false || glassState.mode === 'off') return true;
      if (glassState.mode === 'acrylic' || glassState.mode === 'mica') return true;
      const d = dwmGlass();
      if (!d) return false;
      return d.apply(mainWindow.getNativeWindowHandle(), {
        enabled: true, theme: glassState.theme, build: winBuildNum, state: dwmStateFor(glassState.mode)
      }) === true;
    } catch (e) { return false; }
  }
  function reportGlassMaterial(ok) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.send('glass:material-result', { ok: ok === true, mode: glassState.mode }); } catch (e) {}
  }
  bootReveal = revealBootWindow;

  // 首帧就绪后再显示，避免无框透明亚克力窗口在内容未就绪时进入合成竞态（白屏/卡住）
  // --hidden（开机常驻后台）时保持不显示，由托盘点击或游戏守望唤起
  mainWindow.once('ready-to-show', () => {
    __tl('ready_to_show');
    if (startHidden && !windowWantedVisible) {
      try { mainWindow.hide(); } catch (e) {}
      return;
    }
    {
      try {
        // opaqueHold（createWindow 计算）：过渡到 Win10 透明材质时新窗先不透明 show，此处不上 DWM，改由下方延时切换；其余情况 show 前上材质。
        if (layered && !opaqueHold) reapplyDwmOnly(true);
        if (pendingGlassTransition) {
          // 重建窗口：旧窗在等着销毁，必须立刻显示，不能等内容就绪
          mainWindow.show(); __tl('window_shown');
          if (!isSmoke) mainWindow.focus();
          if (!layered) applyWindowGlass();
        } else {
          // 首次/普通启动：等渲染端首批内容落地再显示，避免屏幕上先亮出一块只有玻璃的空窗
          scheduleBootShow();
        }
        if (pendingGlassTransition && recreateOldWin && !recreateOldWin.isDestroyed()) {
          const oldWin = recreateOldWin;
          recreateOldWin = null;
          if (opaqueHold) {
            // 新窗以不透明实色 show 已完全遮住旧窗；等页面遮罩稳定上屏，再销毁旧窗、切透明材质（遮罩仍满屏不透明），随即淡出遮罩溶入玻璃。
            setTimeout(() => {
              try { if (oldWin && !oldWin.isDestroyed()) oldWin.destroy(); } catch (e) {}
              // 不透明背景创建的分层窗必须显式把根表面改回全透明，再上 DWM 材质，亚克力才透得出来；
              // 此刻页面 .glass-mask 仍满屏不透明顶住切换帧，下一行才通知淡出，故不会露出后方。
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor('#00000000'); } catch (e) {}
              try { reapplyDwmOnly(true); } catch (e) {}
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('glass:transition-fade'); } catch (e) {}
              setTimeout(() => { recreating = false; pendingGlassTransition = false; }, 420);
            }, 160);
          } else {
            // 关闭方向（新窗本身不透明）或 Win11：延时销毁旧窗并淡出遮罩；遮罩与实色同色，观感无跳变。
            setTimeout(() => {
              try { if (oldWin && !oldWin.isDestroyed()) oldWin.destroy(); } catch (e) {}
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('glass:transition-fade'); } catch (e) {}
              setTimeout(() => { recreating = false; pendingGlassTransition = false; }, 360);
            }, 200);
          }
        } else {
          pendingGlassTransition = false;
        }
      } catch (e) {
        // 异常时也必须销毁旧窗口，否则旧窗口引用丢失、永久泄漏成"幽灵窗口"
        try { if (recreateOldWin && !recreateOldWin.isDestroyed()) recreateOldWin.destroy(); } catch (_) {}
        recreateOldWin = null;
        recreating = false; pendingGlassTransition = false;
      }
    }
  });

  if (isSmokeWP) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const capDir = path.join(process.cwd(), '_caps_wp');
        try { fs.mkdirSync(capDir, { recursive: true }); } catch (e) {}
        const shot = async (name) => {
          try {
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(capDir, name + '.png'), img.toPNG());
            console.log('SMOKE_WP_CAP ' + name);
          } catch (e) { console.log('SMOKE_WP_FAIL ' + name + ' ' + e.message); }
        };
        try {
          await mainWindow.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="settings"]').click(); true;`);
          await new Promise(r => setTimeout(r, 2600));
          await shot('light-1');
          try {
            const probe = await mainWindow.webContents.executeJavaScript(`(() => {
              const cs = getComputedStyle(document.body);
              const c = document.querySelector('.content');
              const sb = document.querySelector('.sidebar');
              const w = document.getElementById('liuli-wallpaper');
              return JSON.stringify({
                theme: document.documentElement.dataset.theme,
                htmlCls: document.documentElement.className,
                bodyCls: document.body.className,
                bg: cs.getPropertyValue('--bg').trim(),
                liuliOpacity: cs.getPropertyValue('--liuli-opacity').trim(),
                acrylicLow: cs.getPropertyValue('--ll-acrylic-low').trim(),
                contentBg: getComputedStyle(c).backgroundColor,
                contentOpacity: getComputedStyle(c).opacity,
                sidebarBg: getComputedStyle(sb).backgroundColor,
                wpImg: w ? w.style.backgroundImage.slice(0, 90) : null,
                wpFilter: w ? w.style.filter : null,
                wpDisplay: w ? w.style.display : null
              });
            })()`);
            console.log('SMOKE_WP_PROBE ' + probe);
          } catch (e) { console.log('SMOKE_WP_PROBE_ERR ' + e.message); }
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#theme-capsule .seg-option[data-value="dark"]').click(); true;`);
          await new Promise(r => setTimeout(r, 3200));
          await shot('dark');
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#theme-capsule .seg-option[data-value="light"]').click(); true;`);
          await new Promise(r => setTimeout(r, 3200));
          await shot('light-2');
          // 验证琉璃参数滑块链路：模拟把参数调到极端值，确认 CSS 变量与壁纸层真的跟着动
          await mainWindow.webContents.executeJavaScript(`LiuliTheme.applyParams({ opacity: 0.85, glow: 0.4, blur: 20, veil: 0.6 }); true;`);
          await new Promise(r => setTimeout(r, 1200));
          await shot('light-tuned');
          try {
            const p2 = await mainWindow.webContents.executeJavaScript(`JSON.stringify({
              op: getComputedStyle(document.body).getPropertyValue('--liuli-opacity').trim(),
              glow: getComputedStyle(document.body).getPropertyValue('--liuli-glow').trim(),
              contentBg: getComputedStyle(document.querySelector('.content')).backgroundColor,
              wpFilter: document.getElementById('liuli-wallpaper').style.filter
            })`);
            console.log('SMOKE_WP_TUNED ' + p2);
          } catch (e) { console.log('SMOKE_WP_TUNED_ERR ' + e.message); }
        } catch (e) { console.log('SMOKE_WP_ERR ' + e.message); }
        console.log('SMOKE_WP_OK');
        app.exit(0);
      }, 5000);
    });
  }

  if (isSmoke && !isSmokeWP && !isSmokeLive) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const capDir = path.join(process.cwd(), '_caps');
        try { fs.mkdirSync(capDir, { recursive: true }); } catch (e) {}
        const views = ['home', 'mods', 'modstore', 'blueprint', 'saves', 'settings'];
        // 先预热商店数据：首次请求常因 TLS/DNS 冷启动挂住，预热失败就重试，避免两轮截图一浅一深状态不一致
        for (let k = 0; k < 3; k++) {
          try {
            const n = await mainWindow.webContents.executeJavaScript(`loadModstore().then(() => document.querySelectorAll('.ms-card').length)`);
            console.log('SMOKE_STORE ' + k + ' cards=' + n);
            if (n > 0) break;
          } catch (e) { console.log('SMOKE_STORE_ERR ' + e.message); }
        }
        for (const theme of ['light', 'dark']) {
          try {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="settings"]').click(); true;`);
            await new Promise(r => setTimeout(r, 900));
            await mainWindow.webContents.executeJavaScript(`document.querySelector('#theme-capsule .seg-option[data-value="${theme}"]').click(); true;`);
            await new Promise(r => setTimeout(r, 2200));
            const th = await mainWindow.webContents.executeJavaScript(`document.documentElement.getAttribute('data-theme')`);
            console.log('SMOKE_THEME ' + theme + ' -> ' + th);
          } catch (e) { console.log('SMOKE_THEME_FAIL ' + theme + ' ' + e.message); }
          for (const v of views) {
            try {
              await mainWindow.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="${v}"]').click(); true;`);
              await new Promise(r => setTimeout(r, v === 'modstore' ? 4000 : 1500));
              if (v === 'modstore') {
                // 商店列表走网络，等加载态结束再截图，避免截到 spinner
                for (let k = 0; k < 40; k++) {
                  const busy = await mainWindow.webContents.executeJavaScript(`!!document.querySelector('.ms-loading')`);
                  if (!busy) break;
                  await new Promise(r => setTimeout(r, 1000));
                }
              }
              if (v === 'blueprint') {
                // 展开蓝图目录用于截图，折叠态下内容区几乎空白
                for (let k = 0; k < 3; k++) {
                  await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('.bp-dir.collapsed').forEach(r => r.click()); true;`);
                  await new Promise(r => setTimeout(r, 600));
                }
              }
              const img = await mainWindow.webContents.capturePage();
              fs.writeFileSync(path.join(capDir, theme + '-' + v + '.png'), img.toPNG());
              console.log('SMOKE_CAP ' + theme + '-' + v);
            } catch (e) { console.log('SMOKE_CAP_FAIL ' + theme + '-' + v + ' ' + e.message); }
          }
        }
        console.log('SMOKE_OK');
        app.exit(0);
      }, 4000);
    });
  }

}

// ---------- 下载捕获 ----------
let activeDownloads = [];
let dlSeq = 0;
function setupDownloadCapture() {
  const sess = session.fromPartition('persist:sfs');
  sess.on('will-download', (event, item) => {
    const url = item.getURL();
    const name = item.getFilename();
    if (!/\.(zip|pack|pck|dll|txt|json)$/i.test(name)) return;
    // 下载目录：设置里有就用设置的，没有则默认系统下载文件夹；不弹另存为
    const cfg = loadConfig();
    let dlDir = (cfg.downloadDir && fs.existsSync(cfg.downloadDir))
      ? cfg.downloadDir
      : app.getPath('downloads');
    try { fs.mkdirSync(dlDir, { recursive: true }); } catch (e) { dlDir = app.getPath('downloads'); }
    // 同名文件自动加序号，避免覆盖
    let saveName = name, dn = 1;
    while (fs.existsSync(path.join(dlDir, saveName))) {
      const dot = name.lastIndexOf('.');
      saveName = dot > 0 ? name.slice(0, dot) + ' (' + dn + ')' + name.slice(dot) : name + ' (' + dn + ')';
      dn++;
    }
    item.setSavePath(path.join(dlDir, saveName));
    const id = ++dlSeq;
    const rec = { id, name, pct: 0, recv: 0, total: 0, state: 'progressing', item, savePath: '' };
    activeDownloads.push(rec);
    // 进度事件
    item.on('updated', () => {
      rec.recv = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.pct = rec.total ? Math.round(rec.recv / rec.total * 100) : 0;
      rec.state = item.isPaused() ? 'paused' : 'progressing';
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('download:progress', { id, name, recv: rec.recv, total: rec.total, pct: rec.pct, state: rec.state });
    });
    item.once('done', async (e, state) => {
      rec.state = state;
      rec.savePath = item.getSavePath();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:done', { id, name, state, savePath: rec.savePath });
      }
      if (state !== 'completed') return;
      try {
        const savePath = item.getSavePath();
        const cfg2 = loadConfig();
        if (!cfg2.mods.pending.some(p => p.path === savePath)) {
          cfg2.mods.pending.unshift({
            path: savePath,
            name: name,
            type: await fsTask('detectType', { zipPath: savePath }),
            addedAt: Date.now(),
            fromUrl: url
          });
          saveConfig(cfg2);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mods:changed');
        }
      } catch (err) { /* 忽略 */ }
    });
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('config:load', () => loadConfig());
  ipcMain.handle('config:save', (_e, cfg) => { saveConfig(cfg); return true; });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), configPath: CONFIG_PATH, glassMode: glassModeFor(loadConfig())
  }));

  // 系统信息（Win 版本号，用于材质兼容判断）
  ipcMain.handle('system:info', () => {
    const os = require('os');
    const release = os.release();
    const build = parseInt(release.split('.')[2] || '0', 10);
    const win11 = build >= 22000;
    // 仅按版本号给亚克力(state4)的系统前提，真实 DWM/远程桌面/透明开关能力在应用时再兜底，
    // 避免在未开玻璃时就因能力检测加载 koffi。
    const canDwm = win11 || build >= 17134;
    let tier = 'medium';
    try { tier = perfTier(loadConfig()); } catch (e) { tier = 'medium'; }
    return {
      winBuild: build,
      isWin11: win11,
      platform: process.platform,
      tier,
      canDwm
    };
  });

  // 打开日志目录
  ipcMain.handle('log:openDir', () => {
    const { shell } = require('electron');
    const logDir = require('path').join(app.getPath('userData'), 'logs');
    shell.openPath(logDir);
    return { success: true, path: logDir };
  });

  // ---------- 汉化：启动器直接装运行时 Mod + 词表 ----------
  // 之前是把 SFSChineseInjector.exe 拉起来让用户手动点；现在按它的落盘结构直接安装：
  //   Mods/SFSHanRuntime/{SFSHanRuntime.dll, NotoSansSC-Bold.ttf, dict.json, chars.txt}
  //   Spaceflight Simulator_Data/Custom Translations/简体中文（汉化）.txt
  //   Saving/Settings/LanguageSettings_2.txt -> {"CodeName":"简体中文（汉化）","Custom":true}
  // 资源来自注入器 payload（作者 Arctic.，仓库 Arctic-Ice67/SFSChineseInjector），
  // 许可证为 PolyForm Strict 1.0.0，随包分发前需作者书面授权；未授权时不要打包 assets/han。
  const HAN_LANG_NAME = '简体中文（汉化）';
  function hanAsset(rel) {
    const dev = path.join(__dirname, 'assets', 'han', rel);
    if (fs.existsSync(dev)) return dev;
    const packed = path.join(process.resourcesPath || '', 'han', rel);
    return fs.existsSync(packed) ? packed : '';
  }
  function hanLayout(instId) {
    const cfg = loadConfig();
    const inst = (cfg.instances || []).find(i => i.id === instId) ||
      (cfg.instances || []).find(i => i.current) || (cfg.instances || [])[0];
    const root = (inst && inst.installDir) || '';
    const exe = (inst && inst.exePath) || '';
    const dataDir = exe ? path.join(path.dirname(exe), path.basename(exe, '.exe') + '_Data') : '';
    return {
      inst,
      root,
      dataDir,
      mods: root ? path.join(root, 'Mods') : '',
      settings: root ? path.join(root, 'Saving', 'Settings') : '',
      custom: dataDir ? path.join(dataDir, 'Custom Translations') : '',
      runtime: root ? path.join(root, 'Mods', 'SFSHanRuntime') : '',
      translation: dataDir ? path.join(dataDir, 'Custom Translations', HAN_LANG_NAME + '.txt') : '',
      state: root ? path.join(root, 'Saving', 'Settings', 'SFSHanInjector.json') : '',
      valid: !!(root && dataDir && fs.existsSync(root) && fs.existsSync(dataDir))
    };
  }
  function readHanState(l) {
    try { return JSON.parse(fs.readFileSync(l.state, 'utf8')); } catch (e) { return null; }
  }
  ipcMain.handle('han:status', (_e, instId) => {
    const l = hanLayout(instId);
    const st = l.valid ? readHanState(l) : null;
    const runtimeReady = !!(l.valid &&
      fs.existsSync(path.join(l.runtime, 'SFSHanRuntime.dll')) &&
      fs.existsSync(path.join(l.runtime, 'dict.json')) &&
      fs.existsSync(path.join(l.runtime, 'chars.txt')) &&
      fs.existsSync(path.join(l.runtime, 'NotoSansSC-Bold.ttf')));
    const translationReady = !!(l.valid && fs.existsSync(l.translation));
    let lang = null;
    try { lang = JSON.parse(fs.readFileSync(path.join(l.settings, 'LanguageSettings_2.txt'), 'utf8')); } catch (e) {}
    return {
      success: true,
      valid: l.valid,
      gameDir: l.root,
      dataDir: l.dataDir,
      running: isGameProcessRunning(),
      installed: !!(runtimeReady || translationReady),
      runtimeReady,
      translationReady,
      language: (lang && lang.CodeName) || '',
      assetsReady: !!(hanAsset('runtime/SFSHanRuntime.dll') && hanAsset('dict.json') && hanAsset('translations/zh-CN.txt') && hanAsset('fonts/HarmonyOS_Sans_SC_Regular.ttf'))
    };
  });
  ipcMain.handle('han:install', async (_e, instId) => {
    const l = hanLayout(instId);
    if (!l.valid) return { success: false, error: '没有检测到有效的游戏目录' };
    if (isGameProcessRunning()) return { success: false, error: '游戏正在运行，请先完全退出再安装' };
    const srcDll = hanAsset('runtime/SFSHanRuntime.dll');
    const srcFont = hanAsset('fonts/HarmonyOS_Sans_SC_Regular.ttf');
    const srcDict = hanAsset('dict.json');
    const srcTr = hanAsset('translations/zh-CN.txt');
    if (!srcDll || !srcDict || !srcTr || !srcFont) return { success: false, error: '启动器缺少汉化资源文件' };
    const fsp = fs.promises;
    try {
      await fsp.mkdir(l.runtime, { recursive: true });
      await fsp.copyFile(srcDll, path.join(l.runtime, 'SFSHanRuntime.dll'));
      if (srcFont) {
        const fontDst = path.join(l.runtime, 'NotoSansSC-Bold.ttf');
        let same = false;
        try {
          const a = await fsp.stat(srcFont), b = await fsp.stat(fontDst);
          same = a.size === b.size && a.size > 0;
        } catch (e) {}
        if (!same) await fsp.copyFile(srcFont, fontDst); // 8MB，已存在且体积一致就跳过
      }
      const dictText = await fsp.readFile(srcDict, 'utf8');
      await fsp.writeFile(path.join(l.runtime, 'dict.json'), dictText, 'utf8');
      const trText = await fsp.readFile(srcTr, 'utf8');
      await fsp.mkdir(l.custom, { recursive: true });
      await fsp.writeFile(l.translation, trText, 'utf8');

      await fsp.mkdir(l.settings, { recursive: true });
      const settingsFile = path.join(l.settings, 'LanguageSettings_2.txt');
      const settingsBak = settingsFile + '.hanbak';
      const settingsExisted = fs.existsSync(settingsFile);
      if (settingsExisted && !fs.existsSync(settingsBak)) await fsp.copyFile(settingsFile, settingsBak);
      await fsp.writeFile(settingsFile, JSON.stringify({ CodeName: HAN_LANG_NAME, Custom: true }, null, 2), 'utf8');

      // chars.txt：给运行时 Mod 预热字体图集，少了它会缺字显示方块
      const uni = new Set();
      for (const ch of trText + dictText) {
        if (ch.codePointAt(0) > 0x7f) uni.add(ch);
      }
      await fsp.writeFile(path.join(l.runtime, 'chars.txt'), Array.from(uni).join(''), 'utf8');

      const files = [
        path.join(l.runtime, 'SFSHanRuntime.dll'),
        path.join(l.runtime, 'NotoSansSC-Bold.ttf'),
        path.join(l.runtime, 'dict.json'),
        path.join(l.runtime, 'chars.txt'),
        l.translation
      ];
      const st = {
        tool: 'SFSHanInjector',
        installed: true,
        language_name: HAN_LANG_NAME,
        translation_path: l.translation,
        settings_existed: settingsExisted,
        font_runtime: true,
        files
      };
      await fsp.writeFile(l.state, JSON.stringify(st, null, 2) + '\n', 'utf8');
      return { success: true, gameDir: l.root, translation: l.translation };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('han:uninstall', async (_e, instId) => {
    const l = hanLayout(instId);
    if (!l.valid) return { success: false, error: '没有检测到有效的游戏目录' };
    if (isGameProcessRunning()) return { success: false, error: '游戏正在运行，请先完全退出再卸载' };
    const fsp = fs.promises;
    try {
      const settingsFile = path.join(l.settings, 'LanguageSettings_2.txt');
      const settingsBak = settingsFile + '.hanbak';
      if (fs.existsSync(settingsBak)) {
        await fsp.copyFile(settingsBak, settingsFile);
        await fsp.unlink(settingsBak).catch(() => {});
      } else {
        // 没有原始备份时，只有当前语言仍指向汉化才删除；用户中途改成别的语言就保留。
        let cur = null;
        try { cur = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {}
        if (!cur || !cur.CodeName || cur.CodeName === HAN_LANG_NAME) {
          await fsp.unlink(settingsFile).catch(() => {});
        }
      }
      const st = readHanState(l) || {};
      const trPath = st.translation_path || l.translation;
      // 状态文件可能被外部改坏：只删除游戏 dataDir 内的词表，别把任意路径传进 unlink。
      try {
        const dataResolved = path.resolve(l.dataDir);
        const trResolved = path.resolve(String(trPath || ''));
        if (trPath && (trResolved === dataResolved || trResolved.startsWith(dataResolved + path.sep))) {
          await fsp.unlink(trResolved).catch(() => {});
        }
      } catch (e) {}
      for (const name of ['SFSHanRuntime.dll', 'dict.json', 'NotoSansSC-Bold.ttf', 'chars.txt', 'SFSHanRuntime.log']) {
        await fsp.unlink(path.join(l.runtime, name)).catch(() => {});
      }
      try {
        const left = await fsp.readdir(l.runtime);
        if (!left.length) await fsp.rmdir(l.runtime);
      } catch (e) {}
      const next = Object.assign({}, st, {
        tool: 'SFSHanInjector', installed: false, language_name: '', translation_path: '', font_runtime: false, files: []
      });
      await fsp.mkdir(l.settings, { recursive: true });
      await fsp.writeFile(l.state, JSON.stringify(next, null, 2) + '\n', 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });
  // 兼容旧调用：老渲染层还可能在调 han:info / han:open，统一回落到状态查询
  ipcMain.handle('han:info', (_e, instId) => {
    const l = hanLayout(instId);
    return { success: l.valid, gameDir: l.root, exePathOfGame: (l.inst && l.inst.exePath) || '' };
  });
  ipcMain.handle('han:open', () => ({ success: false, error: '已改为启动器内直接安装，不需要外部注入器' }));

  // 获取日志目录路径
  ipcMain.handle('log:getDir', () => {
    return path.join(app.getPath('userData'), 'logs');
  });

  // 打开程序目录
  ipcMain.handle('app:openDir', () => {
    const { shell } = require('electron');
    shell.openPath(app.getAppPath());
    return { success: true };
  });

  // 渲染层主题 / 毛玻璃开关变化：
  //  - 仅深浅主题变化：窗口轮廓不变，原地重施 tint，不重建、不闪；
  //  - 开关毛玻璃导致分层透明 / 系统材质属性变化：这些属性只能创建窗口时指定，需静默销毁重建窗口。
  ipcMain.handle('glass:state', (_e, arg) => {
    try {
      const a = arg || {};
      if (a.theme === 'light' || a.theme === 'dark') glassState.theme = a.theme;
      const cfg = loadConfig();
      cfg.glass = a.enabled !== false;
      // 前端胶囊显式传入的材质选择（off/aero/acrylic/mica）需持久化；仅主题同步时不传，不覆盖
      if (a.mode === 'off' || a.mode === 'aero' || a.mode === 'acrylic' || a.mode === 'mica' || a.mode === 'liuli') {
        cfg.glassMode = a.mode;
        // 同步维护旧字段，避免云母降级逻辑读取不到
        if (isWin11) cfg.win11Material = (a.mode === 'mica' || a.mode === 'acrylic') ? a.mode : cfg.win11Material;
        saveConfig(cfg);
      }
      const targetMode = glassModeFor(cfg);
      const needRecreate = glassProfile(glassState.mode) !== glassProfile(targetMode);
      glassState.enabled = targetMode !== 'off';
      glassState.mode = targetMode;
      if (needRecreate) {
        // 防止重建期间重复触发，导致旧窗口引用被覆盖、旧窗口泄漏不销毁
        if (recreating) return { ok: true, mode: targetMode, recreated: true };
        recreateWindow();
        return { ok: true, mode: targetMode, recreated: true };
      }
      applyWindowGlass();
      return { ok: true, mode: targetMode, recreated: false };
    } catch (e) { return { ok: false, mode: glassState.mode || 'off' }; }
  });

  // 首帧防闪：preload 在 document-start 同步取回初始主题/玻璃/材质，首次绘制前写到 <html>，
  // 避免页面先按默认深色实色画一帧、异步配置回来再跳变玻璃（开窗闪烁）。只读主进程内存，不读盘。
  // 渲染端首批内容渲染完成后上报；窗口此时可能还在等内容就绪，收到就立刻显示
  ipcMain.on('ui:ready', () => { if (bootReveal) bootReveal('ui_ready'); });

  ipcMain.on('glass:initial', (e) => {
    e.returnValue = {
      enabled: glassState.enabled === true,
      theme: glassState.theme || 'dark',
      mode: glassState.mode || 'off',
      transition: pendingGlassTransition === true
    };
  });

  // Win11 云母持续掉帧回退：渲染端在 mica 下滚动持续低帧时调用。仅 auto 且未回退时写持久化标记，
  // 下次启动 glassModeFor 解析为亚克力；当场不重建窗口，避免打断使用。
  ipcMain.handle('glass:material-fallback', () => {
    try {
      const c = loadConfig();
      if (!isWin11 || c.win11Material === 'acrylic' || c.glassMicaFallback === true) return { fellBack: false };
      c.glassMicaFallback = true;
      saveConfig(c);
      return { fellBack: true };
    } catch (e) { return { fellBack: false }; }
  });

  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
    mainWindow.maximize(); return true;
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());

  ipcMain.handle('openExternal', async (_e, url) => { await shell.openExternal(url); return true; });

  ipcMain.handle('steam:resolvePath', () => resolveSteamPath());

// ---------- Steam 扫描缓存（避免重复扫描阻塞主进程） ----------
let _steamScanCache = null;
let _steamScanTime = 0;
const STEAM_SCAN_TTL = 5 * 60 * 1000; // 5分钟

// ---------- 活动备份任务（退出时清理，防 tar 孤儿进程 + temp 残留） ----------
let _activeBackup = null; // { childProc, tmpFile }

ipcMain.handle('steam:scan', async () => {
  const now = Date.now();
  if (_steamScanCache && now - _steamScanTime < STEAM_SCAN_TTL) return _steamScanCache;
  // 让出事件循环，避免与其他 IPC/窗口消息死锁造成未响应
  await new Promise(r => setImmediate(r));
  const sp = resolveSteamPath();
  if (!sp) return { success: false, error: '未找到 Steam，请在设置中手动选择 Steam 目录' };
  const games = scanSteamGames(sp);
  const sfs = findSfs(games);
  const result = { success: true, steamPath: sp, games, sfs };
  _steamScanCache = result; _steamScanTime = now;
  return result;
});

  ipcMain.handle('steam:scanWithPath', (_e, dir) => {
    if (!dir || !fs.existsSync(path.join(dir, 'steam.exe'))) {
      return { success: false, error: '所选目录不是 Steam 根目录（缺少 steam.exe）' };
    }
    const cfg = loadConfig(); cfg.steamPath = dir; saveConfig(cfg);
    const games = scanSteamGames(dir);
    return { success: true, steamPath: dir, games, sfs: findSfs(games) };
  });

  ipcMain.handle('steam:selectDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return { canceled: false, path: r.filePaths[0] };
  });

  ipcMain.handle('game:add', (_e, game) => {
    const cfg = loadConfig();
    // 只允许添加 Spaceflight Simulator（SFS）游戏
    {
      const name = (game.name || '').toLowerCase();
      if (!/spaceflight|sfs/i.test(name)) {
        return { success: false, error: '只能添加 Spaceflight Simulator（SFS）游戏实例。' };
      }
    }
    {
      // 同名实例一律拒绝：同一份游戏目录、复制/目录联接出来的第二份目录都可能重名，
      // 列表里出现两个同名卡片会让「当前实例」和模组归属无法分辨。
      const nameKey = String(game.name || '').trim().toLowerCase();
      if (nameKey && cfg.instances.some(i => String(i.name || '').trim().toLowerCase() === nameKey)) {
        return { success: false, error: '同名实例已存在，请换一个名称。' };
      }
    }
    if (cfg.instances.some(i => i.exePath && game.exePath && i.exePath === game.exePath)) {
      return { success: false, error: '该游戏实例已存在，无需重复添加' };
    }
    {
      const newName = String(game.name || '').trim().toLowerCase();
      if (newName && cfg.instances.some(i => String(i.name || '').trim().toLowerCase() === newName)) {
        return { success: false, error: '已有同名实例，请换一个名称' };
      }
    }
    cfg.instances.push({
      id: Date.now() + '' + Math.floor(Math.random() * 1000),
      name: game.name || 'Spaceflight Simulator',
      exePath: game.exePath || '',
      installDir: game.installDir || '',
      appId: game.appId || SFS_APPID,
      current: cfg.instances.length === 0
    });
    saveConfig(cfg);
    return { success: true, instances: cfg.instances };
  });

  ipcMain.handle('game:selectPath', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'], filters: [{ name: tx('filterExe', '可执行文件'), extensions: ['exe'] }]
    });
    if (r.canceled) return { canceled: true };
    return { canceled: false, path: r.filePaths[0] };
  });

  ipcMain.handle('game:setCurrent', (_e, id) => {
    const cfg = loadConfig();
    cfg.instances.forEach(i => i.current = (i.id === id));
    saveConfig(cfg);
    return true;
  });

  ipcMain.handle('game:remove', (_e, id) => {
    const cfg = loadConfig();
    cfg.instances = cfg.instances.filter(i => i.id !== id);
    saveConfig(cfg);
    return cfg.instances;
  });

  // ---- 游戏崩溃监控 ----
  const SFS_LOG_DIR = () => path.join(process.env.USERPROFILE || '', 'AppData', 'LocalLow', 'Stef Morojna', 'Spaceflight Simulator');
  let crashWatchTimer = null;

  function crashWatchStop() {
    if (crashWatchTimer) { clearInterval(crashWatchTimer); crashWatchTimer = null; }
  }

  function crashProcName(inst) {
    if (inst && inst.exePath) return path.basename(inst.exePath).replace(/\.exe$/i, '');
    return 'Spaceflight Simulator';
  }

  // 崩溃弹窗的唯一出口：三路判定（Unity 崩溃框 / 进程非 0 退出 / Player.log 的 Crash!!!）都走这里，
  // 30 秒内去重，避免同一次崩溃被两条路径各弹一次。
  let lastCrashNotifyAt = 0;
  function notifyCrash(pname, title) {
    const now = Date.now();
    if (now - lastCrashNotifyAt < 30000) return;
    lastCrashNotifyAt = now;
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('game:crashed', { pname, title });
    } catch (e) {}
  }

  function startCrashWatch(inst) {
    crashWatchStop();
    const w = winProc();
    if (!w) return;
    const names = [crashProcName(inst), 'Spaceflight Simulator'];
    let wasRunning = false;
    let crashShown = false;
    // 日志兜底用：记下本次运行开始时的日志尺寸，退出时只看新增部分，避免把历史崩溃当成这次的
    let logPath = '';
    let logBaseSize = 0;
    try {
      logPath = path.join(SFS_LOG_DIR(), 'Player.log');
      if (fs.existsSync(logPath)) logBaseSize = fs.statSync(logPath).size;
    } catch (e) {}
    // 崩溃判定（用户口径）：只认 Unity 崩溃对话框——标题同时含 “Spaceflight Simulator” 与
    // “Unity”、不含“启动器”，且窗口属主为游戏进程（win-proc 内按 PID 限定）。
    // WerFault“已停止工作”、“未响应”等兜底情形一律不判，杜绝误报。
    crashWatchTimer = setInterval(() => {
      let running = false, crashWin = null;
      try { running = w.processRunning(names); } catch (e) { running = false; }
      // 游戏没跑就不枚举窗口：原来每 2 秒两次全进程枚举，空闲时纯烧 CPU
      if (running) { try { crashWin = w.findUnityCrash(names); } catch (e) { crashWin = null; } }
      if (crashWin && !crashShown) {
        crashShown = true;
        notifyCrash(names[0], crashWin.title);
      }
      if (!crashWin) crashShown = false; // 崩溃框关闭后复位，允许下一次再报
      if (running) { wasRunning = true; return; }
      // 游戏进程退出：若启动时收起到托盘，则恢复显示（“关闭则最大化显现”），随后结束本轮守望
      if (wasRunning) {
        wasRunning = false;
        // 日志兜底：只看本次运行新增的尾部，出现 Crash!!!（Unity 的标准崩溃标记）就判崩溃
        try {
          if (logPath && fs.existsSync(logPath)) {
            const size = fs.statSync(logPath).size;
            if (size > logBaseSize) {
              const startAt = Math.max(logBaseSize, size - 262144);
              const len = size - startAt;
              const fd = fs.openSync(logPath, 'r');
              const buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, startAt);
              fs.closeSync(fd);
              if (/Crash!!!/.test(buf.toString('utf8'))) notifyCrash(names[0], 'Player.log: Crash!!!');
            }
          }
        } catch (e) {}
        try {
          const cfg2 = loadConfig();
          if (cfg2.autoShowOnLaunch && mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        } catch (e) {}
        crashWatchStop();
      }
    }, 2000);
  }

  // 外部启动路径（Steam / 双击 exe）：检测到游戏进程后补挂同一套崩溃监视，已挂则不重复
  onExternalGameStarted = () => {
    if (crashWatchTimer) return;
    try {
      const cfg = loadConfig();
      const inst = (cfg.instances || []).find(i => i.current) || (cfg.instances || [])[0];
      if (inst) startCrashWatch(inst);
    } catch (e) {}
  };

  function collectLogFiles() {
    const dir = SFS_LOG_DIR();
    const files = ['Player.log', 'Player-prev.log']
      .map(f => path.join(dir, f))
      .filter(f => fs.existsSync(f));
    return { dir, files };
  }

  function copyLogsImpl() {
    const { dir, files } = collectLogFiles();
    if (!files.length) return { success: false, error: '未找到日志文件：' + dir };
    const dl = path.join(process.env.USERPROFILE || '', 'Downloads');
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = path.join(dl, 'SFS\u5d29\u6e83\u65e5\u5fd7-' + ts);
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
    const copied = [];
    for (const f of files) {
      const dest = path.join(outDir, path.basename(f));
      try { fs.copyFileSync(f, dest); copied.push(dest); } catch (e) {}
    }
    return { success: copied.length > 0, outDir, copied };
  }

  ipcMain.handle('crash:logFiles', () => {
    const { dir, files } = collectLogFiles();
    return { success: true, dir, files };
  });

  ipcMain.handle('crash:openLog', async () => {
    const { dir, files } = collectLogFiles();
    if (!files.length) return { success: false, error: '未找到日志文件：' + dir };
    for (const f of files) { try { shell.openPath(f); } catch (e) {} }
    return { success: true, files };
  });

  ipcMain.handle('crash:copyLogs', () => copyLogsImpl());

  ipcMain.handle('crash:askDoubao', async () => {
    const r = copyLogsImpl();
    if (r.success) { try { await shell.openExternal('https://www.doubao.com/'); } catch (e) {} }
    return r;
  });

  // 启动前预检查：扩展包完整性 + 路径风险，错误项拦截启动，警告项可选择继续
  ipcMain.handle('game:precheck', async (_e, id) => {
    try {
      const cfg = loadConfig();
      const inst = cfg.instances.find(i => i.id === id) || cfg.instances[0];
      if (!inst) return { success: false, error: '没有游戏实例' };
      const errors = [], warnings = [];
      const base = inst.installDir || (inst.exePath ? path.dirname(inst.exePath) : '');
      if (!base || !fs.existsSync(base)) return { success: false, error: '游戏目录不存在' };
      // 路径含中文或特殊符号警告
      if (/[^\x00-\x7F]/.test(base)) warnings.push('游戏路径含非 ASCII 字符（' + base + '），部分旧版 SFS 可能异常');
      // 扩展包三目录校验
      const cspRoot = path.join(base, 'Spaceflight Simulator_Data', 'Custom Solar Systems');
      if (fs.existsSync(cspRoot)) {
        for (const name of fs.readdirSync(cspRoot)) {
          const p = path.join(cspRoot, name);
          try {
            if (fs.statSync(p).isDirectory() && !isValidSolarPackage(p)) {
              errors.push('扩展包「' + name + '」不完整');
            }
          } catch (e) {}
        }
      }
      return { success: true, errors, warnings };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('game:launch', async (_e, id) => {
    const cfg = loadConfig();
    const inst = cfg.instances.find(i => i.id === id) || cfg.instances[0];
    if (!inst) return { success: false, error: '没有游戏实例' };
    try {
      let launchChild = null;
      if (inst.exePath && fs.existsSync(inst.exePath)) {
        // 用 spawn 而不是 shell.openPath：要拿到进程句柄才能记退出码，这是崩溃判定的第二道兜底
        try {
          launchChild = spawn(inst.exePath, [], { cwd: path.dirname(inst.exePath), stdio: 'ignore', windowsHide: false });
        } catch (e) { launchChild = null; }
        if (!launchChild) shell.openPath(inst.exePath);
      } else if (inst.appId) {
        await shell.openExternal(`steam://rungameid/${inst.appId}`);
      } else {
        return { success: false, error: '找不到游戏可执行文件' };
      }
      // 游戏启动后自动隐藏到托盘（设置开关，默认关）
      if (cfg.autoShowOnLaunch && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        // 未开启隐藏：打开游戏时自动打开启动器（显示并置前）
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      // 启动崩溃监控
      startCrashWatch(inst);
      // 退出码兜底：Unity 崩溃常直接以非 0 退出，且来不及弹崩溃框
      if (launchChild) {
        launchChild.once('exit', (code) => {
          if (code === 0 || code === null || code === undefined) return;
          // 等 1.2s，让窗口判定和日志判定先走；它们已经报过的话 notifyCrash 内部会去重
          setTimeout(() => { notifyCrash(crashProcName(inst), 'exit code ' + code); }, 1200);
        });
      }
      // 记录最近游玩时间并持久化
      inst.lastPlayed = Date.now();
      saveConfig(cfg);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 模组 ----
  ipcMain.handle('mod:dataDir', () => {
    try { return { success: true, dir: sfsDataDir() }; }
    catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 游戏世界数据：挑战进度 + 游玩时间 ----
  ipcMain.handle('game:readWorlds', async () => {
    try {
      const base = sfsDataDir();
      const worldsDir = path.join(base, 'Saving', 'Worlds');
      if (!fs.existsSync(worldsDir)) return { success: true, worlds: [] };
      const worlds = [];
      for (const name of fs.readdirSync(worldsDir)) {
        const wdir = path.join(worldsDir, name);
        if (!fs.statSync(wdir).isDirectory()) continue;
        // 挑战文件
        let challenges = [];
        const chalFile = path.join(wdir, 'Persistent', 'Challenges.txt');
        if (fs.existsSync(chalFile)) {
          try {
            const raw = fs.readFileSync(chalFile, 'utf8');
            // Challenges.txt 是 JSON 数组
            const parsed = JSON.parse(raw);
            challenges = Array.isArray(parsed) ? parsed : [];
          } catch (e) { challenges = []; }
        }
        // 游玩时间
        let playSeconds = 0;
        const wsFile = path.join(wdir, 'WorldSettings.txt');
        if (fs.existsSync(wsFile)) {
          try {
            const raw = fs.readFileSync(wsFile, 'utf8');
            const m = raw.match(/"totalPlayTime_Seconds"\s*:\s*(\d+)/);
            if (m) playSeconds = parseInt(m[1], 10) || 0;
          } catch (e) {}
        }
        worlds.push({ name, challenges, playSeconds });
      }
      return { success: true, worlds };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 直接触发会话下载（解决网页 window.open 被拦截导致下载不了）
  ipcMain.handle('mod:downloadURL', async (_e, url) => {
    try {
      // 商店 JSON 是第三方数据，下载入口只放行 http/https，避免 file:// 或自定义协议
      let parsed;
      try { parsed = new URL(String(url || '')); } catch (e) { return { success: false, error: '下载地址无效' }; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: '只允许 http/https 下载地址' };
      }
      const cfg = loadConfig();
      // 线程数硬限制在 1~16：前端胶囊只到 16，此处兜底防止配置被外部改成异常值
      const threads = Math.min(16, Math.max(1, parseInt(cfg.dlThreads, 10) || 1));
      if (threads > 1) {
        // 多线程下载
        return await multithreadDownload(url, threads);
      } else {
        // 单线程走原来的 Electron 下载
        const sess = session.fromPartition('persist:sfs');
        sess.downloadURL(url);
        return { success: true };
      }
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ===== 多线程下载 =====
  async function multithreadDownload(url, threadCount) {
    const cfg = loadConfig();
    let dlDir = (cfg.downloadDir && fs.existsSync(cfg.downloadDir))
      ? cfg.downloadDir
      : app.getPath('downloads');
    try { fs.mkdirSync(dlDir, { recursive: true }); } catch (e) { dlDir = app.getPath('downloads'); }

    // 1. HEAD 请求获取文件信息
    const headRes = await headRequest(url);
    const totalSize = headRes.contentLength;
    const acceptRanges = headRes.acceptRanges;
    // Content-Disposition 的文件名不可信：只取 basename 并清掉 Windows 非法字符，
    // 否则 ../../xxx 会把文件写出下载目录。
    const rawName = (headRes.filename || path.basename(new URL(url).pathname) || 'mod.zip');
    const filename = path.basename(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'mod.zip';

    // 不支持 Range → 自动降级单线程
    if (!acceptRanges || totalSize <= 0 || threadCount <= 1) {
      mainWindow.webContents.send('download:progress', {
        id: -1, name: filename, recv: 0, total: totalSize, pct: 0,
        state: '降级为单线程'
      });
      const sess = session.fromPartition('persist:sfs');
      sess.downloadURL(url);
      return { success: true, degraded: true };
    }

    // 同名文件加序号
    let saveName = filename, dn = 1;
    while (fs.existsSync(path.join(dlDir, saveName))) {
      const dot = filename.lastIndexOf('.');
      saveName = dot > 0 ? filename.slice(0, dot) + ' (' + dn + ')' + filename.slice(dot) : filename + ' (' + dn + ')';
      dn++;
    }
    const savePath = path.join(dlDir, saveName);
    const id = ++dlSeq;

    // 2. 分片下载
    const chunkSize = Math.ceil(totalSize / threadCount);
    const promises = [];
    let downloaded = 0;

    for (let i = 0; i < threadCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      const partPath = savePath + '.part' + i;
      promises.push(downloadPart(url, start, end, partPath, (received) => {
        downloaded += received;
        const pct = Math.min(99, Math.round(downloaded / totalSize * 100));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download:progress', {
            id, name: filename, recv: downloaded, total: totalSize, pct, state: '下载中'
          });
        }
      }));
    }

    try {
      await Promise.all(promises);
    } catch (e) {
      // 连接错误（常见于线程过高触发服务器并发限制）→ 清理残留分片 → 弹窗可重试
      for (let i = 0; i < threadCount; i++) {
        try { fs.unlinkSync(savePath + '.part' + i); } catch (_) {}
      }
      try { fs.unlinkSync(savePath); } catch (_) {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:error', {
          id, name: filename, url, error: e.message, threads: threadCount
        });
      }
      throw e;
    }

    // 3. 合并分片
    await mergeParts(savePath, threadCount);

    // 4. 完成，加到 pending
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:progress', {
        id, name: filename, recv: totalSize, total: totalSize, pct: 100, state: '完成'
      });
      mainWindow.webContents.send('download:done', { id, name: filename, state: 'completed', savePath });
    }

    try {
      const cfg2 = loadConfig();
      if (!cfg2.mods.pending.some(p => p.path === savePath)) {
        cfg2.mods.pending.unshift({
          path: savePath,
          name: filename,
          type: await fsTask('detectType', { zipPath: savePath }),
          addedAt: Date.now(),
          fromUrl: url
        });
        saveConfig(cfg2);
      }
      mainWindow.webContents.send('mods:changed');
    } catch (e) {}

    return { success: true, id, savePath };
  }

  // HEAD 请求
  function headRequest(urlStr) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(urlStr, { method: 'HEAD' }, (res) => {
        const cl = parseInt(res.headers['content-length'] || '0', 10);
        const ar = res.headers['accept-ranges'] === 'bytes';
        const cd = res.headers['content-disposition'] || '';
        const m = cd.match(/filename="?([^"]+)"?/);
        let fn = null;
        if (m) {
          try { fn = decodeURIComponent(m[1]); } catch (_) { fn = m[1]; }
        }
        resolve({
          contentLength: cl,
          acceptRanges: ar,
          filename: fn
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时')); });
      req.end();
    });
  }

  // 下载单个分片
  function downloadPart(urlStr, start, end, savePath, onProgress) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(savePath);
      let lastRecv = 0;
      const fail = (err) => {
        try { file.destroy(); } catch (_) {}
        reject(err);
      };

      const req = mod.request(urlStr, {
        headers: { 'Range': `bytes=${start}-${end}` }
      }, (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          fail(new Error('HTTP ' + res.statusCode));
          return;
        }
        res.on('error', fail);
        res.pipe(file);
        res.on('data', () => {
          const recv = res.socket.bytesRead - lastRecv;
          lastRecv = res.socket.bytesRead;
          onProgress(recv);
        });
        file.on('finish', () => { file.close(resolve); });
      });
      req.on('error', fail);
      req.setTimeout(30000, () => { req.destroy(); fail(new Error('连接超时')); });
      req.end();
    });
  }

  // 合并分片
  async function mergeParts(finalPath, count) {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < count; i++) {
      const partPath = finalPath + '.part' + i;
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(partPath);
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });
      fs.unlinkSync(partPath);
    }
    writeStream.end();
  }
  // ===== END 多线程下载 =====

  ipcMain.handle('mod:pickZip', async (_e, kind) => {
    const filterMap = {
      parts: [{ name: tx('filterParts', '部件（.pack / .zip）'), extensions: ['zip', 'pack'] }],
      texture: [{ name: tx('filterTexture', '涂装包（.zip）'), extensions: ['zip'] }],
      dll: [{ name: tx('filterDll', 'DLL（.dll / .zip）'), extensions: ['zip', 'dll'] }],
      blueprint: [{ name: tx('filterBlueprint', '蓝图（.zip）'), extensions: ['zip'] }]
    };
    const filters = filterMap[kind] || [{ name: tx('filterModAny', '模组文件'), extensions: ['zip', 'pack', 'dll'] }];
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters
    });
    if (r.canceled) return { canceled: true };
    const p = r.filePaths[0];
    return { canceled: false, path: p, type: /\.zip$/i.test(p) ? await fsTask('detectType', { zipPath: p }) : 'single' };
  });

  // 扩展包（Custom Solar Systems）快捷导入：必须含 Planet Data、禁止嵌套多余文件夹
  ipcMain.handle('mod:pickSolar', async () => {
    if (isGameProcessRunning()) return { success: false, error: '游戏正在运行，请先退出再导入扩展包' };
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: tx('filterSolar', '扩展包（ZIP）'), extensions: ['zip'] }]
    });
    if (r.canceled) return { canceled: true };
    const zipPath = r.filePaths[0];
    try {
      const base = sfsDataDir();
      const cspRoot = path.join(base, 'Spaceflight Simulator_Data', 'Custom Solar Systems');
      const zip = new (getAdmZip())(zipPath);
      const entries = zip.getEntries();
      // 兼容两种包结构：
      //  A) 正常包：外层文件夹包裹，如 MyPlanet/Heightmap Data/.../Planet Data/...
      //  B) 扁平包：zip 根目录直接是 Heightmap Data / Planet Data / Texture Data，无外层文件夹
      //     扁平包自动用 zip 文件名作为包名建文件夹，避免和别的扩展包混在 Custom Solar Systems 根
      let solarRootName = null;
      let flatMode = false;
      for (const e of entries) {
        const segs = e.entryName.split('/').filter(Boolean);
        const pi = segs.findIndex(s => s.replace(/\s+/g, '').toLowerCase() === 'planetdata');
        if (pi < 0) continue;
        if (pi === 0) { flatMode = true; solarRootName = path.basename(zipPath, path.extname(zipPath)) || 'SolarPack'; break; }
        if (pi !== 1) throw new Error('扩展包不完整');
        solarRootName = segs[0];
        break;
      }
      if (!solarRootName) throw new Error('扩展包不完整');
      // 包名来自 ZIP，先收紧成单层合法目录名，避免 ../ 或绝对路径写出 Custom Solar Systems
      const safeRoot = path.basename(String(solarRootName).replace(/[<>:"|?*\x00-\x1f]/g, '_'));
      if (!safeRoot || safeRoot === '.' || safeRoot === '..') throw new Error('扩展包目录名非法');
      const destDir = path.join(cspRoot, safeRoot);
      fs.mkdirSync(cspRoot, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(cspRoot, '.import-'));
      const tmpResolved = path.resolve(tmpDir);
      let bakDir = null;
      let count = 0;
      try {
        for (const e of entries) {
          if (e.isDirectory) continue;
          const segs = e.entryName.split('/').filter(Boolean);
          if (segs.some(s => s === '..' || s === '.')) throw new Error('扩展包包含非法路径');
          let rel;
          if (flatMode) {
            rel = segs.join('/');
          } else {
            if (segs[0] !== solarRootName) continue;
            rel = segs.slice(1).join('/');
          }
          if (!rel) continue;
          const out = path.resolve(tmpDir, rel);
          if (!out.startsWith(tmpResolved + path.sep)) throw new Error('扩展包包含越界路径');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, e.getData());
          count++;
        }
        if (count === 0 || !isValidSolarPackage(tmpDir)) throw new Error('扩展包不完整');
        // 新包校验通过后再替换旧目录：旧的先改名，失败可回滚，不再直接 rm 掉同名包
        if (fs.existsSync(destDir)) {
          bakDir = destDir + '.bak-' + Date.now();
          fs.renameSync(destDir, bakDir);
        }
        fs.renameSync(tmpDir, destDir);
        if (bakDir) { try { fs.rmSync(bakDir, { recursive: true, force: true }); } catch (e) {} }
      } catch (e) {
        // 回滚：新目录没换成，旧目录还在 .bak 上
        if (bakDir && !fs.existsSync(destDir)) {
          try { fs.renameSync(bakDir, destDir); } catch (_) {}
        }
        throw e;
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      }
      const cfg = loadConfig();
      cfg.mods.installed.unshift({
        name: safeRoot, type: 'solar', target: relPath(cspRoot, destDir),
        count, files: [relPath(cspRoot, destDir)], installedAt: Date.now()
      });
      pushImportHistory(cfg, { name: safeRoot, type: 'solar', ok: true });
      saveConfig(cfg);
      return { success: true, summary: `扩展包已导入 → ${relPath(base, destDir)}`, target: relPath(cspRoot, destDir), files: count };
    } catch (e) {
      const cfg = loadConfig();
      pushImportHistory(cfg, { name: path.basename(zipPath), type: 'solar', ok: false, error: e.message });
      saveConfig(cfg);
      return { success: false, error: e.message };
    }
  });

  // 查看游戏日志：复制 SFS 的 Player.log 镜像、过滤错误行后打开，不修改原日志
  ipcMain.handle('game:openPlayerLog', async () => {
    try {
      const base = sfsDataDir();
      const candidates = [
        path.join(base, 'Spaceflight Simulator_Data', 'Player.log'),
        path.join(base, 'Spaceflight Simulator', '_Data', 'Player.log'),
        path.join(base, 'Spaceflight Simulator', 'Spaceflight Simulator_Data', 'Player.log')
      ];
      let logPath = candidates.find(p => fs.existsSync(p));
      if (!logPath) {
        const walk = (dir, depth) => {
          if (depth > 2) return null;
          let items = [];
          try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
          for (const it of items) {
            if (it.isFile() && it.name.toLowerCase() === 'player.log') return path.join(dir, it.name);
          }
          for (const it of items) {
            if (it.isDirectory()) { const f = walk(path.join(dir, it.name), depth + 1); if (f) return f; }
          }
          return null;
        };
        logPath = walk(base, 0);
      }
      if (!logPath) return { success: false, error: '未找到游戏运行日志 Player.log（启动游戏一次后再试）' };
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const kept = lines.filter(l => /error|exception|warning|fail|crash/i.test(l));
      const outLines = kept.length ? kept : lines.slice(-200);
      const mirrorDir = path.join(app.getPath('userData'), 'logs-mirror');
      fs.mkdirSync(mirrorDir, { recursive: true });
      const mirror = path.join(mirrorDir, 'Player_filtered_' + Date.now() + '.log');
      const header = tx('logMirrorHead', '# 本文件为 Player.log 的过滤镜像，原日志未被修改')
        + '\n' + tx('logMirrorSrc', '# 来源：') + logPath
        + '\n' + tx('logMirrorStat', '# 原日志 {1} 行，保留 {2} 行', lines.length, outLines.length) + '\n\n';
      fs.writeFileSync(mirror, header + outLines.join('\n'), 'utf8');
      await shell.openPath(mirror);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('mod:deploy', async (_e, { zipPath, type, version }) => {
    const cfg0 = loadConfig();
    try {
      const result = await deployModFile(zipPath, type);
      const cfg = loadConfig();
      // 名称显示实际部署后的文件名（解压 zip 后是 .pack/.dll），而不是原始 zip 包名
      let displayName;
      if (type === 'texture') displayName = path.basename(result.target);
      else if (result.files.length === 1) displayName = path.basename(result.files[0]);
      else displayName = path.basename(result.files[0]) + ' 等 ' + result.files.length + ' 个文件';
      cfg.mods.installed.unshift({
        name: displayName,
        type,
        target: result.target,
        count: result.files.length,
        files: result.files,
        version: version || '',
        installedAt: Date.now()
      });
      cfg.mods.pending = cfg.mods.pending.filter(p => p.path !== zipPath);
      pushImportHistory(cfg, { name: displayName, type, ok: true });
      saveConfig(cfg);
      return { success: true, ...result };
    } catch (e) {
      pushImportHistory(cfg0, { name: path.basename(zipPath || ''), type, ok: false, error: e.message });
      saveConfig(cfg0);
      return { success: false, error: e.message };
    }
  });

  // 拖入文件导入：按扩展名自动识别类型，复用现有 deploy 逻辑
  ipcMain.handle('mod:importFile', async (_e, { path: filePath, instId }) => {
    const fp = filePath;
    if (!fp || !fs.existsSync(fp)) return { success: false, error: '文件不存在' };
    if (isGameProcessRunning()) return { success: false, error: '游戏正在运行，请先退出再导入模组' };
    const ext = path.extname(fp).toLowerCase();
    let type;
    if (ext === '.dll') type = 'dll';
    else if (ext === '.pack') type = 'parts';
    else if (ext === '.zip') type = 'packed';
    else return { success: false, error: '不支持的文件类型：' + ext };
    const cfg0 = loadConfig();
    try {
      const result = await deployModFile(fp, type);
      const cfg = loadConfig();
      const displayName = result.files.length === 1
        ? path.basename(result.files[0])
        : path.basename(result.files[0]) + ' 等 ' + result.files.length + ' 个文件';
      cfg.mods.installed.unshift({
        name: displayName, type, target: result.target,
        count: result.files.length, files: result.files, installedAt: Date.now()
      });
      pushImportHistory(cfg, { name: displayName, type, ok: true });
      saveConfig(cfg);
      return { success: true, summary: displayName, ...result };
    } catch (e) {
      pushImportHistory(cfg0, { name: path.basename(fp), type, ok: false, error: e.message });
      saveConfig(cfg0);
      return { success: false, error: e.message };
    }
  });

  // 导出已装模组清单（txt / markdown）
  ipcMain.handle('mod:exportList', async (_e, fmt) => {
    try {
      const cfg = loadConfig();
      const inst = cfg.mods.installed || [];
      if (!inst.length) return { success: false, error: '当前实例没有已安装模组' };
      const r = await dialog.showSaveDialog(mainWindow, {
        title: tx('dlgExportList', '导出模组清单'),
        defaultPath: 'sfs-mod-list.' + (fmt === 'md' ? 'md' : 'txt'),
        filters: [{ name: fmt === 'md' ? 'Markdown' : tx('filterText', '文本'), extensions: [fmt === 'md' ? 'md' : 'txt'] }]
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      const isMd = fmt === 'md';
      const lines = [];
      if (isMd) {
        lines.push(tx('expTitleMd', '# SFS 模组清单'), '');
        lines.push(tx('expMeta', '导出时间：{1}　共 {2} 项', new Date().toLocaleString(), inst.length), '');
        lines.push(tx('expHeadMd', '| 名称 | 类型 | 版本 | 文件数 |'));
        lines.push('|---|---|---|---|');
        for (const m of inst) {
          lines.push('| ' + (m.name || '') + ' | ' + typeLabel(m.type) + ' | ' + (m.version || '-') + ' | ' + (m.count || 0) + ' |');
        }
      } else {
        lines.push(tx('expTitleTxt', 'SFS 模组清单　共 {1} 项　{2}', inst.length, new Date().toLocaleString()));
        lines.push('');
        inst.forEach((m, i) => {
          lines.push((i + 1) + '. ' + (m.name || '') + ' [' + typeLabel(m.type) + ']' + (m.version ? ' v' + m.version : '') + tx('expFileCount', '（{1} 个文件）', m.count || 0));
        });
      }
      fs.writeFileSync(r.filePath, lines.join('\r\n'), 'utf8');
      return { success: true, path: r.filePath, count: inst.length };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 实例备份：用 tar.exe 流式打包 Data + Saving + Mods，避免 adm-zip 内存爆掉
  ipcMain.handle('inst:backup', async (_e, id) => {
    try {
      const cfg = loadConfig();
      const inst = cfg.instances.find(i => i.id === id) || cfg.instances[0];
      if (!inst) return { success: false, error: '没有游戏实例' };
      const base = inst.installDir || (inst.exePath ? path.dirname(inst.exePath) : '');
      if (!base || !fs.existsSync(base)) return { success: false, error: '游戏目录不存在' };
      const r = await dialog.showSaveDialog(mainWindow, {
        title: tx('dlgBackup', '备份实例数据'),
        defaultPath: (inst.name || 'sfs') + tx('backupSuffix', '-备份-') + new Date().toISOString().slice(0, 10) + '.sfsbak',
        filters: [{ name: tx('filterSfsBak', 'SFS 实例备份'), extensions: ['sfsbak'] }]
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      // 收集要打包的子目录（存在才打）
      const subdirs = ['Spaceflight Simulator_Data', 'Saving', 'Mods'].filter(d => fs.existsSync(path.join(base, d)));
      if (!subdirs.length) return { success: false, error: '游戏目录下没有可备份的数据目录' };
      const tarExe = process.env.SystemRoot + '\\System32\\tar.exe';
      if (!fs.existsSync(tarExe)) {
        // 老系统没 tar.exe，回退 adm-zip（小文件够用，大文件会慢但不崩）
        const Zip = getAdmZip();
        const zip = new Zip();
        const skipDirs = new Set(['logs', 'log', 'temp', 'cache', 'crashdumps']);
        const walkAdd = (dir, zipPrefix) => {
          if (!fs.existsSync(dir)) return;
          for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            try {
              const st = fs.statSync(p);
              if (st.isDirectory()) {
                if (skipDirs.has(name.toLowerCase())) continue;
                walkAdd(p, zipPrefix + name + '/');
              } else {
                zip.addFile(zipPrefix + name, fs.readFileSync(p));
              }
            } catch (e) {}
          }
        };
        for (const d of subdirs) walkAdd(path.join(base, d), d + '/');
        zip.writeZip(r.filePath);
      } else {
        // 必须显式 --format=zip：-a 对 .sfsbak 这种未知扩展名会写出裸 tar，
        // 而恢复端用的是 adm-zip，读裸 tar 会直接报 “No END header found”。
        const args = ['--format=zip', '-c', '-f', r.filePath, '-C', base, ...subdirs];
        await new Promise((resolve, reject) => {
          require('child_process').execFile(tarExe, args, { windowsHide: true, timeout: 600000, maxBuffer: 1024*1024*10 },
            (err) => err ? reject(err) : resolve());
        });
        // 落盘后校验 ZIP 头，避免再次产出“能存不能还原”的备份
        try {
          const fd = fs.openSync(r.filePath, 'r');
          const head = Buffer.alloc(4);
          fs.readSync(fd, head, 0, 4, 0);
          fs.closeSync(fd);
          if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('备份文件不是有效的 ZIP');
          // 同 backup:create：PK 头不能证明中央目录存在，必须实际读一次条目表。
          new (getAdmZip())(r.filePath).getEntries();
        } catch (e) {
          try { fs.unlinkSync(r.filePath); } catch (_) {}
          throw e;
        }
      }
      return { success: true, path: r.filePath };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 实例恢复：从 .sfsbak 解压回当前实例目录（路径穿越校验 + 游戏运行中拒绝）
  ipcMain.handle('inst:restore', async (_e, id) => {
    try {
      const cfg = loadConfig();
      const inst = cfg.instances.find(i => i.id === id) || cfg.instances[0];
      if (!inst) return { success: false, error: '没有游戏实例' };
      const base = inst.installDir || (inst.exePath ? path.dirname(inst.exePath) : '');
      if (!base || !fs.existsSync(base)) return { success: false, error: '游戏目录不存在' };
      // 游戏正在运行时拒绝恢复（文件被占用会写坏）
      try {
        const proc = require('./win-proc');
        if (proc.processRunning(['Spaceflight Simulator'])) {
          return { success: false, error: 'SFS 正在运行，请先关闭游戏再恢复' };
        }
      } catch (e) {}
      const r = await dialog.showOpenDialog(mainWindow, {
        title: tx('dlgRestore', '选择备份文件'),
        properties: ['openFile'],
        filters: [{ name: tx('filterSfsBak', 'SFS 实例备份'), extensions: ['sfsbak', 'zip'] }]
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const Zip = getAdmZip();
      const zip = new Zip(r.filePaths[0]);
      const baseResolved = path.resolve(base);
      // 先整体校验条目，再解到临时目录，成功后才合并回游戏目录：
      // 原来边遍历边写，ZIP 中途损坏会留下写了一半的存档/模组。
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (zipEntryIsSymlink(e)) {
          return { success: false, error: '备份包含符号链接，已拒绝恢复' };
        }
        const entryName = e.entryName || '';
        if (entryName.includes('..') || path.isAbsolute(entryName)) {
          return { success: false, error: '备份包含非法路径：' + entryName };
        }
        const out = path.resolve(base, entryName.split('/').join(path.sep));
        if (!out.startsWith(baseResolved + path.sep) && out !== baseResolved) {
          return { success: false, error: '备份包含越界路径：' + entryName };
        }
      }
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sfs-restore-'));
      try {
        zip.extractAllTo(tmp, true);
        fs.cpSync(tmp, base, { recursive: true, force: true });
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // 首页实例卡片背景图选择
  ipcMain.handle('hero:pickBg', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: tx('dlgHeroBg', '选择实例卡片背景图'),
      filters: [{ name: tx('filterImage', '图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    if (r.canceled) return { success: false, canceled: true };
    const cfg = loadConfig();
    cfg.heroBg = r.filePaths[0];
    saveConfig(cfg);
    return { success: true, path: r.filePaths[0] };
  });

  ipcMain.handle('hero:clearBg', () => {
    const cfg = loadConfig();
    cfg.heroBg = '';
    saveConfig(cfg);
    return { success: true };
  });

  // 主题背景壁纸选择：仅返回本地图片路径，压缩/取色与持久化由渲染端完成
  ipcMain.handle('wallpaper:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: tx('dlgWallpaper', '选择主题背景壁纸'),
      filters: [{ name: tx('filterImage', '图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    if (r.canceled) return { success: false, canceled: true };
    return { success: true, path: r.filePaths[0] };
  });

  // 校验目标路径落在壁纸目录内，防止误删其他文件
  function wpSafePath(p) {
    const root = path.resolve(WP_DIR);
    const resolved = path.resolve(root, String(p || ''));
    return resolved.startsWith(root + path.sep) ? resolved : null;
  }
  // 复制原图入库
  ipcMain.handle('wallpaper:importCopy', async (_e, srcPath) => {
    try {
      if (!srcPath || !fs.existsSync(srcPath)) return { success: false, error: '源文件不存在' };
      const ext = path.extname(srcPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) return { success: false, error: '不支持的图片格式' };
      fs.mkdirSync(WP_DIR, { recursive: true });
      const dst = path.join(WP_DIR, 'wp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
      fs.copyFileSync(srcPath, dst);
      return { success: true, path: dst };
    } catch (e) { return { success: false, error: e.message }; }
  });
  // 写入渲染端压缩好的 JPEG dataURL
  ipcMain.handle('wallpaper:importDataUrl', async (_e, dataUrl) => {
    try {
      const m = /^data:image\/[a-zA-Z]+;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { success: false, error: '图片数据无效' };
      fs.mkdirSync(WP_DIR, { recursive: true });
      const dst = path.join(WP_DIR, 'wp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg');
      fs.writeFileSync(dst, Buffer.from(m[1], 'base64'));
      return { success: true, path: dst };
    } catch (e) { return { success: false, error: e.message }; }
  });
  // 移除入库副本（仅壁纸目录内生效）
  ipcMain.handle('wallpaper:removeFile', async (_e, target) => {
    try {
      if (!target) return { success: true };
      const safe = wpSafePath(target);
      if (safe && fs.existsSync(safe)) fs.unlinkSync(safe);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('mod:list', () => {
    const cfg = loadConfig();
    if (!Array.isArray(cfg.mods.importHistory)) cfg.mods.importHistory = [];
    return { pending: cfg.mods.pending, installed: cfg.mods.installed, importHistory: cfg.mods.importHistory };
  });

  // 记录一条导入历史（成功/失败都记，最多留 60 条）
  function pushImportHistory(cfg, { name, type, ok, error }) {
    try {
      if (!Array.isArray(cfg.mods.importHistory)) cfg.mods.importHistory = [];
      cfg.mods.importHistory.unshift({ at: Date.now(), name: String(name || ''), type: String(type || ''), ok: !!ok, error: error || '' });
      if (cfg.mods.importHistory.length > 60) cfg.mods.importHistory.length = 60;
    } catch (e) {}
  }

  ipcMain.handle('mod:clearHistory', () => {
    const cfg = loadConfig();
    cfg.mods.importHistory = [];
    saveConfig(cfg);
    return { success: true };
  });

  ipcMain.handle('mod:removePending', (_e, p) => {
    const cfg = loadConfig();
    cfg.mods.pending = cfg.mods.pending.filter(x => x.path !== p);
    saveConfig(cfg);
    return cfg.mods.pending;
  });

  // 删除已装模组：同时删除实际部署的文件（files 存的是相对路径，需拼回 sfsDataDir）
  ipcMain.handle('mod:removeInstalled', (_e, index) => {
    const cfg = loadConfig();
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= cfg.mods.installed.length) return cfg.mods.installed;
    const entry = cfg.mods.installed[i];
    const root = sfsDataDir();
    const rootResolved = path.resolve(root);
    if (entry && Array.isArray(entry.files)) {
      for (const rel of entry.files) {
        try {
          // 只允许删除游戏目录内的文件，防止配置被改坏后误删游戏目录外的文件。
          const abs = path.resolve(path.isAbsolute(rel) ? rel : path.join(root, rel));
          if (!abs.startsWith(rootResolved + path.sep)) continue;
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch (e) { /* 忽略单文件删除失败 */ }
      }
      // 涂装包/蓝图目录：如果记录了 target 目录且已空，顺手删掉
      if (entry.target) {
        try {
          const tdir = path.resolve(path.isAbsolute(entry.target) ? entry.target : path.join(root, entry.target));
          if (tdir.startsWith(rootResolved + path.sep) && fs.existsSync(tdir) && fs.statSync(tdir).isDirectory()) {
            const left = fs.readdirSync(tdir);
            if (left.length === 0) fs.rmdirSync(tdir);
          }
        } catch (e) { /* 忽略 */ }
      }
    }
    cfg.mods.installed.splice(i, 1);
    saveConfig(cfg);
    return cfg.mods.installed;
  });

  // 游戏原版自带、不计入已装模组的内置目录（与 fileTasks.js 的 BUILTIN_MOD_DIRS 保持一致，小写匹配）
  const SFS_BUILTIN_MOD_DIRS = ['custommusic'];
  const isBuiltinModPath = (p) => {
    const n = String(p || '').replace(/\\/g, '/').toLowerCase();
    return SFS_BUILTIN_MOD_DIRS.some(d => n === 'mods/' + d || n.indexOf('mods/' + d + '/') === 0);
  };
  // 扫描游戏目录里已存在的模组文件，自动补进已装列表（去重）
  ipcMain.handle('mod:scanInstalled', async () => {
  try {
    const cfg = loadConfig();
    const root = sfsDataDir();
    const found = await fsTask('scanInstalled', { dataDir: root });
    cfg.mods.installed = cfg.mods.installed.filter(m => !(m.type === 'blueprint' && /^(Blueprint|Version)\.(txt|json)$/i.test(m.name)));
    // 剔除游戏原版内置目录（如 CustomMusic）：既挡住全新扫描，也清掉历史缓存里残留的旧记录
    cfg.mods.installed = cfg.mods.installed.filter(m => {
      if (isBuiltinModPath(m.target)) return false;
      if (Array.isArray(m.files) && m.files.some(isBuiltinModPath)) return false;
      return true;
    });
    for (const m of cfg.mods.installed) {
      if (/\.zip$/i.test(m.name)) {
        if (m.type === 'texture' && m.target) m.name = path.basename(m.target);
        else if (m.files && m.files.length === 1) m.name = path.basename(m.files[0]);
        else if (m.files && m.files.length > 1) m.name = path.basename(m.files[0]) + ' 等 ' + m.files.length + ' 个文件';
      }
    }
    const existing = new Set(cfg.mods.installed.flatMap(m => (m.files || []).concat(m.target || '')));
    let added = 0;
    for (const f of found) {
      if (existing.has(f.rel)) continue;
      cfg.mods.installed.push({
        name: f.name, type: f.type, target: f.rel,
        count: f.files ? f.files.length : 1,
        files: f.files ? f.files.map(x => relPath(root, x)) : [f.rel],
        installedAt: Date.now(),
        autoScanned: true
      });
      added++;
    }
    saveConfig(cfg);
    return { success: true, added, total: cfg.mods.installed.length, installed: cfg.mods.installed };
  } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 存档备份：把 Mods\ 和 Saving\ 打成 zip ----
  const backupsDir = () => path.join(app.getPath('userData'), 'backups');

  ipcMain.handle('backup:create', async () => {
    try {
      const root = sfsDataDir();
      const dir = backupsDir();
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const out = path.join(dir, `sfs-backup-${ts}.zip`);
      if (!fs.existsSync(root)) return { success: false, error: '游戏数据目录不存在：' + root };
      // 只备份 Mods 和 Saving。原来用 -C root . 会把整个游戏目录（含 GB 级本体）打进备份。
      const subs = ['Mods', 'Saving'].filter(d => fs.existsSync(path.join(root, d)));
      if (!subs.length) return { success: false, error: '游戏目录下没有 Mods 或 Saving' };
      const tarExe = process.env.SystemRoot + '\\System32\\tar.exe';
      if (fs.existsSync(tarExe)) {
        const { execFile } = require('child_process');
        await new Promise((resolve, reject) => {
          execFile(tarExe, ['--format=zip', '-c', '-f', out, '-C', root, ...subs],
            { windowsHide: true, timeout: 300000 },
            (err) => err ? reject(err) : resolve());
        });
      } else {
        // 老系统无 tar.exe，回退 adm-zip
        const Zip = getAdmZip();
        const zip = new Zip();
        for (const sub of subs) zip.addLocalFolder(path.join(root, sub), sub);
        zip.writeZip(out);
      }
      try {
        const fd = fs.openSync(out, 'r');
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('备份文件不是有效的 ZIP');
        // 头正确不代表归档完整：没有中央目录的截断 ZIP 也会以 PK 开头。
        // 读一次条目表，确保备份真的能打开，而不是留下一个“看起来成功”的废包。
        new (getAdmZip())(out).getEntries();
      } catch (e) {
        try { fs.unlinkSync(out); } catch (_) {}
        throw e;
      }
      return { success: true, file: out, size: fs.statSync(out).size };
    } catch (e) { return { success: false, error: e.message }; }
  });

  function localBackupList() {
    const dir = backupsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /\.zip$/i.test(f)).map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, time: st.mtimeMs, source: 'local' };
    });
  }
  function folderBackupList(folder) {
    if (!folder || !fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(f => /\.zip$/i.test(f)).map(f => {
      const st = fs.statSync(path.join(folder, f));
      return { name: f, size: st.size, time: st.mtimeMs, source: 'folder' };
    });
  }

  ipcMain.handle('backup:list', async () => {
    const cfg = loadConfig();
    const map = new Map();
    // key 加 source 前缀，避免本地/云端同名备份互相覆盖
    const put = (items) => items.forEach(it => { map.set((it.source || 'local') + '::' + it.name, it); });
    const wd = cfg.webdav && cfg.webdav.url ? cfg.webdav : null;
    if (wd) { try { put((await getWebdav().list(wd)).map(x => Object.assign({ source: 'webdav' }, x))); } catch (e) {} }
    if (cfg.cloudBackupDir) put(folderBackupList(cfg.cloudBackupDir));
    put(localBackupList());
    return Array.from(map.values()).sort((a, b) => b.time - a.time);
  });

  ipcMain.handle('backup:restore', async (_e, arg) => {
    try {
      const { file, targetDir, source } = arg || {};
      const target = targetDir || sfsDataDir();
      // 备份名只能是文件名：配置或 IPC 被改坏时，别让 path.join 跳出备份目录。
      const safeFile = path.basename(String(file || ''));
      if (!safeFile || safeFile === '.' || safeFile === '..' || safeFile !== String(file || '')) {
        return { success: false, error: '备份文件名非法' };
      }
      fs.mkdirSync(target, { recursive: true });
      const cfg = loadConfig();
      const src = source || 'local';
      let zipPath = null, tmp = null;
      if (src === 'webdav' && cfg.webdav && cfg.webdav.url) {
        tmp = path.join(app.getPath('temp'), 'sfs-restore-' + Date.now() + '.zip');
        await getWebdav().download(cfg.webdav, file, tmp);
        zipPath = tmp;
      } else if (src === 'folder' && cfg.cloudBackupDir) {
        zipPath = path.join(cfg.cloudBackupDir, file);
      } else {
        zipPath = path.join(backupsDir(), file);
      }
      if (!zipPath || !fs.existsSync(zipPath)) return { success: false, error: '备份文件不存在' };
      // 先解到临时目录，确认成功后再替换 Mods/Saving：
      // 原来先删再解，压缩包损坏或中途失败会把现有存档和模组一起弄丢。
      // 先校验 ZIP 条目，拒绝越界路径，再解到临时目录
      try {
        const ZipChk = getAdmZip();
        for (const e of new ZipChk(zipPath).getEntries()) {
          if (zipEntryIsSymlink(e)) {
            return { success: false, error: '备份包含符号链接，已拒绝恢复' };
          }
          const n = String(e.entryName || '');
          if (n.includes('..') || path.isAbsolute(n)) return { success: false, error: '备份包含非法路径：' + n };
        }
      } catch (e) {
        return { success: false, error: '备份文件无法读取：' + e.message };
      }
      const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'sfs-restore-'));
      try {
        const tarExe = process.env.SystemRoot + '\\System32\\tar.exe';
        if (fs.existsSync(tarExe)) {
          await new Promise((resolve, reject) => {
            execFile(tarExe, ['-x', '-f', zipPath, '-C', tmpDir],
              { windowsHide: true, timeout: 600000 },
              (err) => err ? reject(err) : resolve());
          });
        } else {
          const Zip = getAdmZip();
          new Zip(zipPath).extractAllTo(tmpDir, true);
        }
        if (!fs.readdirSync(tmpDir).length) return { success: false, error: '备份包是空的' };
        // 只替换备份包里实际存在的目录；旧包可能只有 Saving，不能顺手把 Mods 删掉。
        // 旧目录先改名保留，复制成功后再删；复制失败则回滚，避免“先删再解”丢数据。
        const moved = [];
        const created = [];
        try {
          for (const sub of ['Mods', 'Saving']) {
            const src = path.join(tmpDir, sub);
            if (!fs.existsSync(src)) continue;
            const d = path.join(target, sub);
            if (fs.existsSync(d)) {
              const bak = d + '.bak-' + Date.now();
              fs.renameSync(d, bak);
              moved.push({ d, bak });
            } else {
              created.push(d);
            }
            fs.cpSync(src, d, { recursive: true, force: true });
          }
        } catch (e) {
          for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
          for (let i = moved.length - 1; i >= 0; i--) {
            const m = moved[i];
            try { fs.rmSync(m.d, { recursive: true, force: true }); } catch (_) {}
            try { fs.renameSync(m.bak, m.d); } catch (_) {}
          }
          throw e;
        }
        for (const m of moved) { try { fs.rmSync(m.bak, { recursive: true, force: true }); } catch (_) {} }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      }
      if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
      return { success: true, target };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('backup:delete', async (_e, arg) => {
    try {
      let file, source;
      if (typeof arg === 'string') { file = arg; source = 'local'; }
      else { file = arg.file; source = arg.source || 'local'; }
      // 备份名只允许文件名，避免 path.join 把 ../ 带出备份目录。
      const safeFile = path.basename(String(file || ''));
      if (!safeFile || safeFile === '.' || safeFile === '..' || safeFile !== String(file || '')) return false;
      file = safeFile;
      const cfg = loadConfig();
      if (source === 'webdav' && cfg.webdav && cfg.webdav.url) { await getWebdav().remove(cfg.webdav, file); return true; }
      if (source === 'folder' && cfg.cloudBackupDir) { fs.unlinkSync(path.join(cfg.cloudBackupDir, file)); return true; }
      fs.unlinkSync(path.join(backupsDir(), file)); return true;
    } catch (e) { return false; }
  });

  ipcMain.handle('webdav:save', async (_e, w) => {
    try {
      const cfg = loadConfig();
      cfg.webdav = { url: (w.url || '').trim(), user: (w.user || '').trim(), pass: w.pass || '' };
      saveConfig(cfg);
      if (cfg.webdav.url) await getWebdav().list(cfg.webdav);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('webdav:test', async (_e, w) => {
    try {
      await getWebdav().list({ url: (w.url || '').trim(), user: w.user || '', pass: w.pass || '' });
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('backup:pickTarget', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled) return { canceled: true };
    return { canceled: false, path: r.filePaths[0] };
  });

  // 下载目录选择
  ipcMain.handle('download:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled) return { canceled: true };
    const cfg = loadConfig();
    cfg.downloadDir = r.filePaths[0];
    saveConfig(cfg);
    return { canceled: false, path: r.filePaths[0] };
  });

  // 云盘备份目录选择
  ipcMain.handle('cloud:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: tx('dlgCloudDir', '选择云盘同步目录（如 OneDrive / 百度网盘 / 坚果云 本地同步文件夹）')
    });
    if (r.canceled) return { canceled: true };
    const cfg = loadConfig();
    cfg.cloudBackupDir = r.filePaths[0];
    saveConfig(cfg);
    return { canceled: false, path: r.filePaths[0] };
  });

  // 异步备份：打包到临时文件 -> WebDAV 直传或复制到同步目录 -> 删除临时文件（启动器本地不留副本）
  ipcMain.handle('backup:createAsync', async () => {
    // 防重入：已有备份在跑就直接返回
    if (_activeBackup) return { success: false, error: '已有备份任务进行中，请等待完成' };
    return new Promise((resolve) => {
      (async () => {
        let tmp = null;
        let childProc = null;
        try {
          const cfg0 = loadConfig();
          const wd = cfg0.webdav && cfg0.webdav.url ? cfg0.webdav : null;
          const folder = (cfg0.cloudBackupDir && fs.existsSync(cfg0.cloudBackupDir)) ? cfg0.cloudBackupDir : null;
          if (!wd && !folder) { resolve({ success: false, needCloud: true, error: '未配置云端备份' }); return; }
          const root = sfsDataDir();
          if (!fs.existsSync(root)) { resolve({ success: false, error: '游戏数据目录不存在：' + root }); return; }
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const name = `sfs-backup-${ts}.zip`;
          tmp = path.join(app.getPath('temp'), name);
          await new Promise((res, rej) => {
            childProc = execFile(process.env.SystemRoot + '\\System32\\tar.exe',
              ['-a', '-c', '-f', tmp, '-C', root, '.'],
              { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 * 10 },
              (err) => { childProc = null; err ? rej(err) : res(); });
            _activeBackup = { childProc: () => childProc, tmpFile: tmp };
          });
          const size = fs.statSync(tmp).size;
          if (wd) {
            try { await getWebdav().upload(wd, tmp, name); }
            catch (e) { resolve({ success: false, error: '上传云端失败：' + e.message }); return; }
            resolve({ success: true, size, cloud: 'webdav', name });
          } else {
            const dest = path.join(folder, name);
            fs.copyFileSync(tmp, dest);
            resolve({ success: true, size, cloud: 'folder', name });
          }
        } catch (e) { resolve({ success: false, error: e.message }); }
        finally {
          // 清理 temp 残留 + 清空活动任务标记
          if (tmp) { try { fs.unlinkSync(tmp); } catch (x) {} }
          _activeBackup = null;
        }
      })();
    });
  });
  ipcMain.handle('mod:showInFolder', (_e, file) => {
    try {
      const root = sfsDataDir();
      const abs = path.isAbsolute(file) ? file : path.join(root, file);
      shell.showItemInFolder(abs);
      return true;
    } catch (e) { return false; }
  });
  ipcMain.handle('mod:openDataDir', () => {
    try { shell.openPath(sfsDataDir()); return true; }
    catch (e) { return false; }
  });

  // ---- 实例右键菜单：打开目录 / 在资源管理器中定位文件 ----
  ipcMain.handle('shell:openPath', (_e, p) => {
    try {
      if (p && fs.existsSync(p)) { shell.openPath(p); return { success: true }; }
      return { success: false, error: '路径不存在' };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('shell:showItem', (_e, p) => {
    try {
      if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return { success: true }; }
      return { success: false, error: '文件不存在' };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 游戏实例图标：以 exe 路径 + 修改时间 为键，内存 Map + userData/icon-cache 落盘，跨重启秒开 ----
  const iconMemCache = new Map();
  const iconCacheDir = path.join(app.getPath('userData'), 'icon-cache');
  async function extractIconFromExe(exePath) {
    try {
      let mtime = 0;
      try { mtime = Math.round(fs.statSync(exePath).mtimeMs); } catch (e) {}
      const key = exePath + '::' + mtime;
      if (iconMemCache.has(key)) return iconMemCache.get(key);
      const crypto = require('crypto');
      const cacheFile = path.join(iconCacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.txt');
      try {
        if (fs.existsSync(cacheFile)) { const d = fs.readFileSync(cacheFile, 'utf8'); iconMemCache.set(key, d); return d; }
      } catch (e) {}
      const img = await app.getFileIcon(exePath, { size: 'large' });
      if (!img || img.isEmpty()) return null;
      const dataUrl = img.toDataURL();
      iconMemCache.set(key, dataUrl);
      try { fs.mkdirSync(iconCacheDir, { recursive: true }); fs.writeFileSync(cacheFile, dataUrl, 'utf8'); } catch (e) {}
      return dataUrl;
    } catch (e) { return null; }
  }

  ipcMain.handle('game:icon', async (_e, id) => {
    try {
      const cfg = loadConfig();
      const inst = cfg.instances.find(i => i.id === id) || cfg.instances[0];
      if (!inst) return { success: false };
      let exe = inst.exePath || '';
      if (!exe && inst.installDir) {
        try {
          for (const n of fs.readdirSync(inst.installDir)) {
            if (/\.exe$/i.test(n) && !/uninstall|unitycrash|crash|setup/i.test(n)) { exe = path.join(inst.installDir, n); break; }
          }
        } catch (e) {}
      }
      if (exe && fs.existsSync(exe)) {
        const dataUrl = await extractIconFromExe(exe);
        if (dataUrl) return { success: true, dataUrl };
      }
    } catch (e) {}
    return { success: false };
  });

  // ---- 按 exe 路径提取图标（安装弹窗预览用） ----
  ipcMain.handle('icon:fromPath', async (_e, exePath) => {
    try {
      if (!exePath || !fs.existsSync(exePath)) return { success: false };
      const dataUrl = await extractIconFromExe(exePath);
      return dataUrl ? { success: true, dataUrl } : { success: false };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 蓝图：删除文件夹（权限与模组一致） ----
  ipcMain.handle('blueprint:remove', async (_e, rel) => {
    try {
      const root = sfsDataDir();
      const bpRoot = path.join(root, 'Saving', 'Blueprints');
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel.split('/').join(path.sep));
      const norm = path.resolve(abs).toLowerCase();
      // 只能删除 Blueprints 下的具体子文件夹；等于根目录或路径越界一律拒绝
      if (!norm.startsWith(path.resolve(bpRoot).toLowerCase() + path.sep)) {
        return { success: false, error: '只能删除具体蓝图文件夹，不能删除 Blueprints 根目录' };
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { success: false, error: '目录不存在或已被删除' };
      await fsTask('removePath', { path: abs }); // 递归删除放 worker，避免界面未响应
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 蓝图：打开文件夹位置 ----
  ipcMain.handle('blueprint:open', (_e, rel) => {
    try {
      const root = sfsDataDir();
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel.split('/').join(path.sep));
      const bpRoot = path.resolve(root, 'Saving', 'Blueprints');
      const absResolved = path.resolve(abs);
      if (absResolved !== bpRoot && !absResolved.startsWith(bpRoot + path.sep)) {
        return { success: false, error: '只能打开蓝图目录内的路径' };
      }
      if (!fs.existsSync(abs)) return { success: false, error: '路径不存在' };
      shell.openPath(abs);
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 代理设置 ----
  async function applyProxy(proxyUrl) {
    const sess = session.fromPartition('persist:sfs');
    try {
      if (proxyUrl && proxyUrl.trim()) {
        await sess.setProxy({ proxyRules: proxyUrl.trim() });
      } else {
        await sess.setProxy({ mode: 'system' });
      }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  }
  ipcMain.handle('proxy:set', async (_e, proxyUrl) => {
    const r = await applyProxy(proxyUrl);
    if (r.success) { const c = loadConfig(); c.proxy = proxyUrl || ''; saveConfig(c); }
    return r;
  });

  ipcMain.handle('autostart:set', (_e, enable) => {
    syncLoginItem(enable);
    const c = loadConfig(); c.autoOpenWithGame = !!enable; saveConfig(c);
    setGlobalGameWatch(!!enable); // 守望随开关启停，关闭后不再轮询、不占资源
    return { success: true };
  });

  // ---- 关闭询问：渲染层弹窗回传选择（action=tray/quit，remember 为是否记住选择） ----
  ipcMain.on('close:decision', (_e, d) => {
    try {
      const action = (d && d.action === 'quit') ? 'quit' : 'tray';
      if (d && d.remember) { const c = loadConfig(); c.closeAction = action; saveConfig(c); }
      if (action === 'quit') { quitApp(); }
      else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.hide(); }
    } catch (e) {}
  });

  // ---- 镜像日志：不修改原日志，生成过滤后的镜像副本再打开 ----
  ipcMain.handle('crash:openFilteredLog', async () => {
    const { dir, files } = (() => {
      const d = path.join(process.env.USERPROFILE || '', 'AppData', 'LocalLow', 'Stef Morojna', 'Spaceflight Simulator');
      const fs2 = ['Player.log', 'Player-prev.log'].map(f => path.join(d, f)).filter(f => fs.existsSync(f));
      return { dir: d, files: fs2 };
    })();
    if (!files.length) return { success: false, error: '未找到日志文件：' + dir };
    try {
      const tmpDir = path.join(app.getPath('temp'), 'sfs-launcher-logs');
      fs.mkdirSync(tmpDir, { recursive: true });
      const opened = [];
      for (const f of files) {
        let raw = '';
        try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        const lines = raw.split(/\r?\n/);
        // 只保留错误/警告/异常相关行及其上下文（镜像，不动原文件）
        const keep = [];
        const re = /(exception|error|fail|fatal|crash|warning|warn|nullreference|missing|cannot|could not|\u5f02\u5e38|\u9519\u8bef|\u5931\u8d25|\u8b66\u544a|\u5d29\u6e83)/i;
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) {
              if (keep.indexOf(j) === -1) keep.push(j);
            }
          }
        }
        keep.sort((a, b) => a - b);
        const filtered = keep.map(i => lines[i]).join('\n');
        const mirror = path.join(tmpDir, tx('logFilterFilePrefix', '过滤-') + path.basename(f) + '.txt');
        fs.writeFileSync(mirror,
          tx('logFilterHead', '===== SFS 日志过滤镜像（原日志未被修改）=====\r\n来源：{1}\r\n生成时间：{2}\r\n\r\n', f, new Date().toLocaleString()) +
          (filtered || tx('logFilterNoHit', '（未在日志中检索到明显的错误/警告关键字，以下为完整日志末尾 200 行）') + '\r\n' + lines.slice(-200).join('\n')),
          'utf8');
        shell.openPath(mirror);
        opened.push(mirror);
      }
      return { success: true, files: opened };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 模组导出分享：把已装模组重新打包成 zip ----
  ipcMain.handle('mod:export', async (_e, index) => {
    try {
      const cfg = loadConfig();
      const entry = cfg.mods.installed[index];
      if (!entry) return { success: false, error: '模组不存在' };
      const root = sfsDataDir();
      const r = await dialog.showSaveDialog(mainWindow, {
        title: tx('dlgExportMod', '导出模组'),
        defaultPath: (entry.name || 'mod').replace(/[\\/:*?"<>|]/g, '_') + '.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      await fsTask('exportZip', { dataDir: root, entry, outPath: r.filePath });
      return { success: true, path: r.filePath };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 读取蓝图文件内容（渲染缩略图用） ----
  ipcMain.handle('blueprint:readFile', (_e, rel) => {
    try {
      const root = sfsDataDir();
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel.split('/').join(path.sep));
      const bpRoot = path.resolve(root, 'Saving', 'Blueprints');
      const absResolved = path.resolve(abs);
      if (absResolved !== bpRoot && !absResolved.startsWith(bpRoot + path.sep)) {
        return { success: false, error: '只能读取蓝图目录内的文件' };
      }
      if (!fs.existsSync(abs)) return { success: false, error: '文件不存在' };
      let txt = fs.readFileSync(abs, 'utf8');
      return { success: true, text: txt.slice(0, 200000) };
    } catch (e) { return { success: false, error: e.message }; }
  });

  // ---- 下载队列：取消任务 ----
  ipcMain.handle('download:cancel', (_e, id) => {
    try {
      const it = activeDownloads.find(x => x.id === id);
      if (it && it.item) { it.item.cancel(); }
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('download:listSync', () => activeDownloads.map(d => ({
    id: d.id, name: d.name, pct: d.pct, state: d.state, recv: d.recv, total: d.total
  })));
  ipcMain.handle('download:clearDone', () => {
    activeDownloads = activeDownloads.filter(d => d.state === 'progressing');
    return { success: true };
  });

  // 蓝图文件夹树：初始只展示文件夹（可展开），展开才显示里面的蓝图文件
  ipcMain.handle('blueprint:tree', async () => {
    try { return await fsTask('blueprintTree', { dataDir: sfsDataDir() }); }
    catch (e) { return { success: false, error: e.message }; }
  });
}

// ---------- 单实例：第二实例唤起并聚焦已有窗口（含托盘常驻时） ----------
// 任务栏图标/分组按 AppUserModelID 归并，否则开发态与打包态可能各挂一个图标
app.setAppUserModelId('com.sfs.launcher');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => showMainWindow());
}

app.whenReady().then(() => {
  __tl('whenReady');
  if (isSelfTest) {
    const sp = resolveSteamPath();
    console.log('SELFTEST_STEAM=' + sp);
    if (sp) {
      const games = scanSteamGames(sp);
      console.log('SELFTEST_GAMES=' + games.length);
      const sfs = findSfs(games);
      console.log('SELFTEST_SFS=' + (sfs ? JSON.stringify({ name: sfs.name, installDir: sfs.installDir }) : 'null'));
    }
    const tmp = path.join(app.getPath('temp'), 'sfs-selftest.zip');
    const z = new (getAdmZip())();
    z.addFile('Parts/MyPack.pack', Buffer.from('PK'));
    z.addFile('mod.dll', Buffer.from('MZ'));
    z.writeZip(tmp);
    console.log('SELFTEST_ZIPTYPE=' + detectZipType(tmp));
    app.exit(0);
    return;
  }

  registerIpc();
  setupDownloadCapture();
  // 应用已保存的代理设置
  try { const c0 = loadConfig(); if (c0.proxy) { const sess0 = session.fromPartition('persist:sfs'); sess0.setProxy({ proxyRules: c0.proxy }); } } catch (e) {}
  // 同步开机自启（手动开游戏唤起启动器）
  try { const c1 = loadConfig(); syncLoginItem(c1.autoOpenWithGame !== false); } catch (e) {}
  const hiddenLaunch = process.argv.includes('--hidden');
  if (!isSmoke) ensureTray();         // 托盘立即创建，资源管理器未就绪时自动重试
  if (isSmoke) {
    createWindow();
  } else if (hiddenLaunch) {
    // 开机自启：等桌面 / DWM / 显卡就绪（约 12 秒）再静默建隐藏窗，避开登录抢占高峰；期间托盘/双击/游戏守望唤起会立即建窗
    hiddenCreateTimer = setTimeout(() => { hiddenCreateTimer = null; try { createWindow(); } catch (e) {} }, 12000);
  } else {
    createWindow();
  }
  if (!isSmoke) {
    try { setGlobalGameWatch(loadConfig().autoOpenWithGame !== false); } catch (e) {}
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 毛玻璃切换会销毁并重建窗口，销毁瞬间触发本事件，此时不能退出整个应用
  if (recreating) return;
  app.quit();
});

// ===== 内嵌浏览器白名单（防 DNS 劫持 / 页面脚本把内嵌页跳到陌生网站）=====
// 固定信任主机（pages.dev 逐子域精确匹配）；用户在开发者模式添加的网址运行时一并并入。
const SFS_TRUSTED_HOSTS = [
  'teamcuriosity.com',
  'steampowered.com',
  'steamcommunity.com',
  'sfszhmod.pages.dev',
  'sfstools.netlify.app',
  'sfs-texture-pack-maker.pages.dev',
  'sfs-planet-pack-generator.pages.dev',
  'sfs-tanguanbang.pages.dev'
];
// 模组/资源文件直链：即使跳到陌生 CDN 主机也放行，交给会话下载，避免误伤
const SFS_FILE_DOWNLOAD_RE = /\.(zip|rar|7z|tar|gz|pack|pck|dll|exe|apk|drawing)(\?|#|$)/i;
function sfsHostMatches(host, base) {
  host = String(host || '').toLowerCase(); base = String(base || '').toLowerCase();
  return host === base || host.endsWith('.' + base);
}
function sfsTrustedHosts() {
  return SFS_TRUSTED_HOSTS.slice();
}
function sfsIsTrustedUrl(url) {
  let u; try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return sfsTrustedHosts().some((h) => sfsHostMatches(u.hostname, h));
}

// 全局拦截：任何新 webContents 产生的 window.open 一律拒绝，改为外部浏览器（杜绝白色空白窗口）
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { try { shell.openExternal(url); } catch (e) {} }
    return { action: 'deny' };
  });
  // 网页内 window.close / 下载页自开窗口等一律封堵
  contents.on('did-create-window', () => {
    try { setImmediate(() => { const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed() && x !== mainWindow); if (w) w.destroy(); }); } catch (e) {}
  });
  // 仅内嵌 <webview>：导航 / 重定向前按白名单拦截，越界网页转系统默认浏览器并提示
  if (contents.getType() === 'webview') {
    const guard = (ev, url) => {
      if (!url || /^(about:|data:|chrome-extension:|devtools:)/i.test(url)) return;
      if (/^https?:/i.test(url)) {
        if (sfsIsTrustedUrl(url) || SFS_FILE_DOWNLOAD_RE.test(url)) return;
        ev.preventDefault();
        try { shell.openExternal(url); } catch (e) {}
        let host = ''; try { host = new URL(url).hostname; } catch (e) {}
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webview:blocked', host); } catch (e) {}
      } else {
        // steam://、mailto: 等非网页协议不在内嵌页跳转，交系统处理
        ev.preventDefault();
        try { shell.openExternal(url); } catch (e) {}
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  }
});
