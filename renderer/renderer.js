/* ================================================================
 * SFS 启动器 - 渲染进程
 * ================================================================ */

try { if (!window.__BOOTR) { window.__BOOTR = {}; } if (!window.__bt) { window.__bt = function (k) { window.__BOOTR[k] = Math.round(performance.now()); }; } window.__bt('renderer_js_loaded'); } catch (e) {}
const isElectron = !!(window.launcher && window.launcher.configLoad);
const SFS_APPID = '1718870';

// ===== 通用分段胶囊控件 =====
function initSegmentCapsule(containerId, currentValue, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const options = container.querySelectorAll('.seg-option');
  const slider = container.querySelector('.seg-slider');

  function moveSlider(optionEl) {
    if (!slider || !optionEl) return;
    if (!optionEl.offsetWidth) return; // 隐藏页面中宽度为0，跳过（切换显示时再刷新）
    slider.style.width = optionEl.offsetWidth + 'px';
    slider.style.transform = 'translateX(' + (optionEl.offsetLeft - 3) + 'px)';
  }

  function setActive(value, triggerChange = true) {
    let target = null;
    options.forEach(opt => {
      const match = opt.dataset.value === String(value);
      opt.classList.toggle('active', match);
      if (match) target = opt;
    });
    if (target) moveSlider(target);
    if (triggerChange && onChange) onChange(value);
  }

  // 重新计算滑块（页面从隐藏变为显示后调用）
  function refresh() {
    const active = container.querySelector('.seg-option.active');
    if (active) moveSlider(active);
  }

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      const val = opt.dataset.value;
      if (opt.classList.contains('active')) return;
      setActive(val);
    });
  });

  // 初始化
  setActive(currentValue, false);
  // 注册到全局，供视图切换后统一刷新（隐藏页面初始化时 offsetWidth 为 0）
  window.__capsules = window.__capsules || [];
  window.__capsules.push(refresh);
  // DOM 渲染后再修正一次滑块位置
  requestAnimationFrame(refresh);
  // 窗口大小变化时重新计算滑块位置
  window.addEventListener('resize', refresh);

  return { set: setActive, refresh };
}

// 设置页平铺小按钮组（无滑轨、无展开窗）：独立按钮各自选中态，替代旧胶囊。
function initButtonGroup(containerId, currentValue, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const btns = container.querySelectorAll('.seg-btn');
  function setActive(value, triggerChange = true) {
    btns.forEach(b => b.classList.toggle('is-active', b.dataset.value === String(value)));
    if (triggerChange && onChange) onChange(value);
  }
  btns.forEach(b => b.addEventListener('click', () => {
    if (b.classList.contains('is-active')) return;
    setActive(b.dataset.value);
  }));
  setActive(currentValue, false);
  return { set: setActive, refresh: () => {} };
}

// ---- 设置页分类导航：顶部小按钮筛选面板，原有设置控件保持胶囊 ----
function initSettingsNav() {
  const nav = document.getElementById('settings-nav');
  const view = document.getElementById('view-settings');
  if (!nav || !view) return;
  const targets = view.querySelectorAll('.panel[data-cat], .settings-group-title[data-cat], .section-title-row[data-cat]');
  const btns = nav.querySelectorAll('.seg-btn');
  function show(cat) {
    btns.forEach(b => b.classList.toggle('is-active', b.dataset.cat === cat));
    targets.forEach(el => { el.style.display = (cat === 'all' || el.dataset.cat === cat) ? '' : 'none'; });
    requestAnimationFrame(refreshAllCapsules);
  }
  btns.forEach(b => b.addEventListener('click', () => show(b.dataset.cat)));
  show('all');
}

// 视图切换后统一刷新所有可见胶囊滑块
function refreshAllCapsules() {
  if (!window.__capsules) return;
  requestAnimationFrame(() => window.__capsules.forEach(fn => { try { fn(); } catch (e) {} }));
}

// 深浅切换过渡动画（已按用户要求移除，保留空函数以免调用点报错）
function playThemeAnim() {}
// ===== END 分段胶囊控件 =====

// ---- 网页版兼容层（无 Electron API 时用 localStorage 模拟） ----
if (!isElectron) {
  const STORE = 'sfs-launcher-web';
  const read = () => JSON.parse(localStorage.getItem(STORE) || 'null') || {
    instances: [],
    devMode: false,
    theme: 'dark',
    glass: false,
    mods: { pending: [], installed: [] }
  };
  const write = (c) => localStorage.setItem(STORE, JSON.stringify(c));
  const desktopOnly = () => Promise.resolve({ success: false, error: '该功能仅桌面客户端（EXE）可用' });
  window.launcher = {
    configLoad: async () => read(),
    configSave: async (c) => { write(c); return true; },
    appInfo: async () => ({ version: '1.3.0 (Web)', configPath: 'localStorage', glassMode: 'fallback' }),
    glassSetState: async () => ({ ok: false, mode: 'fallback' }),
    winMin: async () => {}, winMax: async () => false, winClose: async () => window.close(),
    openExternal: async (u) => { window.open(u, '_blank'); },
    steamResolve: async () => '',
    steamScan: desktopOnly,
    steamScanWithPath: desktopOnly,
    steamSelectDir: async () => ({ canceled: true }),
    gameAdd: async (g) => {
      const c = read(); c.instances.push({ id: String(Date.now()), name: g.name, exePath: g.exePath, installDir: g.installDir, appId: g.appId, current: c.instances.length === 0 });
      write(c); return { success: true, instances: c.instances };
    },
    gameSelectPath: async () => ({ canceled: true }),
    gameSetCurrent: async (id) => {
      const c = read(); c.instances.forEach(i => i.current = i.id === id); write(c);
    },
    gameRemove: async (id) => {
      const c = read(); c.instances = c.instances.filter(i => i.id !== id); write(c); return c.instances;
    },
    gameLaunch: async () => ({ success: false, error: '请使用桌面客户端启动游戏' }),
    modDataDir: desktopOnly,
    modPickZip: async () => ({ canceled: true }),
    modDeploy: desktopOnly,
    modList: async () => { const c = read(); return c.mods; },
    modRemovePending: async (p) => { const c = read(); c.mods.pending = c.mods.pending.filter(x => x.path !== p); write(c); return c.mods.pending; },
    modRemoveInstalled: async () => true,
    modScanInstalled: desktopOnly,
    modOpenDataDir: async () => false,
    modShowInFolder: desktopOnly,
    modExport: desktopOnly,
    shellOpenPath: desktopOnly,
    shellShowItem: desktopOnly,
    iconFromPath: desktopOnly,
    crashOpenFiltered: desktopOnly,
    onModsChanged: () => {},
    gameIcon: async () => ({ success: false }),
    blueprintTree: desktopOnly,
    blueprintRemove: desktopOnly,
    blueprintOpen: desktopOnly,
    backupList: desktopOnly,
    backupCreate: desktopOnly,
    backupRestore: desktopOnly,
    backupDelete: desktopOnly,
    backupPickTarget: async () => ({ canceled: true }),
    crashLogFiles: desktopOnly,
    crashOpenLog: desktopOnly,
    crashCopyLogs: desktopOnly,
    crashAskDoubao: desktopOnly,
    onGameCrashed: () => {},
    onClosePrompt: () => {},
    closeDecision: async () => {}
  };
}

// ---- 全局状态 ----
const state = {
  cfg: null,
  scanning: false,
  scanGames: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.hidden = true; }, ms);
}

function showModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal').hidden = false;
  document.body.classList.add('modal-open');
}
function hideModal() { $('#modal').hidden = true; document.body.classList.remove('modal-open'); }

// ---- 通用确认弹窗（替代系统 confirm/alert，扁平、跟随主题，返回 Promise<bool>） ----
function appConfirm(o) {
  const opts = o || {};
  return new Promise(resolve => {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = opts.title || '确认操作';
    const body = $('#confirm-body');
    body.textContent = opts.body || '';
    const ok = $('#confirm-ok'), cancel = $('#confirm-cancel');
    ok.textContent = opts.okText || '确定';
    cancel.textContent = opts.cancelText || '取消';
    cancel.style.display = (opts.cancelText === null) ? 'none' : '';
    ok.classList.toggle('danger', !!opts.danger);
    dlg.hidden = false;
    document.body.classList.add('modal-open');
    const cleanup = () => { ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); document.body.classList.remove('modal-open'); };
    const onOk = () => { dlg.hidden = true; cleanup(); resolve(true); };
    const onCancel = () => { dlg.hidden = true; cleanup(); resolve(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}
async function appAlert(o) {
  const opts = o || {};
  return appConfirm({ title: opts.title || '提示', body: opts.body || '', okText: opts.okText || '知道了', cancelText: null });
}

// ---- 实例右键菜单 ----
function openCtxMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  (items || []).forEach(it => {
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    d.addEventListener('click', () => { hideCtxMenu(); if (it.onClick) it.onClick(); });
    menu.appendChild(d);
  });
  menu.hidden = false;
  const mw = menu.offsetWidth || 160, mh = menu.offsetHeight || 120;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 8)) + 'px';
}
function hideCtxMenu() { const m = $('#ctx-menu'); if (m) m.hidden = true; }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.game-card')) hideCtxMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtxMenu(); } });
window.addEventListener('blur', hideCtxMenu);

// ---- 游戏图标渲染端缓存（gid -> dataURL），配合主进程多级缓存，切换页面不重复提取、不闪默认图 ----
const iconRenderCache = new Map();

// ---- 导航 ----
$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    $('#view-' + item.dataset.view).classList.add('active');
    // 进入蓝图页时自动刷新文件夹树（只扫文件夹）
    if (item.dataset.view === 'blueprint') renderBlueprintTree();
    if (item.dataset.view === 'mods' && window.VirtInstalled) VirtInstalled.refresh(true);
    if (item.dataset.view === 'modstore') loadModstore(); // 首次进入商店页就加载列表，不必点分类才出
    // 隐藏页面中的胶囊滑块初始宽度为0，切换显示后统一重算
    refreshAllCapsules();
  });
});

// ---- 标题栏 ----
$('#btn-min').addEventListener('click', () => window.launcher.winMin());
$('#btn-max').addEventListener('click', () => window.launcher.winMax());
$('#btn-close').addEventListener('click', () => window.launcher.winClose());

// ---- 主题 & 毛玻璃 ----
// 记录最近一次指针位置，作为主题水波纹的起点
const lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener('pointerdown', (e) => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; }, true);

/* 主题 / 毛玻璃 / 过渡动画逻辑已抽离到 app-theme.js（window.AppTheme），
   渲染端不再保留本地实现，运行时状态统一从 AppTheme 读取，避免多处读写造成表现不一致。 */
// 重内容（磁盘扫描 / 图标提取 / 长列表）延后到窗口首帧显示之后分片执行，
// 避免开玻璃重建窗口或冷启动时同步扫描阻塞首帧，造成整窗卡顿 / 未响应。
let heavyScheduled = false;
function scheduleHeavyRenders() {
  if (heavyScheduled) return;
  heavyScheduled = true;
  // 统一走 idle-tasks.js 的首帧后分片队列：每项之间让出主线程，保持动画/交互流畅。
  IdleTasks.run([
    () => renderGames(),
    async () => { await renderMods(); },
    () => renderBackups(),
    async () => { await renderBlueprintTree(); }
  ]);
}

