'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 首帧防闪（preload 在 document-start 执行，早于页面首帧绘制）：同步取主进程初始主题/玻璃/材质，
// 立即写到 <html>，让首次样式计算就是目标材质（玻璃透明背景 + 深浅变量），根除开窗先实色后跳变的闪烁。
(function () {
  var ini = null;
  try { ini = ipcRenderer.sendSync('glass:initial'); } catch (e) { ini = null; }
  var applied = false;
  function applyState() {
    if (applied) return true;
    var root = document.documentElement;
    if (!root) return false;
    try {
      if (ini) {
        var theme = (ini.theme === 'light' || ini.theme === 'dark') ? ini.theme : 'dark';
        root.setAttribute('data-theme', theme);
        var mat = null;
        if (ini.enabled === true) {
          root.classList.add('glass');
          if (ini.mode === 'dwm' || ini.mode === 'acrylic' || ini.mode === 'aero' || ini.mode === 'mica') {
            mat = 'glass-' + ini.mode;
            root.classList.add(mat);
          }
        }
        if (ini.transition === true) {
          root.classList.add('glass-mask-on');
          ipcRenderer.on('glass:transition-fade', function () {
            try {
              root.classList.add('glass-mask-fade');
              setTimeout(function () { root.classList.remove('glass-mask-on', 'glass-mask-fade'); }, 340);
            } catch (e) {}
          });
        }
        var syncBody = function () {
          if (!document.body) return;
          document.body.classList.toggle('glass', ini.enabled === true);
          if (mat) document.body.classList.add(mat);
        };
        if (document.body) syncBody();
        else document.addEventListener('DOMContentLoaded', syncBody, { once: true });
      }
      applied = true;
      return true;
    } catch (e) { return false; }
  }
  // document-start 时 <html> 可能尚未创建；先立即试一次，否则在 documentElement 插入的最早时刻补写，务必早于首帧。
  if (!applyState()) {
    try {
      var obs = new MutationObserver(function () {
        if (applyState()) { try { obs.disconnect(); } catch (e) {} }
      });
      obs.observe(document, { childList: true });
      document.addEventListener('DOMContentLoaded', function () { applyState(); }, { once: true });
    } catch (e) {
      document.addEventListener('DOMContentLoaded', function () { applyState(); }, { once: true });
    }
  }
})();

