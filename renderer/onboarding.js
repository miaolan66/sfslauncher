'use strict';

// 新手引导（Unity 式聚光分步引导）。
// 首启自动播放一次，可上一步/下一步/跳过；完成后写 cfg.onboardingDone，
// 设置页「重看新手引导」可随时重播。纯前端，不改动任何业务逻辑。
(function () {
  const STEPS = [
    {
      view: 'home',
      target: '#instance-hero',
      title: '当前游戏实例',
      text: '这张卡片显示当前选中的实例和安装路径，右下「开始游戏」直接启动；右键卡片可以给它单独设一张背景图。'
    },
    {
      view: 'home',
      target: '#btn-home-add',
      title: '添加游戏实例',
      text: '点这里手动添加：选游戏目录或直接选 SFS 的 exe。旁边「自动检测 Steam」会扫描已装 Steam 里的 SFS。'
    },
    {
      target: '.nav-item[data-view="games"]',
      title: '游戏库',
      text: '所有实例都在这一页：切换当前实例、改名称和路径、启动游戏。首页展示的就是这里选中的实例。'
    },
    {
      target: '.nav-item[data-view="mods"]',
      title: '模组',
      text: '管理已装模组：按类型筛选，扫描已装、清理重复、导入扩展包和部件（.pack），也能导出清单。'
    },
    {
      target: '.nav-item[data-view="modstore"]',
      title: '模组商店',
      text: '浏览在线模组。下载的文件先进「待安装」，确认类型后再部署到游戏目录，不会直接写进游戏。'
    },
    {
      target: '.nav-item[data-view="downloads"]',
      title: '下载队列',
      text: '下载进度都在这里，失败可以重试，完成后可直接部署或打开所在文件夹。'
    },
    {
      target: '.nav-item[data-view="saves"]',
      title: '存档',
      text: '查看存档并创建备份。改坏或误删存档时可以从备份还原，支持还原到单个存档。'
    },
    {
      target: '.nav-item[data-view="settings"]',
      title: '设置',
      text: '外观主题、毛玻璃／琉璃材质、壁纸和取色都在这里。开启琉璃后可以用壁纸自动取色，也能手动指定强调色。'
    }
  ];

  let cfgRef = null;
  let idx = 0;
  let layer = null, spot = null, tip = null, titleEl = null, countEl = null, bodyEl = null;
  let prevBtn = null, nextBtn = null, skipBtn = null;
  let currentTarget = null;
  let running = false;

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (layer) return;
    layer = mk('div');
    layer.id = 'ob-layer';
    layer.hidden = true;

    spot = mk('div');
    spot.id = 'ob-spot';

    tip = mk('div');
    tip.id = 'ob-tip';

    const head = mk('div', 'ob-head');
    titleEl = mk('div', 'ob-title');
    countEl = mk('div', 'ob-count');
    head.appendChild(titleEl);
    head.appendChild(countEl);

    bodyEl = mk('div', 'ob-body');

    const foot = mk('div', 'ob-foot');
    skipBtn = mk('button', 'ob-btn ob-skip', '跳过');
    skipBtn.type = 'button';
    const nav = mk('div', 'ob-nav');
    prevBtn = mk('button', 'ob-btn', '上一步');
    prevBtn.type = 'button';
    nextBtn = mk('button', 'ob-btn ob-next', '下一步');
    nextBtn.type = 'button';
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    foot.appendChild(skipBtn);
    foot.appendChild(nav);

    tip.appendChild(head);
    tip.appendChild(bodyEl);
    tip.appendChild(foot);
    layer.appendChild(spot);
    layer.appendChild(tip);
    document.body.appendChild(layer);

    prevBtn.addEventListener('click', () => go(idx - 1));
    nextBtn.addEventListener('click', () => {
      if (idx >= STEPS.length - 1) finish(true);
      else go(idx + 1);
    });
    skipBtn.addEventListener('click', () => finish(true));

    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!running) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); if (idx >= STEPS.length - 1) finish(true); else go(idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
  }

  function switchView(view) {
    if (!view) return;
    const want = document.querySelector('.nav-item[data-view="' + view + '"]');
    if (!want) return;
    if (!want.classList.contains('active')) want.click();
  }

  function save() {
    if (!cfgRef) return;
    try { window.launcher.configSave(cfgRef); } catch (e) {}
  }

  async function go(i) {
    if (i < 0 || i > STEPS.length - 1) return;
    idx = i;
    const step = STEPS[idx];
    switchView(step.view);
    if (step.view) await new Promise(r => setTimeout(r, 320));
    if (!running) return;
    render();
  }

  function render() {
    const step = STEPS[idx];
    let target = document.querySelector(step.target);
    if (target) {
      const r0 = target.getBoundingClientRect();
      if (r0.width === 0 && r0.height === 0) target = null;
    }
    if (!target) {
      // 目标不存在（页面还没渲染/被裁掉）时顺延，避免卡在空步骤
      if (idx < STEPS.length - 1) { return go(idx + 1); }
      return finish(true);
    }
    currentTarget = target;
    titleEl.textContent = step.title;
    bodyEl.textContent = step.text;
    countEl.textContent = (idx + 1) + ' / ' + STEPS.length;
    prevBtn.disabled = idx === 0;
    prevBtn.style.opacity = idx === 0 ? '.45' : '';
    nextBtn.textContent = idx === STEPS.length - 1 ? '完成' : '下一步';
    reposition();
  }

  function reposition() {
    if (!running || !currentTarget) return;
    const t = currentTarget;
    if (!t.isConnected) return;
    const r = t.getBoundingClientRect();
    const pad = 6;
    const left = Math.max(8, r.left - pad);
    const top = Math.max(8, r.top - pad);
    const w = Math.max(24, r.width + pad * 2);
    const h = Math.max(24, r.height + pad * 2);
    spot.style.left = left + 'px';
    spot.style.top = top + 'px';
    spot.style.width = w + 'px';
    spot.style.height = h + 'px';

    const vw = window.innerWidth, vh = window.innerHeight;
    const tw = 340;
    let tipLeft = Math.min(Math.max(16, r.left), vw - tw - 16);
    // 侧栏类窄目标：提示框放到右侧，避免挡住被高亮的那一项
    if (r.width < 200 && r.left < 220) tipLeft = Math.min(vw - tw - 16, r.right + 18);
    const below = r.bottom + 16;
    const above = r.top - 16;
    const tipH = tip.offsetHeight || 170;
    let tipTop;
    if (below + tipH <= vh - 12) tipTop = below;
    else if (above - tipH >= 12) tipTop = above - tipH;
    else tipTop = Math.max(12, Math.min(vh - tipH - 12, r.bottom + 16));
    tip.style.left = tipLeft + 'px';
    tip.style.top = tipTop + 'px';
  }

  function start() {
    if (!cfgRef) return;
    build();
    running = true;
    layer.hidden = false;
    go(0);
  }

  function finish(done) {
    running = false;
    if (layer) layer.hidden = true;
    currentTarget = null;
    if (done && cfgRef && !cfgRef.onboardingDone) {
      cfgRef.onboardingDone = true;
      save();
    }
  }

  window.Onboarding = {
    replay(cfg) {
      cfgRef = cfg;
      start();
    },
    maybeAutoStart(cfg) {
      cfgRef = cfg;
      if (window.launcher && window.launcher.smokeMode) return;
      if (!cfg || cfg.onboardingDone) return;
      setTimeout(() => { if (!running) start(); }, 800);
    },
    isRunning() { return running; }
  };
})();