// ---- 配置加载 ----
async function init() {
  try { window.__bt && window.__bt('init_start'); } catch (e) {}
  state.cfg = await window.launcher.configLoad();
  // 防御：确保关键字段存在，避免空值导致渲染中断
  if (!Array.isArray(state.cfg.instances)) state.cfg.instances = [];
  if (!state.cfg.mods || typeof state.cfg.mods !== 'object') state.cfg.mods = { pending: [], installed: [] };
  if (!Array.isArray(state.cfg.mods.pending)) state.cfg.mods.pending = [];
  if (!Array.isArray(state.cfg.mods.installed)) state.cfg.mods.installed = [];
  try { window.__bt && window.__bt('config_loaded'); } catch (e) {}
  // 先把配置交给主题控制器，并在首帧前定好深浅/毛玻璃材质类，避免首帧闪默认主题。
  AppTheme.setCfg(state.cfg);
  AppTheme.applyTheme(state.cfg.theme || 'dark');
  // 琉璃控制器：壁纸 / 取色派生 / 材质参数，独立于 DWM 材质链路
  try { LiuliTheme.setCfg(state.cfg); LiuliTheme.apply(); } catch (e) { console.warn('liuli apply failed:', e); }
  // 性能档位标识：弱机档（weak）挂 html.perf-weak，CSS 据此砍掉全屏模糊/重 hover 阴影/长过渡，保证点击流畅。
  try {
    const _sysInfo = await window.launcher.systemInfo?.() || {};
    if ((_sysInfo.tier || 'medium') === 'weak') document.documentElement.classList.add('perf-weak');
  } catch (e) {}
  // 首帧只渲染轻量外壳（关于），保证窗口（尤其开玻璃重建时）立即显示、不长时间无响应
  renderAbout();
  // 立即渲染实例列表（读内存不耗时，图标异步提取），避免用户看到空列表以为数据丢了
  try { renderGames(); } catch (e) { console.warn('renderGames failed:', e); }
  try { window.__bt && window.__bt('shell_rendered'); } catch (e) {}
  // 游戏 / 模组 / 存档 / 蓝图涉及磁盘扫描、图标提取与长列表，延后到首帧绘制之后分片执行
  scheduleHeavyRenders();
  // 加载世界数据（挑战进度 + 游玩时间）
  loadWorldStats();
  // 新手引导：首启自动播一次，冒烟抓图模式自动跳过
  try { window.Onboarding && Onboarding.maybeAutoStart(state.cfg); } catch (e) {}
  try {
    const ast = $('#autoshow-toggle'); if (ast) ast.checked = !!state.cfg.autoShowOnLaunch;
    const cas = $('#close-action-select'); if (cas) cas.value = state.cfg.closeAction || 'ask';
    const dl = $('#dl-dir-label'); if (dl) dl.textContent = state.cfg.downloadDir || '未设置（默认浏览器下载目录）';
    const cl = $('#cloud-dir-label'); if (cl) cl.textContent = state.cfg.cloudBackupDir || '未设置（备份前会提醒你选择，不选择则不备份）';
    const wd0 = state.cfg.webdav || {};
    if ($('#webdav-url')) $('#webdav-url').value = wd0.url || '';
    if ($('#webdav-user')) $('#webdav-user').value = wd0.user || '';
    if ($('#webdav-pass')) $('#webdav-pass').value = wd0.pass || '';
    const wst0 = $('#webdav-status'); if (wst0) wst0.textContent = wd0.url ? ('已配置：' + wd0.url) : '未配置';
    const ag = $('#autogame-toggle'); if (ag) ag.checked = state.cfg.autoOpenWithGame !== false;
    const px = $('#proxy-input'); if (px) px.value = state.cfg.proxy || '';
    const gh = $('#glass-heavy-toggle'); if (gh) gh.checked = state.cfg.glassHeavyAnim === true;
    const logLabel = $('#log-dir-label');
    if (logLabel && window.launcher.getLogDir) {
      window.launcher.getLogDir().then(p => { logLabel.textContent = p; });
    }
  } catch (e) { console.warn('settings init failed:', e); }

  // ===== 胶囊控件初始化（独立 try-catch：任何前置异常都不允许吞掉胶囊，否则滑块/选中态全丢） =====
  try {
    // 外观主题胶囊
    window.__themeCapsule = initSegmentCapsule('theme-capsule', state.cfg.theme || 'dark', (val) => {
      state.cfg.theme = val;
      window.launcher.configSave(state.cfg);
      playThemeAnim();
      AppTheme.applyTheme(val, { animate: true });
      try { LiuliTheme.apply(); } catch (e) {}
      try { window.__lpSync && window.__lpSync(); } catch (e) {}
      toast('外观主题已切换为' + (val === 'dark' ? '深色' : val === 'light' ? '浅色' : '跟随系统'));
    });

    // 毛玻璃材质胶囊
    const currentGlassMode = state.cfg.glass === false ? 'off' : (state.cfg.glassMode || 'acrylic');
    window.__glassCapsule = initSegmentCapsule('glass-capsule', currentGlassMode, async (val) => {
      await handleGlassModeChange(val);
    });

    // 下载线程胶囊
    window.__dlThreadCapsule = initSegmentCapsule('dl-thread-capsule', state.cfg.dlThreads || 1, (val) => {
      state.cfg.dlThreads = Number(val);
      window.launcher.configSave(state.cfg);
      toast('下载线程数：' + val + (val === '1' ? '（单线程）' : '线程'));
    });

    // 深色卡片底色胶囊
    window.__cardBgCapsule = initSegmentCapsule('card-bg-capsule', state.cfg.cardBg || 'solid', (val) => {
      state.cfg.cardBg = val;
      window.launcher.configSave(state.cfg);
      document.body.classList.toggle('card-bg-solid', val === 'solid');
      document.body.classList.toggle('card-bg-glass', val === 'glass');
      toast('深色卡片底色：' + (val === 'solid' ? '纯黑不透明' : '毛玻璃'));
    });
  } catch (e) { console.warn('capsule init failed:', e); }
  // 初始化时挂载类（无论胶囊初始化成败都保证生效）
  try {
    document.body.classList.toggle('card-bg-solid', (state.cfg.cardBg || 'solid') === 'solid');
    document.body.classList.toggle('card-bg-glass', state.cfg.cardBg === 'glass');
  } catch (e) {}
  // 壁纸 / 主题色 / 琉璃参数控件回填与绑定
  try { bindAppearanceControls(); } catch (e) { console.warn('appearance controls failed:', e); }
  // 设置页分类导航筛选
  try { initSettingsNav(); } catch (e) { console.warn('settings nav failed:', e); }
  // ===== END 胶囊控件初始化 =====
  const info = await window.launcher.appInfo();
  $('#about-line').textContent = 'SFS 启动器 ' + info.version;
  $('#about-version').textContent = 'v' + info.version;
  // 毛玻璃材质类统一由 applyTheme() → syncGlassState() 按主进程实时返回值挂载
  window.launcher.onModsChanged(() => { renderMods(); });
  // 下载进度
  window.launcher.onDownloadProgress((d) => {
    let bar = $('#dl-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dl-progress';
      bar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-2);border:1px solid var(--accent);border-radius:10px;padding:10px 16px;z-index:9998;min-width:280px;box-shadow:0 8px 24px rgba(0,0,0,.3);';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<div style="font-size:12px;margin-bottom:6px;">正在下载：' + esc(d.name) + '</div>' +
      '<div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden;"><div style="height:100%;width:' + d.pct + '%;background:var(--accent);transition:width .2s;"></div></div>' +
      '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;text-align:right;">' + d.pct + '%</div>';
    // 下载开始时自动展开顶部进度面板
    if (dlPanelCollapsed) {
      dlPanelCollapsed = false;
      const body = $('#dl-progress-body'); if (body) body.hidden = false;
      const tg = $('#dl-toggle'); if (tg) tg.textContent = '收起 ▴';
    }
    // 拉全部任务列表刷新顶部面板；超过3个自动跳下载队列页
    window.launcher.downloadList().then(tasks => {
      const list = (tasks && tasks.tasks) || tasks || [];
      refreshDlProgressPanel(list);
      const activeCount = list.filter(t => t.status === 'downloading' || t.state === 'progressing').length;
      if (activeCount > 3) {
        const dlView = $('#view-downloads');
        if (!(dlView && dlView.classList.contains('active'))) {
          document.querySelector('.nav-item[data-view="downloads"]').click();
        }
      }
    }).catch(() => { refreshDlProgressPanel([d]); });
  });
  window.launcher.onDownloadDone((d) => {
    const bar = $('#dl-progress');
    if (bar) bar.remove();
    if (d.state === 'completed') {
      toast('下载完成：' + d.name + '，请在「模组」页导入');
      renderMods();
    } else if (d.state !== 'completed') {
      toast('下载失败：' + d.name);
    }
    // 刷新顶部面板
    refreshDlProgressPanel([]);
  });
  // 下载错误（连接超限等）：弹窗可重试；同一任务连续失败时提示降低线程数
  const _dlFailCount = {};
  window.launcher.onDownloadError?.((d) => {
    const key = d.url || d.name || '';
    _dlFailCount[key] = (_dlFailCount[key] || 0) + 1;
    const tip = _dlFailCount[key] >= 2
      ? '已连续失败，建议先到「设置」把模组下载线程降到 4 或单线程后再试。'
      : '可能是下载线程过高、触发服务器并发连接限制。';
    appConfirm({
      title: '下载失败',
      body: (d.name ? '「' + d.name + '」下载失败。' : '下载失败。') + tip + (d.error ? '（' + d.error + '）' : ''),
      okText: '重试',
      cancelText: '取消'
    }).then((ok) => {
      // 重试成功后由 onDownloadDone 清零计数
      if (ok && d.url) window.launcher.modDownloadURL(d.url);
    });
  });
  window.launcher.onDownloadDone?.((d) => {
    if (d.state === 'completed') { try { delete _dlFailCount[d.name || '']; } catch (_) {} }
  });
  try { window.__bt && window.__bt('renderer_ready'); } catch (e) {}
  console.log('RENDERER_READY');
}

// ===== 全局拖入模组文件：拖到窗口上显示提示，松开走导入 =====
(function setupDropImport() {
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!overlay) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      dragDepth++; overlay.hidden = false;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
    const files = Array.from(e.dataTransfer.files || []).map(f => f.path).filter(Boolean);
    if (!files.length) return;
    const insts = state.cfg.instances;
    if (!insts.length) { toast('请先添加游戏实例'); return; }
    // 识别每个文件类型
    const typeOf = (p) => {
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (ext === 'dll') return 'DLL 模组';
      if (ext === 'pack') return '部件包';
      if (ext === 'zip') return '压缩包（自动识别）';
      return '未知';
    };
    const listEl = $('#import-file-list');
    if (listEl) listEl.innerHTML = files.map(f =>
      `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
        <span style="color:var(--text)">${esc(f.split(/[\\/]/).pop())}</span>
        <span style="color:var(--accent);margin-left:8px;font-size:11px">${typeOf(f)}</span>
      </div>`).join('');
    const sel = $('#import-inst-select');
    if (sel) {
      sel.innerHTML = insts.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
      const cur = insts.find(i => i.current);
      if (cur) sel.value = cur.id;
    }
    $('#import-dialog').hidden = false;
    document.body.classList.add('modal-open');
    // 暂存待导入文件
    window._pendingImportFiles = files;
  });
})();

// 导入弹窗按钮
$('#import-cancel') && $('#import-cancel').addEventListener('click', () => {
  $('#import-dialog').hidden = true;
  document.body.classList.remove('modal-open');
  window._pendingImportFiles = null;
});
$('#import-ok') && $('#import-ok').addEventListener('click', async () => {
  const files = window._pendingImportFiles || [];
  const instId = $('#import-inst-select') ? $('#import-inst-select').value : '';
  $('#import-dialog').hidden = true;
  document.body.classList.remove('modal-open');
  window._pendingImportFiles = null;
  for (const p of files) {
    const r = await window.launcher.modImportFile(p, instId);
    if (r && r.success) toast('已导入：' + (r.summary || p));
    else toast('导入失败：' + ((r && r.error) || p));
  }
  if (typeof renderMods === 'function') renderMods();
});

