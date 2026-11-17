// Windows 原生窗口毛玻璃：经 koffi（N-API，自带预编译二进制）调用
// user32!SetWindowCompositionAttribute，对窗口后台启用 DWM 模糊。
//   - Win10 1803（内部版本 17134）及以上：ACCENT_ENABLE_ACRYLICBLURBEHIND（系统亚克力，朦胧噪声模糊）
//   - 更老版本 / 亚克力被关闭：ACCENT_ENABLE_BLURBEHIND（Aero 老式毛玻璃）
// 模糊与 tint 全部由 DWM/系统合成器完成，不占用渲染进程帧时间。
// koffi 采用懒加载：默认关闭毛玻璃时本模块不加载任何原生二进制，启动零额外开销。
// 任何加载或调用失败都安全返回 false / 降级实色，绝不拖垮启动。
'use strict';

const GLASS = require('./glass-config');

let _mod = null;      // null=尚未加载, false=加载失败, object=可用
let loadError = '';
let lastInfo = null;

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const SM_REMOTESESSION = 0x1000;

// 懒加载 koffi 与所需的 user32 / dwmapi 函数。
function load() {
  if (_mod !== null) return _mod;
  try {
    const koffi = require('koffi');
    const AccentPolicy = koffi.struct('SfsAccentPolicy', {
      AccentState: 'uint32',
      AccentFlags: 'uint32',
      GradientColor: 'uint32',
      AnimationId: 'uint32'
    });
    const CompData = koffi.struct('SfsWinCompAttrData', {
      Attrib: 'uint32',
      Data: koffi.pointer(AccentPolicy),
      SizeOfData: 'uint64' // x64 下等价 SIZE_T
    });
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    // SetWindowCompositionAttribute 无官方头文件，但 user32.dll 按名导出，koffi 经 GetProcAddress 解析
    const setAttr = user32.func('int32 SetWindowCompositionAttribute(void *hwnd, SfsWinCompAttrData *data)');
    const getSystemMetrics = user32.func('int32 GetSystemMetrics(int32 nIndex)');
    const dwmIsCompositionEnabled = dwmapi.func('int32 DwmIsCompositionEnabled(int32 *pfEnabled)');
    _mod = { koffi, AccentPolicy, CompData, setAttr, getSystemMetrics, dwmIsCompositionEnabled };
  } catch (e) {
    loadError = String((e && e.message) || e);
    _mod = false;
  }
  return _mod;
}

function isAvailable() {
  return !!load();
}

function lastError() {
  return loadError;
}

// 读取“系统透明效果”开关（HKCU\...\Personalize\EnableTransparency）。
// 仅在手动开启毛玻璃、做能力检测时执行一次；键不存在（老系统）视为开启。
function transparencyEnabledInRegistry() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
      '/v', 'EnableTransparency'
    ], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
    return /0x1\b/i.test(out); // 仅明确为 0x0 才关闭；其它（含无该项）一律视为开启
  } catch (e) {
    return true;
  }
}

/**
 * 运行时能力检测：分级判断能否上亚克力 / Aero，还是只能实色。
 * @param {{build?:number}} opts build=Windows 内部版本号
 * @returns {{acrylic:boolean, aero:boolean, remote:boolean, dwm:boolean, transparency:boolean, build:number}}
 */
function capabilities(opts) {
  const build = (opts && opts.build) || 0;
  const none = { acrylic: false, aero: false, remote: false, dwm: false, transparency: true, build };
  const m = load();
  if (!m) return none;
  let remote = false, dwm = false;
  try { remote = m.getSystemMetrics(SM_REMOTESESSION) !== 0; } catch (e) { remote = false; }
  try {
    const buf = Buffer.alloc(4);
    const hr = m.dwmIsCompositionEnabled(buf);
    dwm = hr === 0 && buf.readInt32LE(0) !== 0;
  } catch (e) { dwm = false; }
  const transparency = transparencyEnabledInRegistry();
  // 远程桌面（RDP）下 DWM 模糊基本不可用，直接排除，避免黑窗/高占用。
  const acrylic = !!(build >= 17134 && dwm && !remote && transparency);
  const aero = !!(build >= 7600 && dwm && !remote);
  return { acrylic, aero, remote, dwm, transparency, build };
}

