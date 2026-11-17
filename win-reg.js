// Windows 注册表写入（Unicode Win32 API，经 koffi）。
// 背景：用 child_process 调 reg.exe 写带引号+参数的 Run 值时，在打包后的 Electron
// 进程内会被 reg.exe 判为“无效语法”（命令行引号/编码解析在不同宿主下不一致）。
// 直接调 advapi32!RegSetKeyValueW / RegDeleteKeyValueW，字符串走 UTF-16LE，
// 不经任何命令行解析，引号、空格、中文都按原样写入。koffi 已随毛玻璃模块在打包版验证可用。
'use strict';

let _api = null; // null=未加载, false=失败, object=可用

function loadApi() {
  if (_api !== null) return _api;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('advapi32.dll');
    // LSTATUS RegSetKeyValueW(HKEY, LPCWSTR subKey, LPCWSTR valueName, DWORD type, LPCVOID data, DWORD cbData)
    const setKV = lib.func('int32 RegSetKeyValueW(void *hKey, str16 lpSubKey, str16 lpValueName, uint32 dwType, void *lpData, uint32 cbData)');
    // LSTATUS RegDeleteKeyValueW(HKEY, LPCWSTR subKey, LPCWSTR valueName)
    const delKV = lib.func('int32 RegDeleteKeyValueW(void *hKey, str16 lpSubKey, str16 lpValueName)');
    _api = { setKV, delKV };
  } catch (e) {
    _api = false;
  }
  return _api;
}

const HKEY_CURRENT_USER = 0x80000001;
const RUN_SUBKEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_SZ = 1;

// 写入 HKCU\...\Run 下的一个字符串值（REG_SZ）。返回 { ok, rc }。
function setRunValue(name, value) {
  const api = loadApi();
  if (!api) return { ok: false, rc: -1, err: 'api_unavailable' };
  try {
    const buf = Buffer.from(value + '\0', 'utf16le'); // REG_SZ 需结尾单 null（UTF-16 下两个 0 字节）
    const rc = api.setKV(HKEY_CURRENT_USER, RUN_SUBKEY, name, REG_SZ, buf, buf.length);
    return { ok: rc === 0, rc };
  } catch (e) {
    return { ok: false, rc: -2, err: String((e && e.message) || e) };
  }
}

// 删除 HKCU\...\Run 下的值。ERROR_SUCCESS=0，ERROR_FILE_NOT_FOUND=2 均视为达成。
function deleteRunValue(name) {
  const api = loadApi();
  if (!api) return { ok: false, rc: -1, err: 'api_unavailable' };
  try {
    const rc = api.delKV(HKEY_CURRENT_USER, RUN_SUBKEY, name);
    return { ok: rc === 0 || rc === 2, rc };
  } catch (e) {
    return { ok: false, rc: -2, err: String((e && e.message) || e) };
  }
}

module.exports = { setRunValue, deleteRunValue };