// ---- 游戏列表 ----
function renderGames() {
  const list = $('#home-game-list');
  const added = $('#added-game-list');
  const insts = state.cfg.instances;

  const htmlOf = (inst, showRemove = true) => {
    const last = inst.lastPlayed ? new Date(inst.lastPlayed) : null;
    const lastStr = last ? `${last.getMonth()+1}/${last.getDate()} ${String(last.getHours()).padStart(2,'0')}:${String(last.getMinutes()).padStart(2,'0')}` : '未游玩';
    return `
    <div class="game-card">
      <div class="game-icon"><img data-gid="${esc(inst.id)}" src="assets/game-icon.png" alt="SFS" style="width:100%;height:100%;object-fit:contain;border-radius:8px"></div>
      <div class="game-info">
        <div class="game-name">${esc(inst.name)}</div>
        <div class="game-path">${esc(inst.exePath || inst.installDir || '')}</div>
        <div class="game-path" style="color:var(--accent)">最近游玩：${lastStr}</div>
      </div>
      <div class="game-actions">
        <button class="btn small primary" data-act="launch" data-id="${esc(inst.id)}">启动</button>
        ${showRemove ? `<button class="btn small danger" data-act="remove" data-id="${esc(inst.id)}">移除</button>` : ''}
      </div>
    </div>`;
  };

  list.innerHTML = insts.length
    ? insts.map(i => htmlOf(i, false)).join('')
    : `<div class="empty-tip"><div>还没有游戏实例</div><div class="empty-sub">点击上方「自动检测 Steam」或「手动添加实例」</div></div>`;

  added.innerHTML = insts.length
    ? insts.map(i => htmlOf(i, true)).join('')
    : `<div class="empty-tip"><div>暂无实例</div></div>`;

  // 游戏实例图标与游戏本体一致：渲染端缓存命中即渲染，未命中才走 IPC（主进程另有内存+磁盘缓存）
  $$('#home-game-list .game-icon img, #added-game-list .game-icon img').forEach(img => {
    const gid = img.dataset.gid;
    if (iconRenderCache.has(gid)) { img.src = iconRenderCache.get(gid); return; }
    window.launcher.gameIcon(gid).then(r => {
      if (r && r.success && r.dataUrl) { iconRenderCache.set(gid, r.dataUrl); img.src = r.dataUrl; }
    });
  });

  $$('#home-game-list [data-act], #added-game-list [data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'launch') {
        const r = await window.launcher.gameLaunch(id);
        if (r.success) {
          // lastPlayed 由主进程写盘，这里只同步内存 current 标记
          const inst = state.cfg.instances.find(i => i.id === id);
          if (inst) { state.cfg.instances.forEach(x => x.current = (x.id === id)); window.launcher.gameSetCurrent(id); }
          toast('已启动 SFS');
        } else toast('启动失败：' + r.error);
      } else if (act === 'remove') {
        const inst = state.cfg.instances.find(i => i.id === id);
        const ok = await appConfirm({
          title: '移除游戏实例',
          body: '确认从启动器移除「' + (inst ? inst.name : '该实例') + '」？\n仅移除启动器记录，不会删除游戏文件。',
          okText: '移除', danger: true
        });
        if (!ok) return;
        state.cfg.instances = await window.launcher.gameRemove(id);
        iconRenderCache.delete(id);
        renderGames();
      }
    });
  });

  // 卡片右键菜单：打开游戏目录 / 定位游戏程序 / 移除实例
  $$('#home-game-list .game-card, #added-game-list .game-card').forEach(card => {
    card.addEventListener('contextmenu', (e) => {
      const idEl = card.querySelector('[data-id]');
      const id = idEl ? idEl.dataset.id : null;
      const inst = state.cfg.instances.find(i => i.id === id);
      if (!inst) return;
      e.preventDefault();
      const items = [
        { label: '打开游戏目录', onClick: async () => { const r = await window.launcher.shellOpenPath(inst.installDir); if (r && !r.success) toast(r.error || '打开失败'); } },
        { label: '备份实例数据', onClick: async () => {
          toast('正在打包，请稍候…');
          const r = await window.launcher.instBackup(inst.id);
          if (!r) return;
          if (r.canceled) return;
          if (r.success) toast('备份完成 → ' + r.path);
          else toast('备份失败：' + (r.error || ''));
        } },
        { label: '从备份恢复', onClick: async () => {
          const ok = await appConfirm({ title: '从备份恢复', body: '将覆盖当前实例的游戏数据（模组、存档、扩展包）。\n建议先备份一次。\n\n确认继续？', okText: '选择备份并恢复', danger: true });
          if (!ok) return;
          const r = await window.launcher.instRestore(inst.id);
          if (!r) return;
          if (r.canceled) return;
          if (r.success) toast('恢复完成，请重启启动器刷新模组列表');
          else toast('恢复失败：' + (r.error || ''));
        } }
      ];
      if (inst.exePath) items.push({ label: '定位游戏程序 (.exe)', onClick: async () => { const r = await window.launcher.shellShowItem(inst.exePath); if (r && !r.success) toast(r.error || '定位失败'); } });
      items.push({ label: '注入汉化', onClick: () => openHanDialog(inst) });
      items.push({ label: '移除该实例', danger: true, onClick: async () => {
        const ok = await appConfirm({ title: '移除游戏实例', body: '确认从启动器移除「' + inst.name + '」？\n仅移除启动器记录，不会删除游戏文件。', okText: '移除', danger: true });
        if (!ok) return;
        state.cfg.instances = await window.launcher.gameRemove(inst.id);
        iconRenderCache.delete(inst.id);
        renderGames();
      }});
      openCtxMenu(e.clientX, e.clientY, items);
    });
  });

  // ---- 首页实例大卡片 ----
  const cur = insts.find(i => i.current) || insts[0];
  const nameEl = $('#instance-name'), metaEl = $('#instance-meta');
  const heroIcon = $('#instance-hero-icon');
  const heroBg = $('#instance-hero-bg');
  // 恢复上次设置的背景图（用 file:/// 前缀，Image probe 检测文件是否还在）
  if (heroBg && state.cfg.heroBg) {
    const raw = String(state.cfg.heroBg).replace(/\\/g, '/');
    const bgUrl = raw.startsWith('file://') ? raw : ('file:///' + raw);
    const probe = new Image();
    probe.onload = () => { heroBg.style.backgroundImage = `url("${bgUrl}")`; heroBg.classList.add('custom'); };
    probe.onerror = () => { state.cfg.heroBg = ''; window.launcher.configSave(state.cfg); };
    probe.src = bgUrl;
  }
  if (cur) {
    if (nameEl) nameEl.textContent = cur.name;
    if (metaEl) metaEl.textContent = (cur.exePath || cur.installDir || '');
    if (heroIcon) {
      if (iconRenderCache.has(cur.id)) { heroIcon.src = iconRenderCache.get(cur.id); }
      else { window.launcher.gameIcon(cur.id).then(r => { if (r && r.success && r.dataUrl) { iconRenderCache.set(cur.id, r.dataUrl); heroIcon.src = r.dataUrl; } }).catch(() => {}); }
    }
  } else {
    if (nameEl) nameEl.textContent = '未选择实例';
    if (metaEl) metaEl.textContent = '扫描 Steam 库或手动添加游戏目录';
    if (heroIcon) heroIcon.src = 'assets/game-icon.png';
  }
  // 开始游戏下拉：列出全部实例，点哪个就切换为当前实例（不启动游戏，启动由主按钮负责）
  const dd = $('#start-dropdown');
  if (dd) {
    dd.innerHTML = insts.map(i =>
      `<div class="sd-item${i.id === (cur && cur.id) ? ' active' : ''}" data-sd="${esc(i.id)}">${esc(i.name)}</div>`
    ).join('') || '<div class="sd-item" style="opacity:.6">暂无实例</div>';
    dd.querySelectorAll('.sd-item').forEach(it => {
      it.addEventListener('click', async () => {
        const id = it.dataset.sd;
        await window.launcher.gameSetCurrent(id);
        // 同步渲染端 current 标记，否则 hero 大卡片还显示旧实例
        insts.forEach(x => x.current = (x.id === id));
        dd.hidden = true;
        const inst = insts.find(x => x.id === id);
        toast('已切换到「' + (inst ? inst.name : '该实例') + '」');
        // 同步模组页/蓝图页下拉并重新扫描
        const msel = $('#mod-inst-select'); if (msel) msel.value = id;
        const bsel = $('#bp-inst-select'); if (bsel) bsel.value = id;
        renderGames();
        renderMods(); loadWorldStats();
        renderBlueprintTree();
      });
    });
  }
  // 填充模组页/蓝图页实例选择器
  $$('#mod-inst-select, #bp-inst-select').forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = '<option value="">选择实例…</option>' + insts.map(i =>
      `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
    sel.value = prev || (cur && cur.id) || '';
  });

  // 「切换实例」按钮：弹出实例列表，点哪个就设为当前常驻实例，并同步模组/蓝图页
  const manageBtn = $('#btn-manage-instances');
  if (manageBtn) {
    manageBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!insts.length) { toast('还没有游戏实例，先去游戏库添加'); return; }
      const items = insts.map(i => ({
        label: (i.current ? '● ' : '') + i.name + (i.id === (cur && cur.id) ? '（当前）' : ''),
        onClick: async () => {
          await window.launcher.gameSetCurrent(i.id);
          insts.forEach(x => x.current = (x.id === i.id));
          toast('已切换到「' + i.name + '」');
          // 同步模组页/蓝图页下拉选中值
          const msel = $('#mod-inst-select'); if (msel) msel.value = i.id;
          const bsel = $('#bp-inst-select'); if (bsel) bsel.value = i.id;
          renderGames();
          renderMods(); loadWorldStats();
          renderBlueprintTree();
        }
      }));
      openCtxMenu(e.clientX, e.clientY, items);
    };
  }
}

// 模组页/蓝图页切换实例 → 同步首页 hero + 另一个下拉 + 重新扫描对应内容
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'mod-inst-select' && e.target.id !== 'bp-inst-select') return;
  const id = e.target.value;
  if (!id) return;
  await window.launcher.gameSetCurrent(id);
  // 同步渲染端 current 标记（主进程已写盘，这里只更新内存快照）
  state.cfg.instances.forEach(x => x.current = (x.id === id));
  // 同步另一个下拉的选中值
  const otherSel = e.target.id === 'mod-inst-select' ? $('#bp-inst-select') : $('#mod-inst-select');
  if (otherSel) otherSel.value = id;
  // 刷新首页 hero（名称/路径/图标）
  renderGames();
  // 刷新对应列表
  if (e.target.id === 'mod-inst-select') { renderMods(); loadWorldStats(); }
  else { renderBlueprintTree(); toast('已切换到该实例'); }
});

// ===== 世界数据：挑战进度 + 游玩时间 =====
let __worldsCache = null;
async function loadWorldStats() {
  try {
    const r = await window.launcher.readWorlds();
    if (!r.success) {
      $('#stat-challenges').textContent = '—';
      $('#stat-playtime').textContent = '—';
      return;
    }
    __worldsCache = r.worlds;
    // 挑战总数
    const totalChal = r.worlds.reduce((s, w) => s + (w.challenges ? w.challenges.length : 0), 0);
    $('#stat-challenges').textContent = totalChal + ' 项';
    // 游玩时间求和
    const totalSec = r.worlds.reduce((s, w) => s + (w.playSeconds || 0), 0);
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    $('#stat-playtime').textContent = h + '时' + String(m).padStart(2,'0') + '分';
  } catch (e) {
    $('#stat-challenges').textContent = '—';
    $('#stat-playtime').textContent = '—';
  }
}

// 挑战英译中词典（SFS 实际 Challenges.txt 存的是下划线 id 字符串数组）
const CHAL_ZH = {
  // 内部 id 格式（SFS 实际存档用的）
  'Reach_Orbit': '进入轨道',
  'Reach_Space': '到达太空',
  'Reach_100km': '到达 100 公里',
  'Reach_10km': '到达 10 公里',
  'Reach_1km': '到达 1 公里',
  'Reach_Downrange': '达到射程距离',
  'Liftoff_0': '发射升空',
  'Liftoff': '发射升空',
  'Reach_30km': '到达 30 公里',
  'Reach_50km': '到达 50 公里',
  'Reach_100km': '到达 100 公里',
  'Venus_One_Way': '金星单程',
  'Venus_Landing': '登陆金星',
  'Moon_Orbit': '环绕月球',
  'Moon_Landing': '登陆月球',
  'Mars_Orbit': '环绕火星',
  'Mars_Landing': '登陆火星',
  'Venus_Orbit': '环绕金星',
  'Sun_Orbit': '环绕太阳',
  'Escape_Solar_System': '逃离太阳系',
  'Space_Station': '建造空间站',
  'Docking': '两艘飞船对接',
  'Return_Orbit': '从轨道返回',
  'Mars_One_Way': '火星单程',
  'Mercury_One_Way': '水星单程',
  'Land_Moon': '登陆月球',
  'Land_Mars': '登陆火星',
  'Land_Earth': '返回地球',
  'Land_Venus': '登陆金星',
  'Land_Mercury': '登陆水星',
  'Land_Jupiter': '登陆木星',
  'Land_Saturn': '登陆土星',
  'Escape_SolarSystem': '逃离太阳系',
  'Build_Station': '建造空间站',
  'Dock_Two': '两艘飞船对接',
  'Return_Orbit': '从轨道返回',
  'Flyby_Moon': '飞越月球',
  'Orbit_Moon': '环绕月球',
  'Orbit_Mars': '环绕火星',
  'Complete_Mission': '完成任务',
  'First_Flight': '首次飞行',
  // 人类可读格式兜底
  'Reach orbit': '进入轨道',
  'Land on the Moon': '登陆月球',
  'Land on Mars': '登陆火星',
  'Escape the solar system': '逃离太阳系',
  'Build a space station': '建造空间站',
  'Dock two spacecraft': '两艘飞船对接',
  'Return from orbit': '从轨道返回',
  'Reach space': '到达太空',
  'Land on Earth': '返回地球',
  'Flyby the Moon': '飞越月球',
  'Orbit the Moon': '环绕月球',
  'Orbit Mars': '环绕火星',
  'Land on Venus': '登陆金星',
  'Land on Mercury': '登陆水星',
  'Land on Jupiter': '登陆木星',
  'Land on Saturn': '登陆土星',
  'Complete a mission': '完成任务',
  'First flight': '首次飞行',
  'Reach 100km': '到达 100 公里',
  'Reach 10km': '到达 10 公里',
  'Reach 1km': '到达 1 公里',
};
function chalZh(name) {
  if (!name) return '未知';
  const id = String(name).trim();
  if (CHAL_ZH[id]) return CHAL_ZH[id];
  const low = id.toLowerCase();
  for (const k in CHAL_ZH) if (k.toLowerCase() === low) return CHAL_ZH[k];
  // 下划线 id 去掉下划线后再匹配一次
  const flat = id.replace(/_/g, ' ').toLowerCase();
  for (const k in CHAL_ZH) if (k.replace(/_/g, ' ').toLowerCase() === flat) return CHAL_ZH[k];
  return id.replace(/_/g, ' ');
}

// 挑战进度弹窗（可切换世界）
$('#btn-challenges') && $('#btn-challenges').addEventListener('click', () => {
  if (!__worldsCache || !__worldsCache.length) { toast('暂无世界数据'); return; }
  let curWorld = 0;
  const render = () => {
    const w = __worldsCache[curWorld];
    const tabs = __worldsCache.map((ww, i) =>
      `<button class="chal-tab${i === curWorld ? ' active' : ''}" data-wi="${i}">${esc(ww.name)}</button>`).join('');
    const list = (w.challenges || []).map((c, i) => {
      // SFS Challenges.txt 实际是字符串 id 数组（如 "Reach_Orbit"），兼容对象数组两种格式
      const isStr = typeof c === 'string';
      const done = isStr ? true : (c.completed || c.Completed || c.done || c.state === 'completed');
      const name = isStr ? c : (c.name || c.Name || c.title || c.Title || ('挑战 ' + (i+1)));
      return `<div class="chal-item${done ? ' done' : ''}">
        <span class="chal-check">${done ? '✓' : '○'}</span>
        <span class="chal-name">${esc(chalZh(name))}</span>
        ${done ? '<span class="chal-done-tag">已完成</span>' : ''}
      </div>`;
    }).join('') || '<div class="empty-tip">该世界暂无挑战记录</div>';
    showModal('挑战进度 - ' + esc(w.name), `<div class="chal-tabs">${tabs}</div><div class="chal-list">${list}</div>`);
    document.body.classList.add('modal-open');
    $$('.chal-tab').forEach(t => t.addEventListener('click', () => { curWorld = Number(t.dataset.wi); render(); }));
  };
  render();
});

// 游玩时间弹窗（每个世界单独时长）
$('#btn-playtime') && $('#btn-playtime').addEventListener('click', () => {
  if (!__worldsCache || !__worldsCache.length) { toast('暂无世界数据'); return; }
  const totalSec = __worldsCache.reduce((s, w) => s + (w.playSeconds || 0), 0);
  const fmt = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h + '时' + String(m).padStart(2,'0') + '分' + String(s).padStart(2,'0') + '秒';
  };
  const rows = __worldsCache.map(w =>
    `<div class="pt-row"><span class="pt-name">${esc(w.name)}</span><span class="pt-time">${fmt(w.playSeconds || 0)}</span></div>`).join('');
  showModal('游玩时间', `<div class="pt-total">合计：${fmt(totalSec)}</div><div class="pt-list">${rows}</div>`);
  document.body.classList.add('modal-open');
});
// ===== END 世界数据 =====

// 开始游戏按钮：主按钮启动常驻实例，下拉展开/收起
$('#btn-start-game') && $('#btn-start-game').addEventListener('click', async (e) => {
  if (e.target.closest('.start-caret') || e.offsetX > e.target.offsetWidth - 30) {
    const dd = $('#start-dropdown');
    if (dd) dd.hidden = !dd.hidden;
    return;
  }
  const insts = state.cfg.instances;
  const cur = insts.find(i => i.current) || insts[0];
  if (!cur) { toast('请先添加游戏实例'); return; }
  // 启动前预检查：扩展包完整性 / 路径风险
  try {
    const pr = await window.launcher.gamePrecheck(cur.id);
    if (!pr || !pr.success) { toast((pr && pr.error) || '预检查失败'); return; }
    if (pr.errors && pr.errors.length) {
      const ok = await appConfirm({ title: '启动检查未通过', body: pr.errors.join('\n') + '\n\n存在严重问题，仍要强行启动吗？', okText: '强行启动', danger: true });
      if (!ok) return;
    } else if (pr.warnings && pr.warnings.length) {
      const ok = await appConfirm({ title: '启动检查提醒', body: pr.warnings.join('\n'), okText: '继续启动' });
      if (!ok) return;
    }
  } catch (e) { /* 预检查异常不阻断启动 */ }
  const r = await window.launcher.gameLaunch(cur.id);
  if (r.success) { renderGames(); toast('已启动 SFS'); }
  else toast('启动失败：' + (r.error || ''));
});
// 点别处收起下拉
document.addEventListener('mousedown', (e) => {
  const dd = $('#start-dropdown');
  if (dd && !dd.hidden && !e.target.closest('#start-dropdown') && !e.target.closest('#btn-start-game')) dd.hidden = true;
});
// 实例卡片右键：自定义背景图（菜单让用户选，而不是直接弹文件选择框）
$('#instance-hero') && $('#instance-hero').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const bg = $('#instance-hero-bg');
  const items = [
    { label: '设置背景图', onClick: async () => {
      const r = await window.launcher.pickHeroBg();
      if (r && r.success && r.path && bg) {
        const raw = String(r.path).replace(/\\/g, '/');
        const bgUrl = raw.startsWith('file://') ? raw : ('file:///' + raw);
        bg.style.backgroundImage = `url("${bgUrl}")`;
        bg.classList.add('custom');
        state.cfg.heroBg = r.path;
      }
    } },
    { label: '移除背景图', onClick: async () => {
      if (bg) { bg.style.backgroundImage = ''; bg.classList.remove('custom'); }
      state.cfg.heroBg = '';
      await window.launcher.heroClearBg();
    } }
  ];
  openCtxMenu(e.clientX, e.clientY, items);
});

// ---- Steam 扫描 ----
async function doScan() {
  if (state.scanning) return;
  state.scanning = true;
  const btnScan = $('#btn-scan'); if (btnScan) btnScan.disabled = true;
  const status = $('#scan-status'); if (status) status.textContent = '正在扫描 Steam 库…';
  toast('正在扫描 Steam 库…');
  const r = await window.launcher.steamScan();
  state.scanning = false;
  if (btnScan) btnScan.disabled = false;
  if (!r.success) {
    if (status) status.textContent = r.error + '（可点右侧按钮手动选择 Steam 目录）';
    toast('扫描失败：' + r.error);
    return;
  }
  if (status) status.textContent = `Steam 目录：${r.steamPath}，共发现 ${r.games.length} 个游戏`;
  state.scanGames = r.games;
  const box = $('#scan-game-list');
  $('#scan-result').hidden = false;

  const sfs = r.sfs;
  const parts = [];
  if (sfs) {
    parts.push(`<div class="game-card" style="border-color:var(--accent)">
      <div class="game-icon"><img src="assets/game-icon.png" alt="SFS" style="width:100%;height:100%;object-fit:contain;border-radius:8px"></div>
      <div class="game-info">
        <div class="game-name">找到 SFS（${esc(sfs.name)}）</div>
        <div class="game-path">${esc(sfs.installDir)}</div>
      </div>
      <div class="game-actions"><button class="btn small primary" data-add='${JSON.stringify(sfs).replace(/'/g, "&apos;")}'>添加到我的游戏</button></div>
    </div>`);
  }
  for (const g of r.games) {
    if (sfs && g.appId === sfs.appId) continue;
    parts.push(`<div class="game-card">
      <div class="game-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM9 15.5V8.5l6.5 3.5L9 15.5z"/></svg></div>
      <div class="game-info">
        <div class="game-name">${esc(g.name)}</div>
        <div class="game-path">${esc(g.installDir)}</div>
      </div>
      <div class="game-actions"><span class="mod-meta">仅 SFS 可添加</span></div>
    </div>`);
  }
  box.innerHTML = parts.join('');
  box.querySelectorAll('[data-add]').forEach(b => {
    b.addEventListener('click', async () => {
      const g = JSON.parse(b.dataset.add);
      const res = await window.launcher.gameAdd(g);
      if (res.success) {
        state.cfg.instances = res.instances;
        renderGames();
        toast(`已添加：${g.name}`);
      } else toast('添加失败：' + res.error);
    });
  });

  if (!sfs) toast('未在 Steam 库中找到 SFS，请确认游戏已通过 Steam 安装，或手动添加实例');
}

$('#btn-scan').addEventListener('click', doScan);
$('#btn-home-scan').addEventListener('click', doScan);

$('#btn-steamdir').addEventListener('click', async () => {
  const r = await window.launcher.steamSelectDir();
  if (r.canceled) return;
  const res = await window.launcher.steamScanWithPath(r.path);
  if (!res.success) { toast(res.error); return; }
  $('#scan-status').textContent = `已使用 ${res.steamPath}，发现 ${res.games.length} 个游戏`;
  toast('Steam 目录已保存');
});

// 手动添加实例：夸克网盘风格安装弹窗（选路径 → 确认安装）
let installPath = '';
function openInstallDialog() {
  installPath = '';
  $('#inst-name-input').value = '';
  $('#inst-path-input').value = '';
  const ic = $('#inst-game-icon'); if (ic) ic.src = 'assets/game-icon.png';
  $('#install-dialog').hidden = false;
}
async function pickInstallPath() {
  const r = await window.launcher.gameSelectPath();
  if (r.canceled) return;
  installPath = r.path;
  $('#inst-path-input').value = r.path;
  const nm = r.path.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (nm && !$('#inst-name-input').value) $('#inst-name-input').value = nm;
  // 图标提取异步不阻塞，避免大 exe 提取时弹窗卡顿
  if (/\.exe$/i.test(r.path)) {
    window.launcher.iconFromPath(r.path).then(ir => {
      if (ir && ir.success) { const ic = $('#inst-game-icon'); if (ic) ic.src = ir.dataUrl; }
    }).catch(() => {});
  }
}
// ===== 添加方式弹窗（顶层定义，供 confirmInstall 调用） =====
function showAddMethodDialog(name, targetPath, callback) {
  $('#add-method-name').textContent = name || '[sfs]';
  $('#add-method-path').textContent = targetPath || '';
  $('#add-method-dialog').hidden = false;
  $('#add-method-ok').onclick = () => {
    const method = document.querySelector('input[name="add-method"]:checked').value;
    $('#add-method-dialog').hidden = true;
    callback?.(method);
  };
  $('#add-method-cancel').onclick = () => {
    $('#add-method-dialog').hidden = true;
  };
}
// ===== END 添加方式弹窗 =====
async function confirmInstall() {
  const p = installPath || $('#inst-path-input').value.trim();
  if (!p) { toast('请先选择游戏路径'); return; }
  const tail = p.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  let name = $('#inst-name-input').value.trim() || tail || 'Spaceflight Simulator';
  // 校验：名称或路径中需包含 spaceflight 或 sfs（选文件夹也能过）
  const checkStr = (name + ' ' + p).toLowerCase();
  if (!/spaceflight|sfs/.test(checkStr)) {
    toast('仅允许添加 Spaceflight Simulator 游戏');
    return;
  }

  // 弹出添加方式选择
  showAddMethodDialog(name, p, async (method) => {
    const isExe = /\.exe$/i.test(p);
    const res = await window.launcher.gameAdd({
      name,
      exePath: isExe ? p : '',
      installDir: isExe ? p.split(/[\\/]/).slice(0, -1).join('\\') : p,
      appId: SFS_APPID
    });
    if (res.success) {
      state.cfg.instances = res.instances;
      renderGames();
      $('#install-dialog').hidden = true;
      toast('已添加实例：' + name + (method === 'link' ? '（目录联接）' : ''));
    } else {
      toast('添加失败：' + res.error);
    }
  });
}
$('#btn-home-add').addEventListener('click', openInstallDialog);
const btnHomeManual = $('#btn-home-manual'); if (btnHomeManual) btnHomeManual.addEventListener('click', openInstallDialog);
$('#inst-browse').addEventListener('click', pickInstallPath);
$('#inst-confirm').addEventListener('click', confirmInstall);
$('#inst-cancel').addEventListener('click', () => {
  // 更多选项：展开/收起高级提示
  let tip = $('#inst-advanced-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'inst-advanced-tip';
    tip.className = 'inst-advanced-tip';
    tip.textContent = '提示：仅支持添加 Spaceflight Simulator 游戏。';
    $('#install-dialog .install-dialog').appendChild(tip);
  } else {
    tip.remove();
  }
});
$('#inst-close').addEventListener('click', () => { $('#install-dialog').hidden = true; });

// ---- 模组 ----
const TYPE_LABEL = { parts: '部件', texture: '涂装包', blueprint: '蓝图', dll: 'DLL', solar: '扩展包', unknown: '未知' };
let state_modFilter = 'all';
const MOD_FILTERS = ['all', 'parts', 'dll', 'blueprint', 'texture', 'solar'];

async function renderMods() {
  const data = await window.launcher.modList();
  if (!data || !data.installed) return; // 防御：IPC异常时不覆盖已有数据
  state.cfg.mods = data;

  // 一览统计（全量，不受类型过滤影响）
  const installed = data.installed || [];
  const cnt = { parts: 0, dll: 0, blueprint: 0, texture: 0, solar: 0 };
  for (const m of installed) { if (cnt[m.type] != null) cnt[m.type]++; }
  for (const k of Object.keys(cnt)) {
    const el = document.querySelector(`[data-ov="${k}"]`);
    if (el) el.textContent = cnt[k];
  }

  const pBox = $('#pending-list');
  if (!data.pending.length) {
    pBox.innerHTML = `<div class="empty-tip"><div>暂无待导入文件</div><div class="empty-sub">在模组商店下载的 ZIP 会列入此处，确认类型后点击「导入」部署</div></div>`;
  } else {
    pBox.innerHTML = data.pending.map(p => `
      <div class="mod-item">
        <span class="mod-type ${esc(p.type)}">${TYPE_LABEL[p.type] || p.type}</span>
        <span class="mod-name">${esc(p.name)}</span>
        <button class="btn small primary" data-pimp="${esc(p.path)}" data-ptype="${esc(p.type)}">导入</button>
        <button class="btn small danger" data-pdel="${esc(p.path)}">移除</button>
      </div>`).join('');
    pBox.querySelectorAll('[data-pimp]').forEach(b => b.addEventListener('click', async () => {
      // 从商店缓存按名称匹配版本号，写入已装记录以便后续更新检测
      let ver = '';
      if (modstoreCache) {
        const pItem = data.pending.find(p => p.path === b.dataset.pimp);
        const pn = normName(pItem && pItem.name);
        const hit = modstoreCache.find(x => {
          const xn = normName(x.name);
          return xn && pn && (xn.includes(pn) || pn.includes(xn));
        });
        if (hit && hit.version) ver = hit.version;
      }
      const r = await window.launcher.modDeploy(b.dataset.pimp, b.dataset.ptype, ver);
      toast(r.success ? r.summary : ('导入失败：' + r.error));
      renderMods();
    }));
    pBox.querySelectorAll('[data-pdel]').forEach(b => b.addEventListener('click', async () => {
      state.cfg.mods.pending = await window.launcher.modRemovePending(b.dataset.pdel);
      renderMods();
    }));
  }

  // 已装列表：按类型胶囊过滤
  const filtered = state_modFilter === 'all' ? installed : installed.filter(m => m.type === state_modFilter);
  VirtInstalled.setData(filtered);
  updateBatchBar();

  renderImportHistory(data.importHistory || []);
}

function renderImportHistory(hist) {
  const box = $('#import-history-list');
  if (!box) return;
  if (!hist.length) { box.innerHTML = '<div class="empty-tip"><div>暂无导入记录</div></div>'; return; }
  box.innerHTML = hist.slice(0, 60).map(h => {
    const t = new Date(h.at);
    const ts = isNaN(t) ? '' : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="hist-item">
      <span class="hist-time">${esc(ts)}</span>
      <span class="mod-type ${esc(h.type)}">${TYPE_LABEL[h.type] || h.type}</span>
      <span class="hist-name">${esc(h.name)}</span>
      <span class="${h.ok ? 'hist-ok' : 'hist-fail'}">${h.ok ? '成功' : '失败'}</span>
    </div>`;
  }).join('');
}

