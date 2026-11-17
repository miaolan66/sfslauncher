// win-proc.js —— 轻量原生进程 / 顶层窗口枚举（koffi 直调 Win32，毫秒级、无子进程）。
// 替代旧实现里每 3 秒拉起的 tasklist / PowerShell：那类子进程轮询常驻吃 CPU、响应慢。
//   - kernel32!CreateToolhelp32Snapshot + Process32First/NextW：枚举进程名 / PID
//   - user32!EnumWindows + IsWindowVisible + GetWindowTextW + GetWindowThreadProcessId：枚举可见顶层窗口
// koffi 懒加载：仅在游戏守望 / 崩溃检测实际运行时才加载原生二进制。
// 任何失败都安全返回“未发现”，绝不抛到主进程。
'use strict';

let _m = null; // null=未加载, false=失败, object=可用
let _loadErr = '';

function load() {
  if (_m !== null) return _m;
  try {
    const koffi = require('koffi');
    const PROCESSENTRY32W = koffi.struct('SfsProcessEntry32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'void*',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: 'uint16 [260]'
    });
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const createSnapshot = kernel32.func('void* CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
    const process32First = kernel32.func('bool Process32FirstW(void* hSnapshot, SfsProcessEntry32W* lppe)');
    const process32Next = kernel32.func('bool Process32NextW(void* hSnapshot, SfsProcessEntry32W* lppe)');
    const closeHandle = kernel32.func('bool CloseHandle(void* hObject)');
    const isWindowVisible = user32.func('bool IsWindowVisible(void* hWnd)');
    const getWindowTextLengthW = user32.func('int32 GetWindowTextLengthW(void* hWnd)');
    const getWindowTextW = user32.func('int32 GetWindowTextW(void* hWnd, uint16* lpString, int32 nMaxCount)');
    const getWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hWnd, uint32* lpdwProcessId)');
    const enumWindowsProto = koffi.proto('bool SfsEnumWindowsProc(void* hWnd, void* lParam)');
    const enumWindows = user32.func('bool EnumWindows(SfsEnumWindowsProc* lpEnumFunc, void* lParam)');
    _m = {
      koffi, PROCESSENTRY32W,
      createSnapshot, process32First, process32Next, closeHandle,
      isWindowVisible, getWindowTextLengthW, getWindowTextW, getWindowThreadProcessId,
      enumWindowsProto, enumWindows
    };
  } catch (e) {
    _loadErr = String((e && e.message) || e);
    _m = false;
  }
  return _m;
}

function isAvailable() { return !!load(); }
function lastError() { return _loadErr; }

const TH32CS_SNAPPROCESS = 0x00000002;
const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn;

