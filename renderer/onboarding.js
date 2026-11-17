'use strict';

// 新手教程：5 页讲解 → 三项上手任务清单。替换原先的 8 步聚光引导。
// 讲解首启自动播一次（cfg.onboardingDone），清单在讲解结束后或下次启动时出现，
// 三项全部完成或手动隐藏后写 cfg.learnDone，不再打扰。
// 纯前端，不改动业务逻辑；注入汉化只能确认"打开过注入器"，按 cfg.hanOpened 判定。
(function () {
  const PAGES = [
    {
      t: '这套工具管什么',
      te: 'What this tool handles',
      b: '四件事：游戏实例、模组、存档备份、汉化。装好游戏后多数操作都围绕一个「当前实例」，切换实例不会影响其它版本的游戏目录。',
      be: 'Four things: game instances, mods, backups, and localization. Once the game is installed, most work happens around one active instance; switching between instances never touches the other installs.',
      k: ['一个实例对应一份游戏目录', '切换只改变界面操作的对象'],
      ke: ['One instance maps to one game folder', 'Switching only changes what the UI acts on']
    },
    {
      t: '先把游戏挂进来',
      te: 'Add the game first',
      b: '游戏库可以扫描 Steam 库，也可以手动选目录。识别到 Spaceflight Simulator 后加入列表，只有 SFS 能被添加。',
      be: 'The Library scans Steam libraries or takes a folder you pick. Once Spaceflight Simulator is found it joins the list — only SFS can be added.',
      k: ['Steam 装在非默认位置时，先指定它的根目录', '添加时只校验 SFS，不认其它游戏'],
      ke: ['If Steam sits in a non-default path, set its root folder first', 'Only SFS passes the check, other games are rejected']
    },
    {
      t: '模组怎么装',
      te: 'How mods get installed',
      b: '商店挑好下载，文件先落到「待导入」，确认类型后才部署进游戏目录。部件、涂装包、蓝图、DLL、扩展包五类，各有对应的目标目录。',
      be: 'Pick in the store, download, and the file lands in Pending. Nothing touches the game folder until you confirm the type. Parts, texture packs, blueprints, DLLs and solar packs each go to their own target folder.',
      k: ['下载阶段不写入游戏目录', '装错了可以在已装列表里移除'],
      ke: ['Downloads never write into the game folder', 'Anything installed by mistake can be removed from the installed list']
    },
    {
      t: '汉化两种方式',
      te: 'Two ways to localize',
      b: '本体汉化把社区词表写进游戏数据目录，只多一个 txt，删掉即恢复英文；DLL 汉化在游戏运行时注入进程，不落盘。两个开关都在注入器界面里，启动器不代管。',
      be: 'Text localization writes a community word list into the game data folder — one txt, delete it to go back to English. DLL localization injects into the running process and writes nothing to disk. Both switches live in the injector, not here.',
      k: ['部分杀毒软件会拦截进程注入', '注入被拦下时游戏仍显示英文'],
      ke: ['Some antivirus tools block process injection', 'When it is blocked the game stays in English']
    },
    {
      t: '备份和外观',
      te: 'Backups and appearance',
      b: '存档页一键备份，可以存本地、云盘同步目录或 WebDAV，改坏了能还原。外观支持深浅色、壁纸取色和五档毛玻璃，弱机可以降到 Aero 或纯色。',
      be: 'One-click backups on the Saves page, kept locally, in a cloud sync folder, or on WebDAV, restorable when something breaks. Appearance covers dark/light, wallpaper-derived accents and five glass levels — weaker machines can drop to Aero or solid.',
      k: ['备份包含模组与存档数据', '云端备份走 WebDAV 或同步文件夹'],
      ke: ['Backups include mods and save data', 'Cloud backups go through WebDAV or a sync folder']
    }
  ];

  const TASKS = [
    {
      id: 'inst',
      zh: '添加一个游戏实例',
      en: 'Add a game instance',
      hintZh: '游戏库 → 扫描 Steam 库，或手动选目录',
      hintEn: 'Library → scan Steam libraries, or pick a folder manually',
      view: 'games'
    },
    {
      id: 'mod',
      zh: '导入一个模组',
      en: 'Import a mod',
      hintZh: '模组页导入部件、涂装包或蓝图，或从商店下载',
      hintEn: 'Import parts, texture packs or blueprints on the Mods page, or download from the store',
      view: 'mods'
    },
    {
      id: 'han',
      zh: '打开汉化注入器',
      en: 'Open the localization injector',
      hintZh: '游戏库右键实例 → 注入汉化（打开即算完成）',
      hintEn: 'Right-click an instance in the Library → Inject localization (opening it counts)',
      view: 'games'
    }
  ];

  let cfgRef = null;
  let page = 0;
  let guideEl = null, cardEl = null;
  let checkEl = null, checkTimer = null;
  let guideRunning = false;
  let checkVisible = false;

  function isEn() { return window.I18NGetLang && window.I18NGetLang() === 'en'; }
  function L(zh, en) { return isEn() ? en : zh; }

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function save() {
    if (!cfgRef) return;
    try { window.launcher.configSave(cfgRef); } catch (e) {}
  }

  function switchView(view) {
    if (!view) return;
    const want = document.querySelector('.nav-item[data-view="' + view + '"]');
    if (want && !want.classList.contains('active')) want.click();
  }

  /* ---------------- 5 页讲解 ---------------- */

  function renderPage() {
    if (!cardEl) return;
    const p = PAGES[page];
    cardEl.innerHTML = '';
    const head = mk('div', 'ob2-head');
    head.appendChild(mk('span', 'ob2-step', (page + 1) + ' / ' + PAGES.length));
    const skip = mk('button', 'ob2-skip', L('跳过', 'Skip'));
    skip.type = 'button';
    skip.addEventListener('click', () => closeGuide(true));
    head.appendChild(skip);
    cardEl.appendChild(head);

    cardEl.appendChild(mk('div', 'ob2-title', L(p.t, p.te)));
    cardEl.appendChild(mk('div', 'ob2-body', L(p.b, p.be)));

    const keys = L(p.k, p.ke) || [];
    if (keys.length) {
      const ul = mk('ul', 'ob2-keys');
      keys.forEach(x => {
        const li = mk('li', null, x);
        ul.appendChild(li);
      });
      cardEl.appendChild(ul);
    }

    const foot = mk('div', 'ob2-foot');
    const back = mk('button', 'ob2-btn', L('上一步', 'Back'));
    back.type = 'button';
    back.disabled = page === 0;
    back.addEventListener('click', () => { if (page > 0) { page--; renderPage(); } });
    const next = mk('button', 'ob2-btn ob2-primary', page === PAGES.length - 1 ? L('开始', 'Start') : L('下一步', 'Next'));
    next.type = 'button';
    next.addEventListener('click', () => {
      if (page >= PAGES.length - 1) closeGuide(true);
      else { page++; renderPage(); }
    });
    foot.appendChild(back);
    foot.appendChild(next);
    cardEl.appendChild(foot);
  }

  function openGuide() {
    if (guideRunning) return;
    if (!guideEl) {
      guideEl = mk('div', 'ob2-mask');
      guideEl.id = 'ob2-mask';
      cardEl = mk('div', 'ob2-card');
      guideEl.appendChild(cardEl);
      document.body.appendChild(guideEl);
      guideEl.addEventListener('click', (e) => {
        // 点遮罩不关闭，避免误触退出教程
        e.stopPropagation();
      });
      document.addEventListener('keydown', onKey, true);
    }
    guideRunning = true;
    page = 0;
    guideEl.hidden = false;
    renderPage();
  }

  function onKey(e) {
    if (!guideRunning) return;
    if (e.key === 'Escape') { e.preventDefault(); closeGuide(true); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      if (page >= PAGES.length - 1) closeGuide(true);
      else { page++; renderPage(); }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (page > 0) { page--; renderPage(); }
    }
  }

  function closeGuide(finished) {
    guideRunning = false;
    if (guideEl) guideEl.hidden = true;
    if (finished && cfgRef && !cfgRef.onboardingDone) {
      cfgRef.onboardingDone = true;
      save();
    }
    if (finished) showChecklist();
  }

  /* ---------------- 三项任务清单 ---------------- */

  let modDone = false;
  let lastSig = '';

  async function readStates() {
    const out = { inst: false, mod: false, han: false };
    try {
      out.inst = !!(cfgRef && Array.isArray(cfgRef.instances) && cfgRef.instances.length);
      // 优先读已同步的配置，避免等一次 IPC 往返；配置里没有时再问主进程
      out.mod = !!(cfgRef && cfgRef.mods && Array.isArray(cfgRef.mods.installed) && cfgRef.mods.installed.length);
    } catch (e) {}
    out.han = !!(cfgRef && cfgRef.hanOpened);
    // 已装模组数兜底走主进程；一旦查到非空就缓存，避免每次轮询都读一遍大配置
    if (!out.mod && !modDone) {
      try {
        const r = await window.launcher.modList();
        modDone = !!(r && Array.isArray(r.installed) && r.installed.length);
      } catch (e) {}
    }
    out.mod = out.mod || modDone;
    return out;
  }

  async function renderChecklist() {
    if (!checkEl) return;
    const st = await readStates();
    const sig = (st.inst ? 1 : 0) + (st.mod ? 2 : 0) + (st.han ? 4 : 0);
    // 轮询期间状态没变就不重建 DOM，避免无意义的重复渲染
    if (sig === lastSig && checkEl.childElementCount) return;
    lastSig = sig;
    const done = TASKS.filter(t => st[t.id]).length;

    checkEl.innerHTML = '';
    const head = mk('div', 'ob2-check-head');
    head.appendChild(mk('span', 'ob2-check-title', L('上手任务', 'Getting started')));
    const cnt = mk('span', 'ob2-check-count', done + ' / ' + TASKS.length);
    head.appendChild(cnt);
    const hide = mk('button', 'ob2-check-hide', L('隐藏', 'Hide'));
    hide.type = 'button';
    hide.addEventListener('click', () => {
      if (cfgRef && !cfgRef.learnDone) { cfgRef.learnDone = true; save(); }
      hideChecklist();
    });
    head.appendChild(hide);
    checkEl.appendChild(head);

    TASKS.forEach(t => {
      const row = mk('div', 'ob2-check-item' + (st[t.id] ? ' done' : ''));
      const dot = mk('span', 'ob2-check-dot', st[t.id] ? '✓' : '');
      row.appendChild(dot);
      const txt = mk('div', 'ob2-check-text');
      txt.appendChild(mk('div', 'ob2-check-label', L(t.zh, t.en)));
      if (!st[t.id]) txt.appendChild(mk('div', 'ob2-check-hint', L(t.hintZh, t.hintEn)));
      row.appendChild(txt);
      if (!st[t.id] && t.view) {
        row.addEventListener('click', () => switchView(t.view));
        row.classList.add('clickable');
      }
      checkEl.appendChild(row);
    });

    if (done === TASKS.length) {
      const fin = mk('div', 'ob2-check-done', L('三项完成，可以正常用了', 'All three done — you are set'));
      checkEl.appendChild(fin);
      if (cfgRef && !cfgRef.learnDone) { cfgRef.learnDone = true; save(); }
      setTimeout(hideChecklist, 1600);
    }
  }

  function showChecklist() {
    if (checkVisible) return;
    if (cfgRef && cfgRef.learnDone) return;
    if (!checkEl) {
      checkEl = mk('div', 'ob2-check');
      checkEl.id = 'ob2-check';
      document.body.appendChild(checkEl);
    }
    checkVisible = true;
    checkEl.hidden = false;
    lastSig = '';
    renderChecklist();
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      if (!checkVisible) return;
      renderChecklist();
    }, 3000);
  }

  function hideChecklist() {
    checkVisible = false;
    if (checkEl) checkEl.hidden = true;
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  }

  /* ---------------- 对外接口 ---------------- */

  window.Onboarding = {
    replay(cfg) {
      cfgRef = cfg;
      openGuide();
    },
    maybeAutoStart(cfg) {
      cfgRef = cfg;
      if (window.launcher && window.launcher.smokeMode) return;
      if (!cfg) return;
      if (!cfg.onboardingDone) {
        setTimeout(() => { if (!guideRunning) openGuide(); }, 800);
        return;
      }
      if (!cfg.learnDone) setTimeout(showChecklist, 900);
    },
    isRunning() { return guideRunning; },
    refreshChecklist() { lastSig = ''; if (checkVisible) renderChecklist(); }
  };
})();