// ---- 批量选择 ----
function selectedModIndexes() {
  return [...VirtInstalled.selected].sort((a, b) => a - b);
}
function updateBatchBar() {
  const bar = $('#mod-batch-bar');
  if (!bar) return;
  const sel = selectedModIndexes();
  bar.hidden = sel.length === 0;
  const cnt = $('#mod-batch-count'); if (cnt) cnt.textContent = '已选 ' + sel.length + ' 项';
}
$('#btn-mod-batch-export').addEventListener('click', async () => {
  const sel = selectedModIndexes();
  if (!sel.length) return;
  let ok = 0;
  for (const idx of sel) {
    const r = await window.launcher.modExport(idx);
    if (r && r.success) ok++;
  }
  toast('批量导出完成，成功 ' + ok + ' / ' + sel.length + ' 个');
});
$('#btn-mod-batch-del').addEventListener('click', async () => {
  let sel = selectedModIndexes();
  if (!sel.length) return;
  if (!await appConfirm({ title: '批量删除模组', body: '确认删除选中的 ' + sel.length + ' 个模组及其文件？\n该操作不可恢复。', okText: '删除', danger: true })) return;
  // 从大到小删除，避免索引位移
  sel.sort((a, b) => b - a);
  for (const idx of sel) { await window.launcher.modRemoveInstalled(idx); }
  toast('已删除 ' + sel.length + ' 个模组');
  renderMods();
});