contextBridge.exposeInMainWorld('launcher', {
  // 冒烟/抓图模式标记：渲染端据此不弹新手引导，避免污染截图
  smokeMode: (() => { try { return !!ipcRenderer.sendSync('app:is-smoke'); } catch (e) { return false; } })(),
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (cfg) => ipcRenderer.invoke('config:save', cfg),
  appInfo: () => ipcRenderer.invoke('app:info'),
  // 原生界面（托盘 / 文件对话框 / 导出文件）文案，由渲染层按当前语言推送
  appSetTexts: (bundle) => ipcRenderer.invoke('app:set-texts', bundle),
  glassSetState: (s) => ipcRenderer.invoke('glass:state', s),
  glassMaterialFallback: () => ipcRenderer.invoke('glass:material-fallback'),
  glassInitialSync: () => ipcRenderer.sendSync('glass:initial'),
  uiReady: () => ipcRenderer.send('ui:ready'),
  onGlassMaterialResult: (cb) => ipcRenderer.on('glass:material-result', (_e, d) => cb(d)),
  onGlassTransitionFade: (cb) => ipcRenderer.on('glass:transition-fade', () => cb()),
  onGlassModeChanged: (cb) => ipcRenderer.on('glass:mode-changed', (_e, d) => cb(d)),

  winMin: () => ipcRenderer.invoke('window:minimize'),
  winMax: () => ipcRenderer.invoke('window:maximize'),
  winClose: () => ipcRenderer.invoke('window:close'),
  onClosePrompt: (cb) => ipcRenderer.on('close:prompt', () => cb()),
  closeDecision: (d) => ipcRenderer.send('close:decision', d),

  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  shellOpenPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  shellShowItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  steamResolve: () => ipcRenderer.invoke('steam:resolvePath'),
  steamScan: () => ipcRenderer.invoke('steam:scan'),
  steamScanWithPath: (dir) => ipcRenderer.invoke('steam:scanWithPath', dir),
  steamSelectDir: () => ipcRenderer.invoke('steam:selectDir'),

  gameAdd: (game) => ipcRenderer.invoke('game:add', game),
  gameSelectPath: () => ipcRenderer.invoke('game:selectPath'),
  gameSetCurrent: (id) => ipcRenderer.invoke('game:setCurrent', id),
  gameRemove: (id) => ipcRenderer.invoke('game:remove', id),
  gameLaunch: (id) => ipcRenderer.invoke('game:launch', id),
  gameIcon: (id) => ipcRenderer.invoke('game:icon', id),
  iconFromPath: (exePath) => ipcRenderer.invoke('icon:fromPath', exePath),

  modDataDir: () => ipcRenderer.invoke('mod:dataDir'),
  readWorlds: () => ipcRenderer.invoke('game:readWorlds'),
  modPickZip: (kind) => ipcRenderer.invoke('mod:pickZip', kind),
  modDownloadURL: (url) => ipcRenderer.invoke('mod:downloadURL', url),
  modDeploy: (zipPath, type, version) => ipcRenderer.invoke('mod:deploy', { zipPath, type, version }),
  modList: () => ipcRenderer.invoke('mod:list'),
  modExportList: (fmt) => ipcRenderer.invoke('mod:exportList', fmt),
  instBackup: (id) => ipcRenderer.invoke('inst:backup', id),
  instRestore: (id) => ipcRenderer.invoke('inst:restore', id),
  gamePrecheck: (id) => ipcRenderer.invoke('game:precheck', id),
  modRemovePending: (p) => ipcRenderer.invoke('mod:removePending', p),
  modRemoveInstalled: (index) => ipcRenderer.invoke('mod:removeInstalled', index),
  modScanInstalled: () => ipcRenderer.invoke('mod:scanInstalled'),
  modPickSolar: () => ipcRenderer.invoke('mod:pickSolar'),
  modClearHistory: () => ipcRenderer.invoke('mod:clearHistory'),
  pickHeroBg: () => ipcRenderer.invoke('hero:pickBg'),
  heroClearBg: () => ipcRenderer.invoke('hero:clearBg'),
  wallpaperPick: () => ipcRenderer.invoke('wallpaper:pick'),
  wallpaperImportCopy: (src) => ipcRenderer.invoke('wallpaper:importCopy', src),
  wallpaperImportDataUrl: (dataUrl) => ipcRenderer.invoke('wallpaper:importDataUrl', dataUrl),
  wallpaperRemoveFile: (path) => ipcRenderer.invoke('wallpaper:removeFile', path),
  modImportFile: (path, instId) => ipcRenderer.invoke('mod:importFile', { path, instId }),
  gameOpenPlayerLog: () => ipcRenderer.invoke('game:openPlayerLog'),
  modOpenDataDir: () => ipcRenderer.invoke('mod:openDataDir'),
  modShowInFolder: (file) => ipcRenderer.invoke('mod:showInFolder', file),
  blueprintTree: () => ipcRenderer.invoke('blueprint:tree'),
  blueprintRemove: (rel) => ipcRenderer.invoke('blueprint:remove', rel),
  blueprintOpen: (rel) => ipcRenderer.invoke('blueprint:open', rel),

  crashLogFiles: () => ipcRenderer.invoke('crash:logFiles'),
  crashOpenLog: () => ipcRenderer.invoke('crash:openLog'),
  crashCopyLogs: () => ipcRenderer.invoke('crash:copyLogs'),
  crashAskDoubao: () => ipcRenderer.invoke('crash:askDoubao'),
  onGameCrashed: (cb) => ipcRenderer.on('game:crashed', () => cb()),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupRestore: (file, targetDir, source) => ipcRenderer.invoke('backup:restore', { file, targetDir, source }),
  backupDelete: (file, source) => ipcRenderer.invoke('backup:delete', { file, source }),
  backupPickTarget: () => ipcRenderer.invoke('backup:pickTarget'),
  onModsChanged: (cb) => ipcRenderer.on('mods:changed', () => cb()),
  onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (_e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, d) => cb(d)),
  onDownloadError: (cb) => ipcRenderer.on('download:error', (_e, d) => cb(d)),
  downloadPickDir: () => ipcRenderer.invoke('download:pickDir'),
  cloudPickDir: () => ipcRenderer.invoke('cloud:pickDir'),
  webdavSave: (w) => ipcRenderer.invoke('webdav:save', w),
  webdavTest: (w) => ipcRenderer.invoke('webdav:test', w),
  downloadCancel: (id) => ipcRenderer.invoke('download:cancel', id),
  downloadList: () => ipcRenderer.invoke('download:listSync'),
  downloadClearDone: () => ipcRenderer.invoke('download:clearDone'),
  backupCreateAsync: () => ipcRenderer.invoke('backup:createAsync'),
  proxySet: (u) => ipcRenderer.invoke('proxy:set', u),
  autostartSet: (en) => ipcRenderer.invoke('autostart:set', en),
  crashOpenFiltered: () => ipcRenderer.invoke('crash:openFilteredLog'),
  modExport: (i) => ipcRenderer.invoke('mod:export', i),
  blueprintReadFile: (rel) => ipcRenderer.invoke('blueprint:readFile', rel),
  systemInfo: () => ipcRenderer.invoke('system:info'),
  openLogDir: () => ipcRenderer.invoke('log:openDir'),
  openAppDir: () => ipcRenderer.invoke('app:openDir'),
  getLogDir: () => ipcRenderer.invoke('log:getDir'),
  hanInfo: () => ipcRenderer.invoke('han:info'),
  hanOpen: (instId) => ipcRenderer.invoke('han:open', instId)
});
