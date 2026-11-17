'use strict';

// 主题 / 毛玻璃 / 过渡动画的单一控制器（渲染端）。
// 收拢原先散落在 init、外观下拉、毛玻璃开关、系统主题监听里的逻辑，
// 运行时状态只从注入的 cfg 读取，避免多处各自读写导致表现不一致。
//
// 动画策略：
//   · 普通窗（玻璃关）：完整 View Transition 鸿蒙风交叉淡入 + 缩放/亮度回正；
//   · 毛玻璃·轻量档（默认）：仅 opacity 轻量淡入，不做全页快照/缩放/亮度，保证分层透明窗流畅；
//   · 毛玻璃·高级档（设置中手动开启 glassHeavyAnim）：恢复完整 View Transition，视觉更华丽但可能掉帧。
(function () {
  let cfg = null;

  const isLightScheme = () => window.matchMedia('(prefers-color-scheme: light)').matches;
  // t 显式指定时以 t 为准（切换主题、初始化都会把目标主题传进来）；t 省略时才回退到 cfg.theme。
  function resolve(t) {
    const mode = t || (cfg && cfg.theme) || 'dark';
    if (mode === 'system') return isLightScheme() ? 'light' : 'dark';
    return mode === 'light' ? 'light' : 'dark';
  }
  const currentResolvedTheme = () => resolve((cfg && cfg.theme) || 'dark');
  const glassOn = () => !!(cfg && cfg.glass === true);
  const heavyGlassAnim = () => glassOn() && cfg.glassHeavyAnim === true;
  const notify = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const supportsVT = () => typeof document.startViewTransition === 'function';

  // 毛玻璃下切深浅色的轻量淡入：只动 opacity（纯合成、不触发布局/滤镜）。
  function playGlassFade() {
    const body = document.body;
    if (!body) return;
    body.classList.remove('theme-glass-fade');
    void body.offsetWidth; // 强制重排以重启动画
    body.classList.add('theme-glass-fade');
  }

  // 根级材质变量类（glass-dwm / glass-acrylic / glass-aero / glass-mica / glass-fallback）。
  const GLASS_MAT_CLASSES = ['glass-dwm', 'glass-acrylic', 'glass-fallback', 'glass-aero', 'glass-mica'];
  let _appliedModeClass = '';
  function applyModeClass(mode) {
    // 幂等：深浅切换时主进程返回的材质模式不变（如都是 aero），不再反复 remove/add 根级材质类，
    // 避免在 DWM tint 同步的同时触发一次多余的整页样式重算。
    if (mode !== _appliedModeClass) {
      _appliedModeClass = mode;
      const cls = (mode === 'dwm' || mode === 'acrylic' || mode === 'aero' || mode === 'mica') ? 'glass-' + mode : '';
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        el.classList.remove.apply(el.classList, GLASS_MAT_CLASSES);
        if (cls) el.classList.add(cls);
      }
    }
    micaWatch(mode);
  }

  // 把毛玻璃开关与实际生效主题同步给主进程（Win10 DWM 亚克力 tint 需跟随深浅主题），
  // 并按主进程实时返回的材质模式挂载根级材质变量类。
  function syncGlassState() {
    try {
      if (!window.launcher || !window.launcher.glassSetState) return;
      const enabled = glassOn();
      const theme = currentResolvedTheme();
      Promise.resolve(window.launcher.glassSetState({ enabled, theme })).then((r) => {
        const mode = (r && r.mode) || 'off';
        applyModeClass(mode);
        if (enabled && mode === 'off' && !syncGlassState._warned) {
          syncGlassState._warned = true;
          notify('当前系统不支持毛玻璃，已保持纯色背景');
        }
      }).catch(() => {});
    } catch (e) {}
  }

  function applyDom(resolved) {
    const g = glassOn();
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.classList.toggle('glass', g);
    if (document.body) document.body.classList.toggle('glass', g);
    root.classList.toggle('glass-anim-heavy', heavyGlassAnim());
    if (!g) root.classList.remove('glass-solidify');
    const gt = document.getElementById('glass-toggle');
    if (gt) gt.checked = g;
    // 主题切换时调用方已用 theme-switching 冻结颜色过渡，CSS 变量在本帧一次性落地；
    // 此时 DWM tint 同步重合成与这“一次性重绘”自然合并，实测总掉帧与“不改 tint”下限一致，无需延迟。
    syncGlassState();
  }

  function applyTheme(t, opts) {
    const resolved = resolve(t);
    const g = glassOn();
    const apply = () => applyDom(resolved);
    const changed = document.documentElement.getAttribute('data-theme') !== resolved;
    const animate = !!(opts && opts.animate);
    if (animate && changed) {
      if (!g || heavyGlassAnim()) {
        // 普通窗，或玻璃下手动开启高级动画：完整鸿蒙风 View Transition。
        if (supportsVT()) { document.startViewTransition(apply); return; }
      } else {
        // 毛玻璃轻量档：切换瞬间冻结所有元素的颜色过渡，让深浅 CSS 变量一次性到位。
        // 否则数百元素同时在 .08s 内过渡背景/文字/阴影，会形成持续重绘风暴、反复迫使 DWM 重模糊，
        // 弱机连续掉 6~7 帧；冻结后只剩一次性光栅化（弱机约 1~2 帧），DWM tint 与其同帧合并。
        // 再用一次纯合成的 body opacity 淡入柔化瞬变，不生硬、不触发布局。
        const root = document.documentElement;
        root.classList.add('theme-switching');
        apply();
        void document.body.offsetWidth; // 强制同步布局：带“无过渡”的新主题在本帧一次性落地
        root.classList.remove('theme-switching');
        playGlassFade();
        return;
      }
    }
    apply();
  }

  // 仅切换动画档位 class（高级动画开关用），不换主题、不重建窗口。
  function refreshAnimClass() {
    document.documentElement.classList.toggle('glass-anim-heavy', heavyGlassAnim());
  }

  // 材质恒定：滚动期间不再把界面切换为实色（旧 glass-solidify 已移除），彻底消除滚动时
  // 玻璃/实色来回闪烁。弱机的滚动与拖动流畅度由主进程按显卡/CPU 分档保证（弱机全程 Aero、
  // 中档拖动时临时降 Aero），渲染端不再在滚动时改任何材质变量。

  // Win11 云母(mica)掉帧监测：仅 mica 材质激活。滚动长列表时用 rAF 采帧间隔（不读布局、开销极小），
  // 连续多次滚动会话中位帧仍低于 30fps（判定弱 GPU），通知主进程写回退标记，下次启动改亚克力。
  let micaOn = false, micaSampling = false, micaSlow = 0, micaRaf = 0, micaLast = 0, micaIdleT = 0, micaFrames = [];
  function micaEndSession() {
    if (micaRaf) { cancelAnimationFrame(micaRaf); micaRaf = 0; }
    micaSampling = false;
    clearTimeout(micaIdleT);
    const ts = micaFrames; micaFrames = []; micaLast = 0;
    if (ts.length >= 60) {
      const d = [];
      for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
      d.sort((a, b) => a - b);
      const med = d[d.length >> 1];
      if (med > 33.4) { // 中位帧间隔 >33.4ms ≈ 低于 30fps
        micaSlow++;
        if (micaSlow >= 3 && window.launcher && window.launcher.glassMaterialFallback) {
          Promise.resolve(window.launcher.glassMaterialFallback()).then((r) => {
            if (r && r.fellBack) notify('云母材质在当前设备上滚动不够流畅，已在下次启动自动改用亚克力');
            micaSetOn(false);
          }).catch(() => {});
        }
      } else if (micaSlow > 0) micaSlow--; // 流畅会话抵消，避免偶发卡顿累积误判
    }
  }
  function micaLoop(now) {
    if (!micaOn) { micaRaf = 0; return; }
    if (micaLast) micaFrames.push(now);
    micaLast = now;
    micaRaf = requestAnimationFrame(micaLoop);
  }
  function micaOnScroll() {
    if (!micaOn) return;
    if (!micaSampling) { micaSampling = true; micaFrames = []; micaLast = 0; micaRaf = requestAnimationFrame(micaLoop); }
    clearTimeout(micaIdleT);
    micaIdleT = setTimeout(micaEndSession, 250);
  }
  function micaSetOn(on) {
    if (on === micaOn) return;
    micaOn = on;
    micaSlow = 0; micaSampling = false; micaFrames = [];
    if (micaIdleT) { clearTimeout(micaIdleT); micaIdleT = 0; }
    if (micaRaf) { cancelAnimationFrame(micaRaf); micaRaf = 0; }
    if (on) window.addEventListener('scroll', micaOnScroll, { capture: true, passive: true });
    else window.removeEventListener('scroll', micaOnScroll, { capture: true });
  }
  function micaWatch(mode) { micaSetOn(mode === 'mica'); }

  window.AppTheme = {
    setCfg(c) { cfg = c; },
    applyTheme,
    syncGlassState,
    refreshAnimClass,
    currentResolvedTheme,
    playGlassFade
  };

  // 主进程在启动后异步读取 GPU 信息，若判定当前显卡带不动亚克力会无缝把材质降为 Aero
  // （dwm/aero 同为分层窗、无需重建），收到后只换根级材质类，不打断当前界面。
  if (window.launcher && window.launcher.onGlassModeChanged) {
    window.launcher.onGlassModeChanged(function (d) {
      if (d && d.mode) applyModeClass(d.mode);
    });
  }

  // 跟随系统：处于“跟随系统”时，系统深浅变化带动画切换。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (cfg && cfg.theme === 'system') applyTheme('system', { animate: true });
  });
})();