// 顶部导入按钮：文件选择器按类型过滤，部署前再做一次严格校验，选错类型一律不导入、不落盘
$$('[data-modbtn]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.modbtn;
    const r = await window.launcher.modPickZip(type);
    if (r.canceled) return;
    const lower = (r.path || '').toLowerCase();
    const allow = { parts: /\.(zip|pack)$/i, texture: /\.zip$/i, blueprint: /\.zip$/i, dll: /\.(zip|dll)$/i }[type];
    const needText = { parts: '.pack 文件或 ZIP 压缩包', texture: 'ZIP 压缩包（内含 textures 文件夹）', blueprint: 'ZIP 压缩包（内含 Blueprints 文件夹）', dll: '.dll 文件或 ZIP 压缩包' }[type] || '对应类型文件';
    if (!allow || !allow.test(lower)) {
      toast('文件类型不匹配：' + (TYPE_LABEL[type] || '该') + '导入仅接受' + needText + '，已取消（未写入任何文件）');
      return;
    }
    const res = await window.launcher.modDeploy(r.path, type);
    toast(res.success ? res.summary : ('导入失败：' + res.error));
    renderMods();
  });
});
// 清理重复模组：弹窗列出每组重复项，用户勾选保留哪个，删除其余
$('#btn-dedup') && $('#btn-dedup').addEventListener('click', async () => {
  const installed = (state.cfg.mods && state.cfg.mods.installed) || [];
  const groups = {};
  installed.forEach((m, idx) => {
    const key = (m.name || '').toLowerCase() + '|' + (m.type || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...m, _idx: idx });
  });
  const dups = Object.values(groups).filter(g => g.length > 1);
  if (!dups.length) { toast('未发现重复模组'); return; }
  // 构建弹窗 HTML：每组一个 radio 组，默认选中最新安装的
  let html = '<div style="max-height:320px;overflow-y:auto">';
  dups.forEach((g, gi) => {
    g.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
    html += `<div style="margin-bottom:14px"><div style="font-weight:600;margin-bottom:6px">${esc(g[0].name)}（${g.length} 个重复）</div>`;
    g.forEach((m, mi) => {
      const dt = m.installedAt ? new Date(m.installedAt).toLocaleString() : '未知时间';
      const checked = mi === 0 ? 'checked' : '';
      html += `<label style="display:block;padding:4px 0;cursor:pointer"><input type="radio" name="dedup-${gi}" value="${m._idx}" ${checked}/> ${esc(dt)} · ${esc(m.type || '')}${m.count ? ' · ' + m.count + '个文件' : ''}</label>`;
    });
    html += '</div>';
  });
  html += '</div><div style="margin-top:14px;text-align:right"><button class="btn small danger" id="dedup-do-clean">清理未选中的</button></div>';
  showModal('清理重复模组', html);
  document.body.classList.add('modal-open');
  const doBtn = $('#dedup-do-clean');
  if (doBtn) doBtn.onclick = async () => {
    const keepIdx = new Set();
    dups.forEach((g, gi) => {
      const sel = document.querySelector(`input[name="dedup-${gi}"]:checked`);
      if (sel) keepIdx.add(Number(sel.value));
    });
    const removeIdx = [];
    dups.forEach(g => g.forEach(m => { if (!keepIdx.has(m._idx)) removeIdx.push(m._idx); }));
    removeIdx.sort((a, b) => b - a);
    for (const idx of removeIdx) { await window.launcher.modRemoveInstalled(idx); }
    const res = await window.launcher.modList();
    if (res) state.cfg.mods = res;
    hideModal();
    document.body.classList.remove('modal-open');
    renderMods();
    toast(`已清理 ${removeIdx.length} 个重复模组`);
  };
});

$('#btn-modsite').addEventListener('click', () => {
  const navItem = document.querySelector('.nav-item[data-view="modstore"]');
  if (navItem) navItem.click();
});

$('#btn-opendata').addEventListener('click', async () => {
  const r = await window.launcher.modDataDir();
  if (r.success) { await window.launcher.openExternal(r.dir); }
  else toast(r.error);
});

$('#btn-scan-installed').addEventListener('click', async () => {
  try {
    const r = await window.launcher.modScanInstalled();
    if (r.success) toast(r.added > 0 ? '扫描完成：新增 ' + r.added + ' 个模组，共 ' + r.total + ' 项' : '未发现新的已安装模组');
    else toast(r.error || '扫描失败');
  } catch (e) { toast('扫描失败：' + (e.message || e)); }
  renderMods();
});

// 导出模组清单：弹窗选格式
$('#btn-export-list') && $('#btn-export-list').addEventListener('click', () => {
  const html = `
    <div style="display:flex;gap:10px;justify-content:center;padding:8px 0">
      <button class="btn primary" id="export-txt" style="min-width:110px">文本 (.txt)</button>
      <button class="btn primary" id="export-md" style="min-width:110px">Markdown (.md)</button>
    </div>`;
  showModal('导出模组清单', html);
  document.body.classList.add('modal-open');
  const doExport = async (fmt) => {
    hideModal(); document.body.classList.remove('modal-open');
    const r = await window.launcher.modExportList(fmt);
    if (!r) return;
    if (r.canceled) return;
    if (r.success) toast('已导出 ' + r.count + ' 项 → ' + r.path);
    else toast('导出失败：' + (r.error || ''));
  };
  const bt = $('#export-txt'); if (bt) bt.onclick = () => doExport('txt');
  const bm = $('#export-md'); if (bm) bm.onclick = () => doExport('md');
});


// ---- 蓝图文件夹树（初始只展示文件夹，可展开；操作权限与模组一致：打开位置/删除） ----
async function renderBlueprintTree() {
  const box = $('#blueprint-tree');
  if (!box) return;
  box.innerHTML = '<div class="empty-tip"><div>正在扫描蓝图文件夹…</div></div>';
  let r;
  try { r = await window.launcher.blueprintTree(); } catch (e) { r = { success: false, error: e.message }; }
  if (!r || !r.success) {
    box.innerHTML = `<div class="empty-tip"><div>${esc((r && r.error) || '扫描失败')}</div><div class="empty-sub">请先在游戏库中添加 SFS 游戏实例</div></div>`;
    return;
  }
  if (!r.root || !r.root.children || !r.root.children.length) {
    box.innerHTML = '<div class="empty-tip"><div>暂无蓝图</div><div class="empty-sub">Saving\\Blueprints 目录为空或不存在</div></div>';
    return;
  }
  box.innerHTML = treeHtml(r.root, 0);
  box.querySelectorAll('.bp-dir').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.bp-op')) return;
      e.stopPropagation();
      const kids = row.nextElementSibling;
      if (kids && kids.classList.contains('bp-children')) {
        const closed = kids.classList.toggle('hidden');
        row.classList.toggle('collapsed', closed);
      }
    });
  });
  box.querySelectorAll('.bp-op').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const rel = btn.dataset.bpRel;
      const action = btn.dataset.bpAct;
      if (action === 'open') {
        const res = await window.launcher.blueprintOpen(rel);
        if (!res.success) toast('打开失败：' + res.error);
      } else if (action === 'remove') {
        const name = btn.dataset.bpName || rel;
        if (!await appConfirm({ title: '删除蓝图文件夹', body: '确认删除蓝图文件夹「' + name + '」？\n该操作不可恢复。', okText: '删除', danger: true })) return;
        const res = await window.launcher.blueprintRemove(rel);
        if (res.success) { toast('已删除 ' + name); renderBlueprintTree(); }
        else toast('删除失败：' + res.error);
      }
    });
  });
}

function treeHtml(node, depth) {
  const pad = depth * 18;
  if (node.type === 'dir') {
    const kids = node.children || [];
    const rel = esc(node.rel || '');
    const name = esc(node.name);
    const delBtn = depth > 0
      ? `<button class="bp-op danger" data-bp-act="remove" data-bp-rel="${rel}" data-bp-name="${name}">删除</button>`
      : '';
    const row = `<div class="bp-dir collapsed" style="padding-left:${pad}px">
      <span class="bp-caret"></span>
      <span class="bp-folder"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M2.5 6C2.5 5.17 3.17 4.5 4 4.5h4.6c.4 0 .77.16 1.06.44l1.4 1.4c.19.19.44.31.7.31H20c.83 0 1.5.67 1.5 1.5v9.34c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V6z" fill="#f0a828"/><path d="M2.5 9h19v8.5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V9z" fill="#ffce4f"/></svg></span><span class="bp-name">${name}</span>
      <span class="bp-meta">${kids.length} 项</span>
      <span class="bp-ops">
        <button class="bp-op" data-bp-act="open" data-bp-rel="${rel}">打开位置</button>
        ${delBtn}
      </span>
    </div>`;
    const kidsHtml = `<div class="bp-children hidden"><div class="bp-children-inner">${kids.map(c => treeHtml(c, depth + 1)).join('')}</div></div>`;
    return row + kidsHtml;
  }
  const rel = esc(node.rel || '');
  const name = esc(node.name);
  return `<div class="bp-file" data-bp-rel="${rel}" style="padding-left:${pad}px">
    <span class="bp-name">${name}</span>
    <span class="bp-ops"><button class="bp-op" data-bp-act="open" data-bp-rel="${rel}">打开位置</button></span>
  </div>`;
}