// 把内联 WCHAR[260]（koffi 解码为 number 数组 / TypedArray）拼成以 0 结尾的字符串
function decodeWide(arr) {
  if (!arr) return '';
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function normExe(n) {
  return String(n || '').toLowerCase().replace(/\.exe$/, '').trim();
}

/**
 * 枚举全部进程（名 + PID）。
 * @returns {{name:string, pid:number}[]}
 */
function listProcesses() {
  const m = load();
  if (!m) return [];
  const out = [];
  let snap = null;
  try {
    snap = m.createSnapshot(TH32CS_SNAPPROCESS, 0);
    if (!snap || snap === INVALID_HANDLE) return [];
    const size = m.koffi.sizeof(m.PROCESSENTRY32W);
    const buf = Buffer.alloc(size);
    m.koffi.encode(buf, m.PROCESSENTRY32W, { dwSize: size, cntUsage: 0, th32ProcessID: 0, th32DefaultHeapID: null, th32ModuleID: 0, cntThreads: 0, th32ParentProcessID: 0, pcPriClassBase: 0, dwFlags: 0, szExeFile: [] });
    if (m.process32First(snap, buf)) {
      do {
        const pe = m.koffi.decode(buf, m.PROCESSENTRY32W);
        out.push({ name: decodeWide(pe.szExeFile), pid: pe.th32ProcessID >>> 0 });
      } while (m.process32Next(snap, buf));
    }
  } catch (e) {
    return out;
  } finally {
    if (snap && snap !== INVALID_HANDLE) { try { m.closeHandle(snap); } catch (e) {} }
  }
  return out;
}

function matchAny(name, targetsNorm) {
  const n = normExe(name);
  if (!n) return false;
  for (const t of targetsNorm) if (t && (n === t || n.endsWith(t))) return true;
  return false;
}

/** 是否存在任一目标进程。targets 为 exe 名（带不带 .exe 均可）。 */
function processRunning(targets) {
  const list = targets || [];
  if (!list.length) return false;
  const tn = list.map(normExe).filter(Boolean);
  if (!tn.length) return false;
  return listProcesses().some(p => matchAny(p.name, tn));
}

/** 返回匹配目标进程的 PID 集合。 */
function processIds(targets) {
  const tn = (targets || []).map(normExe).filter(Boolean);
  const set = new Set();
  if (!tn.length) return set;
  for (const p of listProcesses()) if (matchAny(p.name, tn)) set.add(p.pid);
  return set;
}

function windowTitle(m, hwnd) {
  try {
    const len = m.getWindowTextLengthW(hwnd);
    if (len <= 0) return '';
    const n = Math.min(len + 1, 512);
    const buf = Buffer.alloc(n * 2);
    const got = m.getWindowTextW(hwnd, buf, n);
    return buf.toString('utf16le', 0, Math.max(0, got) * 2);
  } catch (e) { return ''; }
}

/**
 * 查找 Unity 崩溃窗口。
 *
 * 旧判据要求标题同时含 “Spaceflight Simulator” 与 “Unity”，且窗口属主必须是游戏进程的 PID。
 * 这两条都不成立：Unity 的崩溃对话框由 UnityCrashHandler64.exe 弹出，属主永远不在游戏 PID 集合里；
 * 标题也常常只有产品名，或只剩 “Unity 20xx”。结果是真实崩溃全部漏判。
 *
 * 现在的判据：
 *   - 属主落在「游戏进程 ∪ UnityCrashHandler」；
 *   - 标题含 spaceflight（含 SFS 产品名）即认，不管属主是谁；
 *   - 属主是崩溃处理器且标题含 unity，在游戏进程仍在跑时也认（覆盖只有 “Unity 20xx” 的框）。
 * 仍然排除标题带“启动器”的窗口，避免把启动器自身的弹窗算进来。
 * @returns {{title:string, pid:number}|null}
 */
function findUnityCrash(targets) {
  const m = load();
  if (!m) return null;
  const HANDLER = ['UnityCrashHandler64.exe', 'UnityCrashHandler32.exe', 'UnityCrashHandler.exe'];
  let pids = null;
  let handlerPids = null;
  try { pids = processIds(targets); } catch (e) { pids = new Set(); }
  try { handlerPids = processIds(HANDLER); } catch (e) { handlerPids = new Set(); }
  const gameAlive = pids.size > 0;
  let hit = null;
  let cb = null;
  try {
    cb = m.koffi.register((hwnd) => {
      try {
        if (!m.isWindowVisible(hwnd)) return true; // 继续枚举
        const pbuf = Buffer.alloc(4);
        m.getWindowThreadProcessId(hwnd, pbuf);
        const pid = pbuf.readUInt32LE(0);
        const inGame = pids.has(pid);
        const inHandler = handlerPids.has(pid);
        if (!inGame && !inHandler) return true;
        const title = windowTitle(m, hwnd);
        if (!title) return true;
        if (/启动器/.test(title)) return true;
        if (/spaceflight/i.test(title)) { hit = { title, pid }; return false; }
        if (inHandler && /unity/i.test(title) && gameAlive) { hit = { title, pid }; return false; }
      } catch (e) {}
      return true;
    }, m.koffi.pointer(m.enumWindowsProto));
    m.enumWindows(cb, null);
  } catch (e) {
    hit = null;
  } finally {
    if (cb) { try { cb.close(); } catch (e) {} }
  }
  return hit;
}

module.exports = { isAvailable, lastError, listProcesses, processRunning, processIds, findUnityCrash };
