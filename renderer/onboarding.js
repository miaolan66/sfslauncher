'use strict';

// 新手教程：8 步强制操作导览 + 四项上手任务清单。
// 每一步必须完成指定操作才前进，Esc 跳过当前步；走完后出现清单。
// 添加实例、汉化会打开原生弹窗，教程在这些步骤自动让出遮罩，避免挡住弹窗。
// 导入模组走商店下载 → 待导入 → 导入的完整流程，但用示例数据，不下载、不写游戏目录。
(function () {
  const PAGES = [
    {
      t: '首页',
      te: 'Home',
      b: '首页集中了启动游戏、切换实例和最近游玩记录。先熟悉这个入口。',
      be: 'Home holds the launch button, the instance switcher and recent games. Start here.',
      k: ['一个实例对应一份游戏目录', '切换实例只改变界面操作的对象'],
      ke: ['One instance maps to one game folder', 'Switching only changes what the UI acts on'],
      target: '.nav-item[data-view="home"]',
      act: '点击左侧「首页」',
      acte: 'Click Home in the sidebar'
    },
    {
      t: '添加游戏实例',
      te: 'Add a game instance',
      b: '点「+ 添加游戏实例」，选择 SFS 的游戏目录或 exe，确认后加入列表。名称不能和已有实例重复。',
      be: 'Click "+ Add game instance", pick the SFS folder or exe, and confirm. The name must not duplicate an existing instance.',
      k: ['只接受 Spaceflight Simulator', '同名实例会被拒绝'],
      ke: ['Only Spaceflight Simulator is accepted', 'Duplicate names are rejected'],
      note: '本步只在没有任何实例时出现；已有实例会自动跳过。',
      noteEn: 'This step only appears when no instance exists; it is skipped when one is already present.',
      target: '#btn-home-add',
      act: '点「+ 添加游戏实例」，选目录并确认',
      acte: 'Click "+ Add game instance", pick a folder and confirm',
      view: 'home',
      skipIf: function () { return hasInstances(); },
      onEnter: function () { stepBase = (cfgRef && cfgRef.instances ? cfgRef.instances.length : 0); },
      advance: 'condition',
      check: function () { return !!(cfgRef && cfgRef.instances && cfgRef.instances.length > stepBase); },
      yieldWhen: function () { return dialogOpen('install-dialog'); }
    },
    {
      t: '游戏库',
      te: 'Library',
      b: '游戏库可以扫描 Steam 库，也可以手动选目录。识别到 Spaceflight Simulator 后加入列表，只有 SFS 能被添加。',
      be: 'The Library scans Steam libraries or takes a folder you pick. Once Spaceflight Simulator is found it joins the list — only SFS can be added.',
      k: ['Steam 装在非默认位置时，先指定它的根目录', '添加时只校验 SFS，不认其它游戏'],
      ke: ['If Steam sits in a non-default path, set its root folder first', 'Only SFS passes the check, other games are rejected'],
      target: '.nav-item[data-view="games"]',
      act: '点击左侧「游戏库」',
      acte: 'Click Library in the sidebar',
      view: 'games'
    },
    {
      id: 'store',
      t: '从商店下载模组',
      te: 'Download a mod from the store',
      b: '商店里挑一个模组点「下载」。本步使用示例数据：不会真的下载，也不会写入游戏目录。',
      be: 'Pick a mod in the store and click Download. This step uses demo data: nothing is downloaded or written to the game folder.',
      k: ['下载只进入待导入，不直接改游戏目录', '示例数据仅用于演示流程'],
      ke: ['Downloads only go to Pending', 'Demo data only demonstrates the flow'],
      note: '示例数据，不会下载、不会写入游戏目录。',
      noteEn: 'Demo data. Nothing is downloaded or written to the game folder.',
      target: '#modstore-grid .ms-card [data-ms-dl]',
      act: '点第一张卡片的「下载」',
      acte: 'Click Download on the first card',
      view: 'modstore',
      waitTarget: true,
      advance: 'condition',
      check: function () { return !!fakePending; },
      onEnter: function () {
        try { if (!document.querySelector('#modstore-grid .ms-card') && window.loadModstore) window.loadModstore(); } catch (e) {}
      }
    },
    {
      t: '在待导入里点导入',
      te: 'Import from Pending',
      b: '进入「模组」页，「待导入」里会出现刚才的示例项。点「导入」后显示示例完成。示例数据不会写入游戏目录。',
      be: 'Go to Mods. The demo item appears under Pending. Click Import to see the demo result. Nothing is written to the game folder.',
      k: ['示例项标有「示例」', '导入结果不会改动游戏'],
      ke: ['The demo row is marked Demo', 'The result does not touch the game'],
      note: '这一步只演示导入流程，不会改动已装模组。',
      noteEn: 'This step only demonstrates the flow; installed mods are untouched.',
      target: '[data-tut-fake-import]',
      act: '点示例项右侧的「导入」',
      acte: 'Click Import on the demo row',
      view: 'mods',
      waitTarget: true,
      onEnter: function () { try { if (window.renderMods) window.renderMods(); } catch (e) {} }
    },
    {
      t: '汉化',
      te: 'Chinese localization',
      b: '右键当前实例，选「汉化」，打开窗口即可。本步只要求打开，不要求点安装。',
      be: 'Right-click the current instance and choose Chinese localization. This step only requires opening the window, not installing.',
      k: ['安装前先退出游戏', '卸载会恢复游戏原来的语言设置'],
      ke: ['Close the game before installing', 'Uninstalling restores the original language setting'],
      note: '只要求打开窗口，不要求点「安装汉化」。',
      noteEn: 'Only opening the window is required; installing is not forced.',
      target: '#added-game-list .game-card, .game-card',
      act: '右键实例 → 汉化，打开窗口',
      acte: 'Right-click the instance → Chinese localization',
      view: 'games',
      advance: 'condition',
      check: function () { return dialogOpen('han-dialog'); },
      yieldWhen: function () { return dialogOpen('ctx-menu') || dialogOpen('han-dialog'); }
    },
    {
      t: '备份和还原',
      te: 'Backups and restore',
      b: '存档页一键备份，可以存本地、云盘同步目录或 WebDAV，改坏了能还原。备份默认只打 Mods 和 Saving，不碰游戏本体。',
      be: 'One-click backups on the Saves page, kept locally, in a cloud sync folder, or on WebDAV, restorable when something breaks. Backups cover Mods and Saving only, never the game install.',
      k: ['备份包含模组与存档数据', '云端备份走 WebDAV 或同步文件夹'],
      ke: ['Backups include mods and save data', 'Cloud backups go through WebDAV or a sync folder'],
      target: '.nav-item[data-view="saves"]',
      act: '点击左侧「存档」',
      acte: 'Click Saves in the sidebar',
      view: 'saves'
    },
    {
      t: '外观和性能',
      te: 'Appearance and performance',
      b: '深浅色、壁纸取色和毛玻璃都在设置页。弱机可以降到 Aero 或纯色；改完立即生效，不需要重启。',
      be: 'Dark/light, wallpaper accents and glass levels live in Settings. Weaker machines can drop to Aero or solid; changes apply immediately, no restart.',
      k: ['掉帧或未响应时先降毛玻璃档位', '壁纸取色只影响强调色，不改布局'],
      ke: ['Drop the glass level first if frames stutter', 'Wallpaper accents only change the accent color, not the layout'],
      target: '.nav-item[data-view="settings"]',
      act: '点击左侧「设置」完成导览',
      acte: 'Click Settings to finish the tour',
      view: 'settings'
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
      hintZh: '模组商店下载 → 模组页待导入 → 导入',
      hintEn: 'Download in the store → Pending on Mods → Import',
      view: 'modstore'
    },
    {
      id: 'han',
      zh: '安装汉化',
      en: 'Install Chinese localization',
      hintZh: '游戏库右键实例 → 汉化 → 安装汉化',
      hintEn: 'Right-click an instance in the Library → Chinese localization → Install',
      view: 'games'
    },
    {
      id: 'guide',
      zh: '走完新手导览',
      en: 'Finish the guided tour',
      hintZh: '设置 → 新手引导 → 重看引导',
      hintEn: 'Settings → Getting started → Replay',
      action: 'replay'
    }
  ];

  let cfgRef = null;
  let page = 0;
  let pages = PAGES;
  let guideEl = null, cardEl = null, spotEl = null;
  let panels = [];
  let targetEl = null, targetHandler = null;
  let guideRunning = false;
  let guideBound = false;
  let posRaf = 0;
  let stepPoll = null, waitTimer = null;
  let stepBase = 0;
  let fakePending = null;
  let checkEl = null, checkTimer = null;
  let checkVisible = false;
  let modDone = false;
  let modChecked = false;
  let hanDone = false;
  let hanChecked = false;
  let lastSig = '';

  function isEn() { return window.I18NGetLang && window.I18NGetLang() === 'en'; }
  function L(zh, en) { return isEn() ? en : zh; }

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function $(sel) { return document.querySelector(sel); }
  function dialogOpen(id) {
    const el = document.getElementById(id);
    return !!(el && !el.hidden);
  }
  function anyDialogOpen() {
    return ['install-dialog', 'add-method-dialog', 'han-dialog', 'import-dialog', 'confirm-dialog', 'modal-mask']
      .some(dialogOpen);
  }
  function hasInstances() {
    return !!(cfgRef && Array.isArray(cfgRef.instances) && cfgRef.instances.length);
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

  /* ---------------- 强制操作导览 ---------------- */

  function ensureGuideUI() {
    if (guideEl) return;
    guideEl = mk('div', 'ob2-mask');
    guideEl.id = 'ob2-mask';
    ['top', 'bottom', 'left', 'right'].forEach(function (k) {
      const hole = mk('div', 'ob2-hole');
      hole.dataset.hole = k;
      hole.addEventListener('click', function (e) {
        // 点遮罩不关闭，也不放行：必须点高亮控件
        e.stopPropagation();
      });
      panels.push(hole);
      guideEl.appendChild(hole);
    });
    spotEl = mk('div', 'ob2-spot');
    guideEl.appendChild(spotEl);
    cardEl = mk('div', 'ob2-card');
    guideEl.appendChild(cardEl);
    document.body.appendChild(guideEl);
  }

  function clearTarget() {
    if (targetEl && targetHandler) {
      targetEl.removeEventListener('click', targetHandler, true);
    }
    targetEl = null;
    targetHandler = null;
    if (stepPoll) { clearInterval(stepPoll); stepPoll = null; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  }

  function bindClick(p) {
    if (!targetEl || p.advance === 'condition') return;
    targetHandler = function (e) {
      if (!guideRunning) return;
      try { if (p.onTargetClick) p.onTargetClick(e); } catch (err) {}
      // 让控件自己的点击逻辑先跑完，再前进
      setTimeout(function () { if (guideRunning) advanceStep(); }, 0);
    };
    targetEl.addEventListener('click', targetHandler, true);
  }

  function waitForTarget(p, tries) {
    if (!guideRunning) return;
    const el = document.querySelector(p.target);
    if (el) {
      targetEl = el;
      bindClick(p);
      schedulePlace();
      return;
    }
    if (tries >= 60) {
      try { toast('教程：没有找到可操作的位置，已跳过这一步', 3600); } catch (e) {}
      advanceStep();
      return;
    }
    waitTimer = setTimeout(function () { waitForTarget(p, tries + 1); }, 120);
  }

  function bindTarget(p) {
    clearTarget();
    if (p.waitTarget) {
      waitForTarget(p, 0);
      return;
    }
    targetEl = document.querySelector(p.target);
    if (!targetEl) {
      // 控件被布局变化藏掉时，退到当前页首个导航项，避免教程卡死
      targetEl = document.querySelector('.nav-item.active') || document.querySelector('.nav-item');
    }
    if (!targetEl) return;
    bindClick(p);
  }

  function startStepPoll(p) {
    if (stepPoll) { clearInterval(stepPoll); stepPoll = null; }
    stepPoll = setInterval(function () {
      if (!guideRunning) return;
      try {
        if (p.check && p.check()) {
          advanceStep();
          return;
        }
        const blocked = anyDialogOpen() || (p.yieldWhen && p.yieldWhen());
        if (blocked) {
          if (!guideEl.hidden) guideEl.hidden = true;
        } else if (guideEl.hidden) {
          guideEl.hidden = false;
          schedulePlace();
        }
      } catch (e) {}
    }, 350);
  }

  function placeGuide() {
    if (!guideRunning || !cardEl || !spotEl || !targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const pad = 6;
    const x1 = Math.max(0, rect.left - pad);
    const y1 = Math.max(0, rect.top - pad);
    const x2 = Math.min(window.innerWidth, rect.right + pad);
    const y2 = Math.min(window.innerHeight, rect.bottom + pad);
    const W = window.innerWidth;
    const H = window.innerHeight;

    const setBox = function (el, x, y, w, h) {
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = Math.max(0, w) + 'px';
      el.style.height = Math.max(0, h) + 'px';
    };
    const top = panels[0], bottom = panels[1], left = panels[2], right = panels[3];
    setBox(top, 0, 0, W, y1);
    setBox(bottom, 0, y2, W, H - y2);
    setBox(left, 0, y1, x1, y2 - y1);
    setBox(right, x2, y1, W - x2, y2 - y1);

    spotEl.style.left = x1 + 'px';
    spotEl.style.top = y1 + 'px';
    spotEl.style.width = Math.max(0, x2 - x1) + 'px';
    spotEl.style.height = Math.max(0, y2 - y1) + 'px';

    const cw = Math.min(420, W - 32);
    cardEl.style.width = cw + 'px';
    const ch = cardEl.offsetHeight;
    let leftPos = x2 + 18;
    if (leftPos + cw > W - 16) leftPos = x1 - cw - 18;
    if (leftPos < 16) leftPos = 16;
    let topPos = y1 - 6;
    if (topPos + ch > H - 16) topPos = H - ch - 16;
    if (topPos < 16) topPos = 16;
    cardEl.style.left = leftPos + 'px';
    cardEl.style.top = topPos + 'px';
  }

  function schedulePlace() {
    if (posRaf) cancelAnimationFrame(posRaf);
    posRaf = requestAnimationFrame(function () {
      posRaf = 0;
      placeGuide();
    });
  }

  function renderPage() {
    if (!guideRunning) return;
    if (page >= pages.length) { closeGuide(true); return; }

    if (stepPoll) { clearInterval(stepPoll); stepPoll = null; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }

    const p = pages[page];
    if (p.view) switchView(p.view);
    if (p.onEnter) { try { p.onEnter(); } catch (e) {} }

    cardEl.innerHTML = '';
    const head = mk('div', 'ob2-head');
    head.appendChild(mk('span', 'ob2-step', (page + 1) + ' / ' + pages.length));
    const quit = mk('button', 'ob2-skip', L('退出教程', 'Quit tour'));
    quit.type = 'button';
    quit.addEventListener('click', function () { closeGuide(true); });
    head.appendChild(quit);
    cardEl.appendChild(head);

    cardEl.appendChild(mk('div', 'ob2-title', L(p.t, p.te)));
    cardEl.appendChild(mk('div', 'ob2-body', L(p.b, p.be)));

    const keys = L(p.k, p.ke) || [];
    if (keys.length) {
      const ul = mk('ul', 'ob2-keys');
      keys.forEach(function (x) { ul.appendChild(mk('li', null, x)); });
      cardEl.appendChild(ul);
    }

    if (p.note) {
      const note = mk('div', 'ob2-note', L(p.note, p.noteEn));
      cardEl.appendChild(note);
    }

    cardEl.appendChild(mk('div', 'ob2-act', L(p.act, p.acte)));

    const foot = mk('div', 'ob2-foot');
    foot.appendChild(mk('div', 'ob2-esc', L('必须完成这一步才会继续', 'Complete this step to continue')));
    foot.appendChild(mk('div', 'ob2-esc', 'Esc ' + L('跳过当前步', 'skips this step')));
    cardEl.appendChild(foot);

    bindTarget(p);
    startStepPoll(p);
    guideEl.hidden = anyDialogOpen();
    schedulePlace();
    setTimeout(schedulePlace, 60);
  }

  function advanceStep() {
    if (!guideRunning) return;
    if (stepPoll) { clearInterval(stepPoll); stepPoll = null; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    clearTarget();
    if (page >= pages.length - 1) { closeGuide(true); return; }
    page++;
    renderPage();
  }

  function openGuide() {
    if (guideRunning) return;
    ensureGuideUI();
    guideRunning = true;
    page = 0;
    pages = PAGES.filter(function (p) {
      try { return !(p.skipIf && p.skipIf()); } catch (e) { return true; }
    });
    guideEl.hidden = false;
    if (!guideBound) {
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('click', onTutorialClick, true);
      window.addEventListener('resize', schedulePlace);
      document.addEventListener('scroll', schedulePlace, true);
      guideBound = true;
    }
    renderPage();
  }

  // 商店下载按钮会随卡片重建，统一在 document 捕获阶段拦截，避免监听挂在已被替换的节点上
  function onTutorialClick(e) {
    if (!guideRunning) return;
    if (!pages[page] || pages[page].id !== 'store' || fakePending) return;
    const btn = e.target && e.target.closest ? e.target.closest('[data-ms-dl]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fakePending = { name: 'Demo Parts.pack', type: 'parts' };
    try { toast('示例数据：已加入待导入（不会下载、不会写入游戏目录）', 4200); } catch (err) {}
  }

  function onKey(e) {
    if (!guideRunning) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      advanceStep();
    }
  }

  function closeGuide(finished) {
    guideRunning = false;
    clearTarget();
    if (posRaf) { cancelAnimationFrame(posRaf); posRaf = 0; }
    if (guideEl) guideEl.hidden = true;
    if (finished && cfgRef) {
      cfgRef.onboardingDone = true;
      cfgRef.learnDone = false;
      save();
    }
    if (finished) openChecklist(true);
  }

  /* ---------------- 四项任务清单 ---------------- */

  async function readStates() {
    const out = { inst: false, mod: false, han: false, guide: false };
    try {
      out.inst = !!(cfgRef && Array.isArray(cfgRef.instances) && cfgRef.instances.length);
      // 优先读已同步的配置，避免等一次 IPC 往返；配置里没有时再问主进程
      out.mod = !!(cfgRef && cfgRef.mods && Array.isArray(cfgRef.mods.installed) && cfgRef.mods.installed.length);
      // 教程里的示例导入也算完成这一项，否则假数据永远走不完清单
      if (cfgRef && cfgRef.tutorialModDone) out.mod = true;
    } catch (e) {}
    out.han = !!(cfgRef && cfgRef.hanOpened);
    out.guide = !!(cfgRef && cfgRef.onboardingDone);
    if (!out.mod && !modChecked) {
      try {
        const r = await window.launcher.modList();
        modDone = !!(r && Array.isArray(r.installed) && r.installed.length);
      } catch (e) {}
      modChecked = true;
    }
    out.mod = out.mod || modDone || !!(cfgRef && cfgRef.tutorialModDone);
    if (!out.han && !hanChecked) {
      try {
        const h = await window.launcher.hanStatus();
        hanDone = !!(h && h.installed);
        if (hanDone && cfgRef && !cfgRef.hanOpened) { cfgRef.hanOpened = true; save(); }
      } catch (e) {}
      hanChecked = true;
    }
    out.han = out.han || hanDone;
    return out;
  }

  async function renderChecklist() {
    if (!checkEl) return;
    const st = await readStates();
    const sig = (st.inst ? 1 : 0) + (st.mod ? 2 : 0) + (st.han ? 4 : 0) + (st.guide ? 8 : 0);
    if (sig === lastSig && checkEl.childElementCount) return;
    lastSig = sig;
    const done = TASKS.filter(function (t) { return st[t.id]; }).length;

    checkEl.innerHTML = '';
    const head = mk('div', 'ob2-check-head');
    head.appendChild(mk('span', 'ob2-check-title', L('上手任务', 'Getting started')));
    head.appendChild(mk('span', 'ob2-check-count', done + ' / ' + TASKS.length));
    const hide = mk('button', 'ob2-check-hide', L('隐藏', 'Hide'));
    hide.type = 'button';
    hide.addEventListener('click', function () {
      if (cfgRef && !cfgRef.learnDone) { cfgRef.learnDone = true; save(); }
      hideChecklist();
    });
    head.appendChild(hide);
    checkEl.appendChild(head);

    TASKS.forEach(function (t) {
      const row = mk('div', 'ob2-check-item' + (st[t.id] ? ' done' : ''));
      row.appendChild(mk('span', 'ob2-check-dot', st[t.id] ? '✓' : ''));
      const txt = mk('div', 'ob2-check-text');
      txt.appendChild(mk('div', 'ob2-check-label', L(t.zh, t.en)));
      if (!st[t.id]) txt.appendChild(mk('div', 'ob2-check-hint', L(t.hintZh, t.hintEn)));
      row.appendChild(txt);
      if (!st[t.id]) {
        if (t.action === 'replay') {
          row.addEventListener('click', function () {
            hideChecklist();
            openGuide();
          });
          row.classList.add('clickable');
        } else if (t.view) {
          row.addEventListener('click', function () { switchView(t.view); });
          row.classList.add('clickable');
        }
      }
      checkEl.appendChild(row);
    });

    if (done === TASKS.length) {
      checkEl.appendChild(mk('div', 'ob2-check-done', L('四项完成，可以正常用了', 'All four done — you are set')));
      // 不再自动隐藏，等用户主动点「隐藏」或在设置里重开
    }
    syncToastStack();
  }

  // 任务清单固定在右下角，提示条在底部居中；清单可见时把提示条抬到清单上方，避免相互遮挡
  function syncToastStack() {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    if (checkVisible && checkEl && !checkEl.hidden) {
      stack.style.bottom = (18 + (checkEl.offsetHeight || 0) + 14) + 'px';
    } else {
      stack.style.bottom = '';
    }
  }

  function openChecklist(force) {
    if (checkVisible && !force) return;
    if (!force && cfgRef && cfgRef.learnDone) return;
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
    checkTimer = setInterval(function () {
      if (!checkVisible) return;
      renderChecklist();
    }, 3000);
  }

  function hideChecklist() {
    checkVisible = false;
    if (checkEl) checkEl.hidden = true;
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    syncToastStack();
  }

  /* ---------------- 对外接口 ---------------- */

  window.Onboarding = {
    replay(cfg) {
      cfgRef = cfg;
      if (cfgRef) { cfgRef.learnDone = false; save(); }
      hideChecklist();
      openGuide();
    },
    maybeAutoStart(cfg) {
      cfgRef = cfg;
      if (window.launcher && window.launcher.smokeMode) return;
      if (!cfg) return;
      if (!cfg.onboardingDone) {
        setTimeout(function () { if (!guideRunning) openGuide(); }, 800);
        return;
      }
      if (!cfg.learnDone) setTimeout(function () { openChecklist(false); }, 900);
    },
    isRunning() { return guideRunning; },
    refreshChecklist() { lastSig = ''; if (checkVisible) renderChecklist(); },
    showChecklist() { openChecklist(true); },
    getFakePending() { return fakePending; },
    clearFakePending() { fakePending = null; },
    markFakeModDone() {
      if (cfgRef) { cfgRef.tutorialModDone = true; save(); }
    }
  };
})();