$('#btn-bp-refresh').addEventListener('click', () => { renderBlueprintTree(); toast('已刷新蓝图文件夹'); });
$('#btn-bp-import').addEventListener('click', async () => {
  const r = await window.launcher.modPickZip('blueprint');
  if (r.canceled) return;
  if (!/\.zip$/i.test(r.path || '')) { toast('蓝图仅支持 ZIP 压缩包（内含 Blueprints 文件夹），已取消导入'); return; }
  const res = await window.launcher.modDeploy(r.path, 'blueprint');
  toast(res.success ? res.summary : ('导入失败：' + res.error));
  renderBlueprintTree();
  renderMods();
});

$('#btn-tutorial').addEventListener('click', () => { $('#tutorial-modal').hidden = false; });
$$('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('.modal-mask').hidden = true; document.body.classList.remove('modal-open'); }));

// ---- 设置 ----

$('#autoshow-toggle').addEventListener('change', (e) => {
  state.cfg.autoShowOnLaunch = e.target.checked;
  window.launcher.configSave(state.cfg);
  toast(e.target.checked ? '游戏启动时将收起到托盘' : '已关闭该选项');
});

// ===== 毛玻璃材质切换处理（含系统兼容弹窗） =====
async function handleGlassModeChange(mode) {
  const sysInfo = await window.launcher.systemInfo?.() || {};
  const winBuild = sysInfo.winBuild || 0;
  const isWin11 = winBuild >= 22000;

  // 1. 云母：非Win11直接弹窗+降级
  if (mode === 'mica' && !isWin11) {
    await appAlert({
      title: '系统不支持',
      body: '当前系统不支持云母材质，云母仅 Windows 11 可用。已自动切换为亚克力。',
      okText: '确定'
    });
    mode = 'acrylic';
    window.__glassCapsule?.set('acrylic', false);
  }

  // 2. Win11选云母：性能风险确认
  if (mode === 'mica' && isWin11) {
    const ok = await appConfirm({
      title: '性能提示',
      body: '云母材质对显卡有一定要求，部分设备开启后可能出现界面卡顿。是否继续启用云母？',
      cancelText: '取消',
      okText: '继续启用'
    });
    if (!ok) {
      // 用户取消，切回原来的模式
      const prevMode = state.cfg.glass === false ? 'off' : (state.cfg.glassMode || 'acrylic');
      window.__glassCapsule?.set(prevMode, false);
      return;
    }
  }

  // 3. Win11选Aero：不支持，自动降级
  if (mode === 'aero' && isWin11) {
    await appAlert({
      title: '系统不支持',
      body: 'Aero 材质仅 Windows 7 / 早期 Win10 原生支持，Windows 11 无法实现真实 Aero 效果。已自动切换为亚克力。',
      okText: '确定'
    });
    mode = 'acrylic';
    window.__glassCapsule?.set('acrylic', false);
  }

  // 3.5 Win10 弱机选亚克力：默认用更轻的 Aero 保拖动跟手；用户知情确认后可强制 state4 亚克力。
  // 注：Win10 本身支持 Aero(state3)，点 Aero 无需提示，直接生效（极老系统无 DWM 时主进程会安全回退实色）。
  if ((mode === 'acrylic' || mode === 'liuli') && !isWin11) {
    const tier = sysInfo.tier || 'medium';
    const canDwm = sysInfo.canDwm !== false;
    if (tier === 'weak' && canDwm && state.cfg.glassForceAcrylic !== true) {
      const force = await appConfirm({
        title: '亚克力性能提示',
        body: '你的设备性能较弱（内存或 CPU 较低），亚克力毛玻璃在拖动窗口时可能出现跟手延迟或拖影。为保证流畅，默认使用更轻的 Aero。是否仍强制启用亚克力，以获得更白净、更通透的观感？',
        cancelText: '保持 Aero（流畅）',
        okText: '强制亚克力（更好看）'
      });
      if (!force) {
        mode = 'aero';
        window.__glassCapsule?.set('aero', false);
      } else {
        state.cfg.glassForceAcrylic = true;
      }
    }
  }

  // 应用设置
  state.cfg.glassMode = mode;
  state.cfg.glass = mode !== 'off';
  await window.launcher.configSave(state.cfg);

  try {
    const r = await window.launcher.glassSetState({
      enabled: mode !== 'off',
      mode: mode,
      theme: AppTheme.currentResolvedTheme()
    });
    if (r && r.recreated) return; // 窗口已重建
  } catch (err) {}
  AppTheme.syncGlassState();
  try { LiuliTheme.apply(); } catch (e) {}
  try { window.__lpSync && window.__lpSync(); } catch (e) {}
  toast('毛玻璃：' + (mode === 'off' ? '已关闭' : mode === 'aero' ? 'Aero' : mode === 'acrylic' ? '亚克力' : mode === 'liuli' ? '琉璃' : '云母'));
}
// ===== END 毛玻璃材质切换 =====

$('#close-action-select').addEventListener('change', (e) => {
  state.cfg.closeAction = e.target.value;
  window.launcher.configSave(state.cfg);
  toast('关闭按钮行为：' + (e.target.value === 'ask' ? '每次询问' : e.target.value === 'tray' ? '最小化到托盘' : '直接退出'));
});

$('#autogame-toggle').addEventListener('change', async (e) => {
  await window.launcher.autostartSet(e.target.checked);
  state.cfg.autoOpenWithGame = e.target.checked;
  toast(e.target.checked ? '手动启动游戏时将唤起启动器' : '已关闭该选项');
});
// 设置页「重看引导」：随时可以重播新手引导
$('#btn-onboarding-replay') && $('#btn-onboarding-replay').addEventListener('click', () => {
  try { window.Onboarding && Onboarding.replay(state.cfg); } catch (e) { console.warn('onboarding replay failed:', e); }
});
$('#btn-proxy-save').addEventListener('click', async () => {
  const v = $('#proxy-input').value.trim();
  const r = await window.launcher.proxySet(v);
  if (r.success) { state.cfg.proxy = v; toast(v ? ('代理已保存：' + v) : '已清除代理，使用系统代理'); }
  else toast('代理设置失败：' + (r.error || ''));
});
$('#btn-dl-dir').addEventListener('click', async () => {
  const r = await window.launcher.downloadPickDir();
  if (!r.canceled) {
    state.cfg.downloadDir = r.path;
    $('#dl-dir-label').textContent = r.path;
    toast('下载目录已设置为：' + r.path);
  }
});
$('#btn-cloud-dir').addEventListener('click', async () => {
  const r = await window.launcher.cloudPickDir();
  if (!r.canceled) {
    state.cfg.cloudBackupDir = r.path;
    $('#cloud-dir-label').textContent = r.path;
    toast('云盘备份目录已设置为：' + r.path);
  }
});
function wdInputs(){ return { url: $('#webdav-url').value.trim(), user: $('#webdav-user').value.trim(), pass: $('#webdav-pass').value }; }
$('#btn-webdav-test').addEventListener('click', async () => {
  const w = wdInputs();
  $('#webdav-status').textContent = '正在测试连接…';
  const r = await window.launcher.webdavTest(w);
  $('#webdav-status').textContent = r.success ? '连接成功，可以使用云端备份' : ('连接失败：' + (r.error || ''));
  toast(r.success ? 'WebDAV 连接成功' : 'WebDAV 连接失败');
});
$('#btn-webdav-save').addEventListener('click', async () => {
  const w = wdInputs();
  if (w.url && !/^https?:\/\//i.test(w.url)) { toast('地址需以 http:// 或 https:// 开头'); return; }
  const r = await window.launcher.webdavSave(w);
  if (r.success) {
    state.cfg.webdav = w;
    $('#webdav-status').textContent = w.url ? ('已保存：' + w.url) : '已清空 WebDAV 配置';
    toast('WebDAV 已保存');
    renderBackups();
  } else {
    $('#webdav-status').textContent = '保存失败：' + (r.error || '');
    toast('保存失败：' + (r.error || ''));
  }
});
// 毛玻璃下高级过渡动画开关：默认关=轻量淡入流畅；开启后玻璃下也用完整 View Transition（可能掉帧）。
$('#glass-heavy-toggle').addEventListener('change', (e) => {
  state.cfg.glassHeavyAnim = e.target.checked;
  window.launcher.configSave(state.cfg);
  AppTheme.refreshAnimClass();
  toast(e.target.checked ? '毛玻璃下已启用高级过渡动画，若感觉卡顿可关闭' : '毛玻璃下已恢复轻量流畅动画');
});

// ===== 壁纸 / 主题色 / 琉璃材质控件 =====
function wpBasename(p) { return String(p || '').split(/[\\/]/).pop() || ''; }

// 选图后压缩为 JPEG dataURL（多档宽度/质量，3.5MB 预算），对齐参考 readImageFile
const WP_ENCODE_WIDTHS = [2560, 1920, 1440, 1080];
const WP_ENCODE_QUALITIES = [0.86, 0.8];
const WP_DATAURL_BUDGET = 3.5 * 1024 * 1024;
function decodeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}
async function compressWallpaperToDataUrl(srcPath) {
  const url = 'file:///' + String(srcPath || '').replace(/\\/g, '/');
  const img = await decodeImage(url);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸无效');
  let last = null, prevDims = '';
  for (const targetW of WP_ENCODE_WIDTHS) {
    const sc = Math.min(1, targetW / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * sc));
    const h = Math.max(1, Math.round(img.naturalHeight * sc));
    const dims = w + 'x' + h;
    if (dims === prevDims) continue;
    prevDims = dims;
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 不可用');
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of WP_ENCODE_QUALITIES) {
      const dataUrl = cvs.toDataURL('image/jpeg', q);
      last = { dataUrl, width: w, height: h, quality: q };
      if (dataUrl.length <= WP_DATAURL_BUDGET) return last;
    }
  }
  if (!last) throw new Error('没有可用的编码结果');
  return last;
}