// Electron getNativeWindowHandle() 返回“指针值”的小端 Buffer，转成整数句柄。
function hwndFromBuffer(buf) {
  let h = 0n;
  for (let i = buf.length - 1; i >= 0; i--) h = (h << 8n) | BigInt(buf[i]);
  return h;
}

// 把 #RRGGBB + alpha 合成 DWM 使用的 0xAABBGGRR（无符号 32 位）
function gradient(hexRRGGBB, alpha) {
  const n = parseInt(String(hexRRGGBB).replace('#', ''), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const a = Math.max(0, Math.min(255, alpha | 0)) >>> 0;
  return (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
}

// 调用一次合成属性。该 API 无官方文档、BOOL 返回值不稳定（社区 C++ 实现直接忽略），
// 只要 koffi 调用未抛异常即视为已提交。koffi 结构体不能 new，需 encode 进预分配 Buffer。
function callPolicy(m, hwndBuf, state, color) {
  let policyBuf = null, dataBuf = null;
  try {
    policyBuf = Buffer.alloc(m.koffi.sizeof(m.AccentPolicy));
    m.koffi.encode(policyBuf, m.AccentPolicy, {
      AccentState: state,
      AccentFlags: 2,
      GradientColor: color >>> 0,
      AnimationId: 0
    });
    dataBuf = Buffer.alloc(m.koffi.sizeof(m.CompData));
    m.koffi.encode(dataBuf, m.CompData, {
      Attrib: WCA_ACCENT_POLICY,
      Data: policyBuf,
      SizeOfData: m.koffi.sizeof(m.AccentPolicy)
    });
    const ret = m.setAttr(hwndFromBuffer(hwndBuf), dataBuf);
    lastInfo = { state, color: color >>> 0, ret };
    return true;
  } catch (e) {
    lastInfo = { state, color: color >>> 0, threw: String((e && e.message) || e) };
    return false;
  }
}

/**
 * 应用窗口材质。
 * @param {Buffer} hwndBuf mainWindow.getNativeWindowHandle()
 * @param {{enabled?:boolean, theme?:'dark'|'light', build?:number, state?:3|4,
 *          darkAlpha?:number, lightAlpha?:number}} opts
 *   state 显式指定 4=亚克力 / 3=Aero；不传则按 build 选择。
 * @returns {boolean} 调用是否已成功提交
 */
function apply(hwndBuf, opts) {
  const m = load();
  if (!m || !hwndBuf) return false;
  try {
    const o = opts || {};
    if (o.enabled === false) {
      return callPolicy(m, hwndBuf, ACCENT_DISABLED, 0);
    }
    const dark = (o.theme || 'dark') !== 'light';
    const state = o.state === 3 || o.state === 4
      ? o.state
      : ((o.build || 0) >= 17134 ? ACCENT_ENABLE_ACRYLICBLURBEHIND : ACCENT_ENABLE_BLURBEHIND);
    // 底色与 tint alpha 统一取自 glass-config.js；显式传入的 darkAlpha/lightAlpha 仍可覆盖。
    const base = GLASS.baseColor[dark ? 'dark' : 'light'];
    const ta = dark ? GLASS.tintAlpha.dark : GLASS.tintAlpha.light;
    const alpha = dark
      ? (typeof o.darkAlpha === 'number' ? o.darkAlpha : (state === 4 ? ta.acrylic : ta.aero))
      : (typeof o.lightAlpha === 'number' ? o.lightAlpha : (state === 4 ? ta.acrylic : ta.aero));
    return callPolicy(m, hwndBuf, state, gradient(base, alpha));
  } catch (e) {
    lastInfo = { threw: String((e && e.message) || e) };
    return false;
  }
}

function info() { return lastInfo; }

module.exports = { isAvailable, apply, capabilities, lastError, info };