function bindAppearanceControls() {
  const cfg = state.cfg;

  // 壁纸文件名回填
  const wpName = $('#wp-file-name');
  if (wpName) wpName.textContent = cfg.wallpaper.path ? wpBasename(cfg.wallpaper.path) : '未设置';

  // 壁纸适应模式
  initButtonGroup('wp-fit-group', cfg.wallpaper.fit || 'cover', (val) => {
    cfg.wallpaper.fit = val;
    window.launcher.configSave(cfg);
    try { LiuliTheme.apply(); } catch (e) {}
  });

  // 壁纸入库方式：压缩 JPEG / 原图复制（仅影响下次选图）
  initButtonGroup('wp-store-group', cfg.wallpaper.storageMode || 'compress', (val) => {
    cfg.wallpaper.storageMode = val;
    window.launcher.configSave(cfg);
  });

  // 主题色：自动 / 手动
  const accentInp = $('#accent-color-input');
  const accentManual = !!cfg.accentOverride;
  window.__accentModeGroup = initButtonGroup('accent-mode-group', accentManual ? 'manual' : 'auto', (val) => {
    if (val === 'auto') {
      cfg.accentOverride = '';
    } else {
      cfg.accentOverride = accentInp ? accentInp.value : '#2e7df6';
    }
    window.launcher.configSave(cfg);
    try { LiuliTheme.apply(); } catch (e) {}
  });
  if (accentInp) {
    accentInp.value = cfg.accentOverride || '#2e7df6';
    accentInp.addEventListener('input', () => {
      cfg.accentOverride = accentInp.value;
      if (window.__accentModeGroup) window.__accentModeGroup.set('manual', false);
      window.launcher.configSave(cfg);
      try { LiuliTheme.apply(); } catch (e) {}
    });
  }

  // 壁纸选择 / 移除
  const wpPick = $('#wp-pick-btn');
  if (wpPick) wpPick.addEventListener('click', async () => {
    try {
      const r = await window.launcher.wallpaperPick();
      if (!r || !r.success || !r.path) return;
      const oldPath = cfg.wallpaper.path;
      let imported = r.path;
      const mode = cfg.wallpaper.storageMode || 'compress';
      try {
        if (mode === 'copy') {
          const ir = await window.launcher.wallpaperImportCopy(r.path);
          if (ir && ir.success) imported = ir.path;
        } else {
          const comp = await compressWallpaperToDataUrl(r.path);
          const ir = await window.launcher.wallpaperImportDataUrl(comp.dataUrl);
          if (ir && ir.success) imported = ir.path;
        }
      } catch (e) { toast('壁纸入库失败'); return; }
      if (oldPath && oldPath !== imported) {
        try { await window.launcher.wallpaperRemoveFile(oldPath); } catch (e) {}
      }
      cfg.wallpaper.path = imported;
      window.launcher.configSave(cfg);
      if (wpName) wpName.textContent = wpBasename(imported);
      try { LiuliTheme.apply(); } catch (e) {}
      toast('壁纸已更新，主题色按新壁纸自动取色');
    } catch (e) { toast('选择壁纸失败'); }
  });
  const wpClear = $('#wp-clear-btn');
  if (wpClear) wpClear.addEventListener('click', async () => {
    const oldPath = cfg.wallpaper.path;
    cfg.wallpaper.path = '';
    window.launcher.configSave(cfg);
    if (wpName) wpName.textContent = '未设置';
    if (oldPath) { try { await window.launcher.wallpaperRemoveFile(oldPath); } catch (e) {} }
    try { LiuliTheme.apply(); } catch (e) {}
    toast('壁纸已移除');
  });

  // ── 琉璃材质参数滑块：实时生效 + 持久化；veil 为 null = 遮罩随主题自动 ──
  const LP_DEF = { opacity: 0.5, glow: 0.15, blur: 10, veil: null };
  const lpEls = {
    opacity: $('#lp-opacity'), opacityVal: $('#lp-opacity-val'),
    veil: $('#lp-veil'), veilVal: $('#lp-veil-val'),
    blur: $('#lp-blur'), blurVal: $('#lp-blur-val'),
    glow: $('#lp-glow'), glowVal: $('#lp-glow-val')
  };
  let lpSaveTimer = null;
  const lpSaveSoon = () => {
    if (lpSaveTimer) clearTimeout(lpSaveTimer);
    lpSaveTimer = setTimeout(() => { window.launcher.configSave(cfg); }, 350);
  };
  function lpSync() {
    if (!lpEls.opacity) return;
    const p = (typeof LiuliTheme.currentParams === 'function')
      ? LiuliTheme.currentParams() : Object.assign({}, LP_DEF);
    const liuli = !!(cfg.glass !== false && cfg.glassMode === 'liuli');
    const panel = $('#liuli-params-panel');
    if (panel) panel.classList.toggle('off', !liuli);
    lpEls.opacity.value = Math.round(p.opacity * 100);
    lpEls.opacityVal.textContent = Math.round(p.opacity * 100) + '%';
    const veilAuto = (p.veil == null);
    const veilShown = veilAuto ? (AppTheme.currentResolvedTheme() === 'light' ? 42 : 34) : Math.round(p.veil * 100);
    lpEls.veil.value = veilShown;
    lpEls.veilVal.textContent = veilAuto ? ('自动（' + veilShown + '%）') : (veilShown + '%');
    lpEls.blur.value = p.blur;
    lpEls.blurVal.textContent = p.blur + 'px';
    lpEls.glow.value = Math.round(p.glow * 100);
    lpEls.glowVal.textContent = Math.round(p.glow * 100) + '%';
    const dis = !liuli;
    ['opacity', 'veil', 'blur', 'glow'].forEach(k => { if (lpEls[k]) lpEls[k].disabled = dis; });
  }
  window.__lpSync = lpSync;
  if (lpEls.opacity) {
    lpEls.opacity.addEventListener('input', () => {
      const v = Number(lpEls.opacity.value) / 100;
      lpEls.opacityVal.textContent = Math.round(v * 100) + '%';
      try { LiuliTheme.applyParams({ opacity: v }); } catch (e) {}
      lpSaveSoon();
    });
    lpEls.veil.addEventListener('input', () => {
      const v = Number(lpEls.veil.value) / 100;
      lpEls.veilVal.textContent = Math.round(v * 100) + '%';
      try { LiuliTheme.applyParams({ veil: v }); } catch (e) {}
      lpSaveSoon();
    });
    lpEls.blur.addEventListener('input', () => {
      const v = Number(lpEls.blur.value);
      lpEls.blurVal.textContent = v + 'px';
      try { LiuliTheme.applyParams({ blur: v }); } catch (e) {}
      lpSaveSoon();
    });
    lpEls.glow.addEventListener('input', () => {
      const v = Number(lpEls.glow.value) / 100;
      lpEls.glowVal.textContent = Math.round(v * 100) + '%';
      try { LiuliTheme.applyParams({ glow: v }); } catch (e) {}
      lpSaveSoon();
    });
  }
  const lpReset = $('#lp-reset-btn');
  if (lpReset) lpReset.addEventListener('click', () => {
    cfg.liuliParams = null;
    window.launcher.configSave(cfg);
    try { LiuliTheme.apply(); } catch (e) {}
    lpSync();
    toast('琉璃材质参数已恢复默认');
  });
  const lpVeilAuto = $('#lp-veil-auto-btn');
  if (lpVeilAuto) lpVeilAuto.addEventListener('click', () => {
    try { LiuliTheme.applyParams({ veil: null }); } catch (e) {}
    lpSaveSoon();
    lpSync();
  });
  lpSync();

  // 壁纸与取色控件绑定结束
}


// ---- 存档备份 ----
async function renderBackups() {
  const box = $('#backup-list');
  if (!box) return;
  const list = await window.launcher.backupList();
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty-tip"><div>暂无存档</div><div class="empty-sub">点击上方「立即备份」创建第一个存档</div></div>';
    return;
  }
  const srcLabel = { webdav: '云端', folder: '同步目录', local: '本地' };
  box.innerHTML = list.map(b => `
    <div class="mod-item">
      <span class="mod-name">${esc(b.name)}</span>
      <span class="mod-meta">[${srcLabel[b.source]||'本地'}] ${(b.size/1024/1024).toFixed(1)} MB · ${new Date(b.time).toLocaleString()}</span>
      <button class="btn small primary" data-restore="${esc(b.name)}" data-src="${esc(b.source||'local')}">恢复到游戏目录</button>
      <button class="btn small ghost" data-restorepick="${esc(b.name)}" data-src="${esc(b.source||'local')}">恢复到自选目录</button>
      <button class="btn small danger" data-bkdel="${esc(b.name)}" data-src="${esc(b.source||'local')}">删除</button>
    </div>`).join('');
  box.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    if (!await appConfirm({ title: '恢复存档', body: '确认恢复此存档？当前游戏目录中的 Mods 和 Saving 会被覆盖。', okText: '恢复', danger: true })) return;
    const r = await window.launcher.backupRestore(b.dataset.restore, null, b.dataset.src);
    toast(r.success ? '已恢复存档' : ('失败：' + r.error));
  }));
  box.querySelectorAll('[data-restorepick]').forEach(b => b.addEventListener('click', async () => {
    const r = await window.launcher.backupPickTarget();
    if (r.canceled) return;
    const res = await window.launcher.backupRestore(b.dataset.restorepick, r.path, b.dataset.src);
    toast(res.success ? '已恢复到 ' + r.path : ('失败：' + res.error));
  }));
  box.querySelectorAll('[data-bkdel]').forEach(b => b.addEventListener('click', async () => {
    if (!await appConfirm({ title: '删除备份', body: '确认删除这个备份？云端或同步目录中的文件也会一并删除。', okText: '删除', danger: true })) return;
    await window.launcher.backupDelete(b.dataset.bkdel, b.dataset.src);
    renderBackups();
  }));
}
async function doBackup() {
  const btn = $('#btn-backup-create');
  if (btn) { btn.disabled = true; btn.textContent = '正在备份…'; }
  try {
    toast('正在创建备份并上传，请稍候…');
    const r = await window.launcher.backupCreateAsync();
    if (r.needCloud) {
      const go = await appConfirm({
        title: '配置云端备份',
        body: '还没有配置云端备份。\n\n坚果云等支持 WebDAV 的网盘：请到「设置 → 云端备份」填写 WebDAV；\nOneDrive/百度网盘：点「去选择目录」指定其本地同步文件夹。\n\n点「取消」放弃本次备份。',
        okText: '去选择目录', cancelText: '取消'
      });
      if (!go) { toast('已取消备份'); return; }
      const pick = await window.launcher.cloudPickDir();
      if (pick.canceled) { toast('未选择目录，已取消备份'); return; }
      state.cfg.cloudBackupDir = pick.path;
      const cl2 = $('#cloud-dir-label'); if (cl2) cl2.textContent = pick.path;
      return doBackup();
    }
    if (r.success) {
      const where = r.cloud === 'webdav' ? '已直传云端' : (r.cloud === 'folder' ? '已存入云盘同步目录' : '已完成');
      toast('备份' + where + '，大小 ' + (r.size/1024/1024).toFixed(1) + ' MB（本地不留副本）');
    } else {
      toast('备份失败：' + r.error);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '创建备份'; }
    renderBackups();
  }
}
$('#btn-backup-create').addEventListener('click', doBackup);
// ---- 关于 ----
const SITES = [
  ['SFS 中文模组站', 'https://sfszhmod.pages.dev/'],
  ['SFS Tools', 'https://sfstools.netlify.app/'],
  ['涂装包制作器', 'https://sfs-texture-pack-maker.pages.dev/'],
  ['行星包生成器', 'https://sfs-planet-pack-generator.pages.dev/'],
  ['挑战榜', 'https://sfs-tanguanbang.pages.dev/']
];

function renderAbout() {
  $('#about-links').innerHTML = SITES.map(([n, u]) => `
    <div class="about-link-row">
      <span>${n}</span>
      <a href="${esc(u)}" target="_blank">${esc(u)}</a>
    </div>`).join('');
}

// ---- 游戏崩溃弹窗（仿系统对话框） ----
const dlgs = (id) => document.getElementById(id);
const showDlg = (id) => { const d = dlgs(id); if (d) d.hidden = false; };
const hideDlg = (id) => { const d = dlgs(id); if (d) d.hidden = true; };

// ---- 关闭按钮首次询问（最小化到托盘 / 直接退出，可记住选择） ----
window.launcher.onClosePrompt(() => {
  const tray0 = document.querySelector('input[name="close-choice"][value="tray"]');
  if (tray0) tray0.checked = true;
  const rm = $('#close-remember'); if (rm) rm.checked = false;
  showDlg('close-dialog');
});
$('#close-cancel').addEventListener('click', () => hideDlg('close-dialog'));
$('#close-confirm').addEventListener('click', () => {
  const picked = document.querySelector('input[name="close-choice"]:checked');
  const action = picked ? picked.value : 'tray';
  const remember = $('#close-remember') ? $('#close-remember').checked : false;
  hideDlg('close-dialog');
  window.launcher.closeDecision({ action, remember });
});

window.launcher.onGameCrashed(() => {
  showDlg('crash-dialog');
});

$('#crash-ok').addEventListener('click', () => hideDlg('crash-dialog'));

// 打开日志：生成过滤后的镜像副本再打开，不改动原 Player.log / Player-prev.log
$('#crash-log').addEventListener('click', async () => {
  const r = await window.launcher.crashOpenFiltered();
  toast(r.success ? '已生成过滤镜像日志并打开（原日志未改动）' : (r.error || '生成失败'));
});

$('#crash-author').addEventListener('click', () => {
  hideDlg('crash-dialog');
  showDlg('author-dialog');
});
$('#author-close').addEventListener('click', () => hideDlg('author-dialog'));

// ---- 注入汉化（集成 SFSChineseInjector，作者 Arctic.）----
// 汉化的注入引擎在那个单文件 exe 里，启动器只负责入口、目录回填和说明。
let hanInstId = null;
async function openHanDialog(inst) {
  hanInstId = inst && inst.id ? inst.id : null;
  const dirEl = $('#han-dir');
  if (dirEl) dirEl.textContent = '读取中…';
  showDlg('han-dialog');
  try {
    const info = await window.launcher.hanInfo();
    if (dirEl) dirEl.textContent = (info && info.gameDir) ? info.gameDir : '未检测到游戏目录，请在注入器里选择';
    if (!info || !info.success) toast('注入器未随包分发，该功能当前不可用');
  } catch (e) {
    if (dirEl) dirEl.textContent = '读取失败';
  }
}
$('#han-cancel').addEventListener('click', () => hideDlg('han-dialog'));
$('#han-run').addEventListener('click', async () => {
  const r = await window.launcher.hanOpen(hanInstId);
  hideDlg('han-dialog');
  if (r && r.success) toast('已启动汉化注入器，在它里面打开两个开关再点「开始游戏」');
  else toast((r && r.error) || '启动失败');
});

// ---- 下载队列 ----
let dlListCache = [];
function fmtSize(n) {
  if (!n) return '0 B';
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function stateLabel(st) {
  return { progressing: '下载中', paused: '已暂停', completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[st] || st;
}
async function renderDownloads() {
  const box = $('#download-list');
  if (!box) return;
  dlListCache = await window.launcher.downloadList();
  if (!dlListCache.length) { box.innerHTML = '<div class="empty-tip"><div>暂无下载任务</div><div class="empty-sub">在模组商店发起下载后，任务将显示在此处</div></div>'; return; }
  box.innerHTML = dlListCache.map(d => `
    <div class="dl-row">
      <div class="dl-info">
        <div class="dl-name">${esc(d.name)}</div>
        <div class="dl-bar"><div class="dl-bar-fill" style="width:${d.pct}%"></div></div>
        <div class="dl-sub">${stateLabel(d.state)} · ${d.pct}% · ${fmtSize(d.recv)}/${fmtSize(d.total)}</div>
      </div>
      ${d.state === 'progressing' || d.state === 'paused' ? `<button class="btn small danger" data-dlcancel="${d.id}">取消</button>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-dlcancel]').forEach(b => b.addEventListener('click', async () => {
    await window.launcher.downloadCancel(Number(b.dataset.dlcancel));
    toast('已取消下载');
    renderDownloads();
  }));
}
$('#btn-dl-refresh').addEventListener('click', renderDownloads);
$('#btn-dl-clear').addEventListener('click', async () => {
  await window.launcher.downloadClearDone();
  renderDownloads();
});
document.querySelector('.nav-item[data-view="downloads"]').addEventListener('click', renderDownloads);
// 进度/完成实时刷新队列页
window.launcher.onDownloadProgress(() => {
  if ($('#view-downloads') && $('#view-downloads').classList.contains('active')) renderDownloads();
});
window.launcher.onDownloadDone(() => {
  if ($('#view-downloads') && $('#view-downloads').classList.contains('active')) renderDownloads();
});

// 启动
init();

// ---- 模组商店：API 拉取 data.json（全字段 + 更新检测 + 兼容提示） ----
let modstoreCache = null;
let modstoreFilter = { category: 'all', search: '' };
// 分类胶囊 data-value（前端 UI 语义）→ 模组站 API data.json 的 category 字段。
// 注意：category 是“内容分类”（功能/引擎/娱乐/涂装/DLL），与 installType（安装方式 parts/textures/dll）是两套字段，不能混用。
const MS_CAT_TO_API = { parts: 'function', engine: 'engine', entertainment: 'entertain', skin: 'skin', dll: 'dll' };
const MS_CAT_LABEL = { function: '功能', engine: '引擎', entertain: '娱乐', skin: '涂装', dll: 'DLL', parts: '部件', textures: '涂装', texture: '涂装', blueprint: '蓝图' };
// 模组内容分类中文名（优先 category，缺失时退回 installType）
function msCategoryLabel(m) {
  const c = m.category || m.installType || '';
  return MS_CAT_LABEL[c] || c || '模组';
}

function normName(n) { return (n || '').toLowerCase().replace(/\.(zip|pack|dll)$/i, '').replace(/[\s\-_（）()【】\[\]]+/g, ''); }

// 检查模组是否已安装 / 是否有更新（按名称模糊匹配）
function modInstallStatus(m) {
  const inst = (state.cfg && state.cfg.mods && state.cfg.mods.installed) || [];
  const target = normName(m.name);
  for (const it of inst) {
    const iname = normName(it.name);
    if (iname && (iname.includes(target) || target.includes(iname)) && target.length >= 2) {
      // 已安装；若商店版本号更新则提示可更新
      if (m.version && it.version && m.version !== it.version) return { installed: true, updatable: true, ver: it.version };
      return { installed: true, updatable: false };
    }
  }
  return { installed: false, updatable: false };
}

function msSpinner() {
  return '<div class="ms-loading"><div class="ms-spinner"></div><span>正在加载模组列表…</span></div>';
}

async function loadModstore() {
  const grid = $('#modstore-grid');
  if (!grid) return;
  grid.innerHTML = msSpinner();
  try {
    let mods = modstoreCache;
    if (mods && !mods.length) mods = null; // 空结果不进缓存，下次进入商店重试
    if (!mods) {
      let r;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000); // 无超时会让界面永久停在加载态
      try {
        r = await fetch('https://sfszhmod.pages.dev/data/data.json', { signal: ac.signal });
      } finally { clearTimeout(timer); }
      const raw = await r.json();
      // 站点 data.json 外层是 { config, files } 包装，不是纯数组。
      // 这里必须兼容两种形态，否则会把 116 条数据误判成「暂无模组」。
      mods = Array.isArray(raw) ? raw : ((raw && (raw.files || raw.mods || raw.list)) || []);
      modstoreCache = mods;
    }
    if (!mods || !mods.length) { grid.innerHTML = '<div class="empty-tip">暂无模组</div>'; return; }

    // 分类 + 搜索过滤
    let filtered = mods;
    if (modstoreFilter.category !== 'all') {
      // 按内容分类 category 过滤；API 缺失 category 时用 installType 兜底
      const want = MS_CAT_TO_API[modstoreFilter.category] || modstoreFilter.category;
      filtered = filtered.filter(m => (m.category || m.installType) === want);
    }
    if (modstoreFilter.search) {
      const q = modstoreFilter.search.toLowerCase();
      filtered = filtered.filter(m =>
        (m.name || '').toLowerCase().includes(q) ||
        (m.author || '').toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }

    if (!filtered.length) {
      grid.innerHTML = '<div class="empty-tip">没有匹配的模组<br><span style="font-size:12px;color:var(--text-dim)">试试切换分类或修改搜索关键词</span></div>';
      return;
    }

    grid.innerHTML = filtered.map((m) => {
      const realIdx = mods.indexOf(m); // 保留原始索引用于事件绑定
      const imgs = (m.images || []);
      const img = imgs[0] || '';
      const tags = (m.tags || []).map(t => `<span class="ms-tag">${esc(t)}</span>`).join('');
      const dl = m.installUrl || m.link || '';
      const canDl = /^https?:/i.test(dl) && !/^暂/i.test(dl);
      const st = modInstallStatus(m);
      const badge = st.updatable
        ? '<span class="ms-badge update">可更新 ' + esc(m.version || '') + '</span>'
        : st.installed ? '<span class="ms-badge installed">已安装</span>' : '';
      const gallery = imgs.length > 1
        ? '<div class="ms-thumbs">' + imgs.slice(1, 4).map(u => `<img src="${u}" loading="lazy" onerror="this.style.display='none'"/>`).join('') + '</div>'
        : '';
      const typeLabel = msCategoryLabel(m);
      return `<div class="ms-card">
        <div class="ms-img-wrap">
          ${img ? `<img class="ms-img" src="${img}" loading="lazy" onerror="this.style.display='none'"/>` : `<div class="ms-img ms-img-ph">SFS</div>`}
          <span class="ms-type-badge">${esc(typeLabel)}</span>
          ${badge}
        </div>
        <div class="ms-body">
          <div class="ms-name">${esc(m.name || '未命名')} ${m.version ? '<span class="ms-ver">' + esc(m.version) + '</span>' : ''}</div>
          <div class="ms-desc">${esc(m.desc || '')}</div>
          ${gallery}
          <div class="ms-meta">
            <span>作者：${esc(m.author || '匿名')}</span>
            <span>大小：${esc(m.size || '未知')}</span>
            ${m.compat ? `<span class="ms-compat">兼容：${esc(m.compat)}</span>` : ''}
            ${m.date ? `<span>更新：${esc(m.date)}</span>` : ''}
            ${m.heat ? `<span>热度：${esc(m.heat)}</span>` : ''}
            ${m.type ? `<span>格式：${esc(m.type)}</span>` : ''}
          </div>
          <div class="ms-tags">${tags}</div>
          <div class="ms-actions">
            ${canDl ? `<button class="btn small ${st.updatable ? 'primary' : ''}" data-ms-dl="${realIdx}">${st.updatable ? '更新' : (st.installed ? '重新下载' : '下载')}</button>` : ''}
            <button class="btn small ghost" data-ms-detail="${realIdx}">详情</button>
          </div>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('[data-ms-dl]').forEach(b => b.addEventListener('click', async () => {
      const m = mods[Number(b.dataset.msDl)];
      if (m.installUrl) {
        await window.launcher.modDownloadURL(m.installUrl);
        toast('已开始下载：' + (m.name || '') + '。可在「下载队列」查看进度，完成后到「模组」页导入');
      }
    }));
    // 详情按钮
    grid.querySelectorAll('[data-ms-detail]').forEach(b => b.addEventListener('click', () => {
      const m = mods[Number(b.dataset.msDetail)];
      showModDetail(m);
    }));
  } catch (e) {
    grid.innerHTML = '<div class="empty-tip">加载失败：' + esc(e.message) + '<br><button class="btn small ghost" id="ms-retry">重试</button></div>';
    const rb = $('#ms-retry'); if (rb) rb.addEventListener('click', () => loadModstore());
  }
}

// ===== 模组详情弹窗 =====
function showModDetail(m) {
  $('#mod-detail-title').textContent = m.name || '模组详情';
  $('#mod-detail-author').textContent = m.author || '匿名';
  $('#mod-detail-version').textContent = m.version || '未知';
  $('#mod-detail-size').textContent = m.size || '未知';
  $('#mod-detail-compat').textContent = m.compat || '全版本';
  $('#mod-detail-tags').textContent = (m.tags || []).join('、') || '无';
  $('#mod-detail-desc').textContent = m.desc || '暂无介绍';
  const cover = $('#mod-detail-cover');
  const img = (m.images || [])[0];
  if (img) {
    cover.innerHTML = `<img src="${img}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;"/>`;
  } else {
    cover.textContent = 'SFS 模组';
  }
  $('#mod-detail-dialog').hidden = false;

  // 下载按钮
  const dlBtn = $('#mod-detail-download');
  dlBtn.onclick = async () => {
    if (m.installUrl) {
      await window.launcher.modDownloadURL(m.installUrl);
      toast('已开始下载：' + (m.name || ''));
      $('#mod-detail-dialog').hidden = true;
    }
  };
}
$('#mod-detail-close').addEventListener('click', () => { $('#mod-detail-dialog').hidden = true; });
// ===== END 模组详情弹窗 =====

// ===== 模组商店分类 + 搜索 =====
window.__modCatCapsule = initSegmentCapsule('mod-cat-capsule', 'all', (val) => {
  modstoreFilter.category = val;
  loadModstore();
});
$('#mod-search').addEventListener('input', (e) => {
  modstoreFilter.search = e.target.value.trim();
  loadModstore();
});
// ===== END 模组商店分类 + 搜索 =====

// ===== 模组页类型筛选胶囊 =====
initSegmentCapsule('mod-type-capsule', 'all', (val) => {
  state_modFilter = val;
  if (window.VirtInstalled && VirtInstalled.selected && VirtInstalled.selected.clear) VirtInstalled.selected.clear();
  renderMods();
});

// 扩展包快捷导入
$('#btn-mod-solar')?.addEventListener('click', async () => {
  const r = await window.launcher.modPickSolar();
  if (r.canceled) return;
  toast(r.success ? r.summary : ('导入失败：' + r.error));
  renderMods();
});

// 清空导入历史
$('#btn-import-history-clear')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  await window.launcher.modClearHistory?.();
  renderMods();
});

// 导入历史：顶部快捷入口 + 可折叠区（默认折叠）
function toggleHistSec() {
  const sec = $('#hist-sec');
  if (!sec) return;
  const willOpen = sec.classList.contains('collapsed');
  sec.classList.toggle('collapsed', !willOpen);
  return willOpen;
}
$('#btn-import-history')?.addEventListener('click', () => {
  const opened = toggleHistSec();
  if (opened) $('#hist-sec')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#hist-sec-title')?.addEventListener('click', (e) => {
  if (e.target.closest('#btn-import-history-clear')) return;
  toggleHistSec();
});

// 查看游戏日志（SFS Player.log 镜像，不改原日志）
$('#btn-open-playerlog')?.addEventListener('click', async () => {
  const r = await window.launcher.gameOpenPlayerLog();
  if (!r || !r.success) toast('无法打开游戏日志：' + ((r && r.error) || '未知错误'));
});

// ===== 顶部下载进度面板 =====
let dlPanelCollapsed = true; // 默认折叠
$('#dl-progress-header').addEventListener('click', () => {
  dlPanelCollapsed = !dlPanelCollapsed;
  $('#dl-progress-body').hidden = dlPanelCollapsed;
  $('#dl-toggle').textContent = dlPanelCollapsed ? '展开 ▾' : '收起 ▴';
});

// 刷新下载进度面板（最多显示3条）
function refreshDlProgressPanel(tasks) {
  const list = $('#dl-progress-list');
  if (!list) return;
  if (!tasks || !tasks.length) {
    list.innerHTML = '<div class="empty-tip" style="padding:12px 0;">暂无下载任务</div>';
    $('#dl-more-tip').hidden = true;
    return;
  }
  const showCount = Math.min(3, tasks.length);
  const showTasks = tasks.slice(0, showCount);
  list.innerHTML = showTasks.map(t => `
    <div class="dl-item">
      <div class="dl-item-name">${esc(t.name || '下载中')}</div>
      <div class="dl-item-bar"><div class="dl-item-fill" style="width:${t.percent || 0}%"></div></div>
      <div class="dl-item-meta">
        <span>${t.status || '下载中'}</span>
        <span>${t.percent || 0}%</span>
      </div>
    </div>
  `).join('');

  // 超过3条显示提示
  if (tasks.length > 3) {
    $('#dl-more-tip').hidden = false;
    $('#dl-more-link').textContent = `还有 ${tasks.length - 3} 项任务，前往下载队列查看全部 ›`;
  } else {
    $('#dl-more-tip').hidden = true;
  }
}
$('#dl-more-link').addEventListener('click', () => {
  // 跳转到下载队列页面
  document.querySelector('.nav-item[data-view="downloads"]').click();
});
// ===== END 顶部下载进度面板 =====

// ===== 运行日志按钮 =====
$('#btn-open-logdir').addEventListener('click', () => {
  window.launcher.openLogDir?.();
});
$('#btn-open-appdir').addEventListener('click', () => {
  window.launcher.openAppDir?.();
});
// ===== END 运行日志按钮 =====
