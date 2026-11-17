'use strict';

// 琉璃（liuli）主题控制器（渲染端）。
// 底层模糊仍走主进程 DWM 原生合成（glassMode==='liuli' 在主进程按亚克力映射），
// 本控制器负责：背景壁纸铺设、按壁纸（或手动色）经 MCU 派生整套 M3 角色色、琉璃材质参数落地。
// 派生 / 取色 / 遮罩 / 阴影逻辑对齐参考 qqnt-liuli-theme；角色色挂为 --ll-*，
// 再映射到启动器现有 CSS 变量，现有页面选择器不动。
(function () {
  let cfg = null;
  let wpEl = null;
  let wpGeneration = 0;
  let paletteGeneration = 0;
  // 壁纸层当前绘制元数据：veil/blur 为 null 时按主题自动取值，用户手动调过则固定
  let wpMeta = { url: '', dim: null, blur: null };
  const DEFAULT_PARAMS = { opacity: 0.5, glow: 0.15, blur: 10, veil: null };

  const DEFAULT_SOURCE = '#2e7df6';

  function resolvedTheme() {
    if (window.AppTheme && typeof window.AppTheme.currentResolvedTheme === 'function') {
      return window.AppTheme.currentResolvedTheme();
    }
    const mode = (cfg && cfg.theme) || 'dark';
    if (mode === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return mode === 'light' ? 'light' : 'dark';
  }
  const isDark = () => resolvedTheme() !== 'light';
  const liuliOn = () => !!(cfg && cfg.glass !== false && cfg.glassMode === 'liuli');
  // 壁纸遮罩自动档：深色压暗 0.34、浅色提亮 0.42（压住高对比图案，避免条纹穿过半透明面板像花屏）
  const autoVeil = () => (isDark() ? 0.34 : 0.42);
  // 用户可调的琉璃材质参数，未显式保存的维度回落到默认
  function currentParams() {
    const p = (cfg && cfg.liuliParams) || {};
    return {
      opacity: (typeof p.opacity === 'number' ? p.opacity : DEFAULT_PARAMS.opacity),
      glow: (typeof p.glow === 'number' ? p.glow : DEFAULT_PARAMS.glow),
      blur: (typeof p.blur === 'number' ? p.blur : DEFAULT_PARAMS.blur),
      veil: (typeof p.veil === 'number' ? p.veil : null)
    };
  }

  // ── 取色：64px 缩略图里挑高彩度、明暗适中的主色（移植参考 chromaticSourceFromCanvas） ──
  function chromaticSourceFromCanvas(ctx, w, h) {
    let px;
    try { px = ctx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    let best = { r: 29, g: 125, b: 246, score: -1 };
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
      if (a < 128) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const chroma = max - min;
      const l = (max + min) / 2;
      if (l < 35 || l > 220) continue;
      const score = chroma - Math.abs(l - 128) * 0.4;
      if (score > best.score) best = { r, g, b, score };
    }
    const hex = v => v.toString(16).padStart(2, '0');
    return '#' + hex(best.r) + hex(best.g) + hex(best.b);
  }
  function chromaOf(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length < 6) return 0;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b);
  }

  // 元数据缓存：只留 ratio / source，上限 4 条；并发同图去重（移植参考 readImageMetadata）
  const imageMetadata = new Map();
  const pendingImages = new Map();
  function rememberImage(src, metadata) {
    imageMetadata.delete(src);
    imageMetadata.set(src, metadata);
    while (imageMetadata.size > 4) imageMetadata.delete(imageMetadata.keys().next().value);
    return metadata;
  }
  function readImageMetadata(src) {
    const cached = imageMetadata.get(src);
    if (cached && cached.source) return Promise.resolve(rememberImage(src, cached));
    if (pendingImages.has(src)) return pendingImages.get(src);
    const pending = (async () => {
      const img = new Image();
      if (img.decode) { img.src = src; await img.decode(); }
      else {
        await new Promise((resolve, reject) => {
          img.onload = resolve; img.onerror = reject; img.src = src;
        });
      }
      const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
      const size = 64;
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = size;
      const ctx = cvs.getContext('2d');
      let source = DEFAULT_SOURCE;
      if (ctx) {
        try {
          ctx.drawImage(img, 0, 0, size, size);
          const picked = chromaticSourceFromCanvas(ctx, size, size);
          if (picked && chromaOf(picked) >= 24) source = picked;
        } catch (e) { source = DEFAULT_SOURCE; }
      }
      return rememberImage(src, { ratio, source });
    })().finally(() => pendingImages.delete(src));
    pendingImages.set(src, pending);
    return pending;
  }
  async function extractSource() {
    const src = (cfg && cfg.wallpaper && cfg.wallpaper.path) || '';
    if (!src) return DEFAULT_SOURCE;
    try { return (await readImageMetadata(toFileUrl(src))).source; }
    catch (e) { return DEFAULT_SOURCE; }
  }

  // ── 颜色工具 ──
  function rgbTriplet(hex) {
    const h = String(hex).replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ');
  }
  function normalizeHex(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return '#' + h.toLowerCase();
  }
  function alphaComposite(fg, bg, a) {
    const ph = fg.replace('#', ''), bh = bg.replace('#', '');
    const out = [0, 2, 4].map(i => {
      const p = parseInt(ph.slice(i, i + 2), 16);
      const b = parseInt(bh.slice(i, i + 2), 16);
      return Math.round(a * p + (1 - a) * b).toString(16).padStart(2, '0');
    });
    return '#' + out.join('');
  }

  // ── 强调色归一化 ──
  // M3 直接按壁纸派生出的 primary 明度/彩度不受控：浅色下常落到 #785a00 这类泥金（填充发脏、白字发灰），
  // 深色下又可能过亮。这里把色相保留（仍跟随壁纸），只把彩度抬进可用区间、明度钳进可读区间，
  // 字色按 WCAG 对比度在黑白之间选，保证任何壁纸下按钮都不出现"深底深字 / 泥底白字"。
  function hexToRgbArr(hex) {
    const h = String(hex || '').replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, s * 100, l * 100];
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const h2 = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + h2(r) + h2(g) + h2(b);
  }
  function relLuminance(hex) {
    const [r, g, b] = hexToRgbArr(hex);
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrastRatio(l1, l2) {
    const a = Math.max(l1, l2), b = Math.min(l1, l2);
    return (a + 0.05) / (b + 0.05);
  }
  function onColorFor(hex) {
    const L = relLuminance(hex);
    return contrastRatio(L, 1) >= contrastRatio(L, 0) ? '#ffffff' : '#16161a';
  }
  function normalizeBrand(hex, dark) {
    let [h, s, l] = rgbToHsl.apply(null, hexToRgbArr(hex));
    s = Math.min(88, Math.max(46, s));      // 泥色/灰调壁纸抬彩度
    l = dark ? Math.min(72, Math.max(58, l))
             : Math.min(50, Math.max(40, l));
    return { h: h, s: s, l: l, hex: hslToHex(h, s, l) };
  }

  // ── M3 角色色派生（移植参考 deriveVars；角色槽固定 primary，QQ 气泡角色不搬） ──
  const SURFACE_TONES = {
    light: { appBg: 98, low: 96, mid: 94, high: 92, highest: 90 },
    dark: { appBg: 6, low: 10, mid: 12, high: 17, highest: 22 }
  };
  const SCRIM = { low: 0.05, mid: 0.08, high: 0.11, highest: 0.14 };

  function deriveVars(mcu, theme, dark) {
    const s = dark ? theme.schemes.dark : theme.schemes.light;
    const tp = theme.palettes.primary;
    const neutral = theme.palettes.neutral;
    const nv = theme.palettes.neutralVariant;
    const st = SURFACE_TONES[dark ? 'dark' : 'light'];
    const sc = t => mcu.hexFromArgb(neutral.tone(t));
    const primary = mcu.hexFromArgb(s.primary);
    // 强调色归一化：色相跟壁纸，彩度/明度钳进可读区间，字色按对比度选黑或白
    const brand = normalizeBrand(primary, dark);
    const onBrand = onColorFor(brand.hex);
    const brandHover = hslToHex(brand.h, brand.s, dark ? Math.min(80, brand.l + 6) : Math.max(28, brand.l - 6));
    const brandPressed = hslToHex(brand.h, brand.s, dark ? Math.min(86, brand.l + 10) : Math.max(24, brand.l - 11));
    const onPrimary = mcu.hexFromArgb(s.onPrimary);
    const cLow = sc(st.low), cMid = sc(st.mid), cHigh = sc(st.high), cHighest = sc(st.highest);
    const glass2 = mcu.hexFromArgb(s.onSurfaceVariant);
    return {
      '--ll-brand': brand.hex,
      '--ll-brand-rgb': rgbTriplet(brand.hex),
      '--ll-brand-hover': brandHover,
      '--ll-brand-pressed': brandPressed,
      '--ll-brand-tint': mcu.hexFromArgb(tp.tone(dark ? 24 : 90)),
      '--ll-brand-weak': mcu.hexFromArgb(tp.tone(dark ? 32 : 88)),
      '--ll-brand-line': mcu.hexFromArgb(tp.tone(dark ? 48 : 60)),
      '--ll-on-brand': onBrand,
      '--ll-on-brand-rgb': rgbTriplet(onBrand),
      '--ll-secondary': mcu.hexFromArgb(s.secondary),
      '--ll-tertiary': mcu.hexFromArgb(s.tertiary),
      '--ll-on-glass': mcu.hexFromArgb(s.onSurface),
      '--ll-on-glass-rgb': rgbTriplet(mcu.hexFromArgb(s.onSurface)),
      '--ll-on-glass-2': glass2,
      '--ll-on-glass-2-rgb': rgbTriplet(glass2),
      '--ll-on-glass-3': mcu.hexFromArgb(nv.tone(dark ? 66 : 40)),
      '--ll-on-glass-4': mcu.hexFromArgb(s.outlineVariant),
      '--ll-app-bg': sc(st.appBg),
      '--ll-surface-low': cLow,
      '--ll-surface-mid': cMid,
      '--ll-surface-high': cHigh,
      '--ll-surface-highest': cHighest,
      '--ll-surface-1': alphaComposite(primary, cLow, SCRIM.low),
      '--ll-surface-2': alphaComposite(primary, cMid, SCRIM.mid),
      '--ll-surface-3': alphaComposite(primary, cHigh, SCRIM.high),
      '--ll-surface-4': alphaComposite(primary, cHighest, SCRIM.highest),
      '--ll-acrylic': rgbTriplet(alphaComposite(primary, cMid, SCRIM.mid)),
      '--ll-acrylic-low': rgbTriplet(alphaComposite(primary, cLow, SCRIM.low)),
      '--ll-acrylic-high': rgbTriplet(alphaComposite(primary, cHighest, SCRIM.highest)),
      '--ll-stroke-1': mcu.hexFromArgb(s.outline),
      '--ll-stroke-2': mcu.hexFromArgb(s.outlineVariant),
      '--ll-stroke-3': mcu.hexFromArgb(nv.tone(dark ? 40 : 80)),
      '--ll-primary-container': mcu.hexFromArgb(s.primaryContainer),
      '--ll-on-primary-container': mcu.hexFromArgb(s.onPrimaryContainer),
      '--ll-popup-bg': dark ? sc(st.high) : sc(st.highest),
      '--ll-veil-white-rgb': rgbTriplet(sc(98)),
      '--ll-veil-black-rgb': '0, 0, 0',
      '--ll-halo-rgb': rgbTriplet(sc(98)),
      '--ll-shadow-rgb': dark ? '0, 0, 0' : rgbTriplet(sc(10)),
      '--ll-danger': mcu.hexFromArgb(s.error),
      '--ll-danger-rgb': rgbTriplet(mcu.hexFromArgb(s.error)),
      '--ll-danger-bg': mcu.hexFromArgb(s.errorContainer),
      '--ll-on-danger': mcu.hexFromArgb(s.onError),
      '--ll-success': mcu.hexFromArgb(s.tertiary),
      '--ll-warn': mcu.hexFromArgb(dark ? s.tertiaryContainer : s.tertiary)
    };
  }

  // ── 壁纸层：body 内一个 fixed 铺满层，z-index 最底，不拦截事件 ──
  function ensureWallpaperEl() {
    if (wpEl) return wpEl;
    wpEl = document.createElement('div');
    wpEl.id = 'liuli-wallpaper';
    wpEl.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(wpEl, document.body.firstChild);
    return wpEl;
  }
  function toFileUrl(path) {
    const raw = String(path || '').replace(/\\/g, '/');
    return raw.startsWith('file://') ? raw : ('file:///' + raw);
  }
  function fitCss(fit) {
    if (fit === 'contain') return { size: 'contain', position: 'center' };
    if (fit === 'stretch') return { size: '100% 100%', position: 'center' };
    return { size: 'cover', position: 'center' };
  }

  // 按 wpMeta 重画壁纸层（遮罩/模糊变化时只重画不重新加载图片）
  function paintWallpaper(el) {
    const veil = 'var(--ll-veil-rgb, ' + (isDark() ? '0, 0, 0' : '255, 255, 255') + ')';
    const dimVal = (wpMeta.dim == null) ? autoVeil() : wpMeta.dim;
    const blurPx = (wpMeta.blur == null) ? DEFAULT_PARAMS.blur : wpMeta.blur;
    const overlay = 'linear-gradient(rgba(' + veil + ', ' + dimVal + '),' +
      'rgba(' + veil + ', ' + dimVal + '))';
    el.style.backgroundImage = overlay + ', url("' + wpMeta.url + '")';
    // 壁纸只做氛围底：轻模糊把硬边条纹/色块打散，否则竖条与界面矩形结构混在一起，
    // 半透明面板透上来容易被误认为渲染错位。scale 稍放大盖住模糊边缘的透明带。
    el.style.filter = 'blur(' + blurPx + 'px)';
    el.style.transform = 'scale(1.06)';
  }

  async function applyWallpaper(on) {
    const el = ensureWallpaperEl();
    const wp = (cfg && cfg.wallpaper) || {};
    const p = currentParams();
    if (!on || !wp.path) {
      wpMeta = { url: '', dim: p.veil, blur: p.blur };
      el.style.backgroundImage = 'none';
      el.style.display = 'none';
      return;
    }
    const url = toFileUrl(wp.path);
    const probe = new Image();
    const gen = ++wpGeneration;
    await new Promise((resolve) => {
      probe.onload = () => {
        if (gen !== wpGeneration) return resolve();
        const f = fitCss(wp.fit);
        wpMeta = { url: url, dim: p.veil, blur: p.blur };
        el.style.display = 'block';
        el.style.backgroundSize = f.size;
        el.style.backgroundPosition = f.position;
        el.style.backgroundRepeat = 'no-repeat';
        paintWallpaper(el);
        resolve();
      };
      probe.onerror = () => {
        if (cfg) { cfg.wallpaper.path = ''; }
        wpMeta = { url: '', dim: p.veil, blur: p.blur };
        el.style.backgroundImage = 'none';
        el.style.display = 'none';
        resolve();
      };
      probe.src = url;
    });
  }

  // ── 配色：手动覆盖优先；否则从壁纸取色经 MCU 派生整套角色色 ──
  const LL_VAR_KEYS = [
    '--ll-brand', '--ll-brand-rgb', '--ll-brand-hover', '--ll-brand-pressed', '--ll-brand-tint',
    '--ll-brand-weak', '--ll-brand-line', '--ll-on-brand', '--ll-on-brand-rgb', '--ll-secondary',
    '--ll-tertiary', '--ll-on-glass', '--ll-on-glass-rgb', '--ll-on-glass-2', '--ll-on-glass-2-rgb',
    '--ll-on-glass-3', '--ll-on-glass-4', '--ll-app-bg', '--ll-surface-low', '--ll-surface-mid',
    '--ll-surface-high', '--ll-surface-highest', '--ll-surface-1', '--ll-surface-2', '--ll-surface-3',
    '--ll-surface-4', '--ll-acrylic', '--ll-acrylic-low', '--ll-acrylic-high', '--ll-stroke-1',
    '--ll-stroke-2', '--ll-stroke-3', '--ll-primary-container', '--ll-on-primary-container',
    '--ll-popup-bg', '--ll-veil-white-rgb', '--ll-veil-black-rgb', '--ll-halo-rgb', '--ll-shadow-rgb',
    '--ll-danger', '--ll-danger-rgb', '--ll-danger-bg', '--ll-on-danger', '--ll-success', '--ll-warn'
  ];
  function clearPaletteVars(body) {
    LL_VAR_KEYS.forEach(k => body.style.removeProperty(k));
    ['--accent', '--accent-hover', '--liuli-accent-rgb'].forEach(k => body.style.removeProperty(k));
    delete body.dataset.liuliSource;
  }

  async function applyPalette(on) {
    const body = document.body;
    if (!on) { clearPaletteVars(body); return; }
    const gen = ++paletteGeneration;
    const mcu = window.LiuliMCU;
    const manual = normalizeHex(cfg && cfg.accentOverride);
    let source = DEFAULT_SOURCE;

    if (manual) {
      source = manual;
    } else {
      source = await extractSource();
      if (gen !== paletteGeneration) return;
    }

    if (!mcu) { clearPaletteVars(body); return; }
    let theme;
    try {
      theme = mcu.themeFromSourceColor(mcu.argbFromHex(source));
    } catch (e) { clearPaletteVars(body); return; }

    let vars;
    try { vars = deriveVars(mcu, theme, isDark()); }
    catch (e) { clearPaletteVars(body); return; }
    if (gen !== paletteGeneration) return;

    for (const k in vars) body.style.setProperty(k, vars[k]);
    // 映射到启动器现有变量，现有页面选择器无需改动
    body.style.setProperty('--accent', vars['--ll-brand']);
    body.style.setProperty('--accent-hover', vars['--ll-brand-hover']);
    body.style.setProperty('--liuli-accent-rgb', vars['--ll-brand-rgb']);
    body.dataset.liuliSource = source;
  }

  // ── 琉璃材质参数：写入 body 上的 CSS 变量，由 styles.css 消费 ──
  function applyMaterialVars(on) {
    const body = document.body;
    document.documentElement.classList.toggle('glass-liuli', on);
    body.classList.toggle('glass-liuli', on);
    if (!on) {
      ['--liuli-opacity', '--liuli-dim', '--liuli-glow', '--liuli-shadow',
        '--ll-wallpaper-dim', '--ll-veil-rgb', '--ll-shadow', '--ll-shadow-float'
      ].forEach(k => body.style.removeProperty(k));
      return;
    }
    // 材质参数从配置读（设置页可调），未保存过的维度用默认值
    const dark = isDark();
    const p = currentParams();
    const s = 0.6;
    const k = dark ? 1 : 0.6;
    body.style.setProperty('--liuli-opacity', String(p.opacity));
    body.style.setProperty('--liuli-dim', '0.18');
    body.style.setProperty('--liuli-glow', String(p.glow));
    body.style.setProperty('--liuli-shadow', '0.6');
    body.style.setProperty('--ll-wallpaper-dim', '0.18');
    body.style.setProperty('--ll-veil-rgb', dark ? '0, 0, 0' : '255, 255, 255');
    body.style.setProperty('--ll-shadow', '0 2px 10px rgba(var(--ll-shadow-rgb), ' + (s * 0.4 * k).toFixed(2) + ')');
    body.style.setProperty('--ll-shadow-float', '0 8px 28px rgba(var(--ll-shadow-rgb), ' + (s * 0.47 * k).toFixed(2) + ')');
  }

  // 设置页滑块实时生效：只改材质参数并重画壁纸遮罩，不重跑取色，避免拖动时闪烁
  function applyParams(patch) {
    const cur = currentParams();
    const next = Object.assign({}, cur, patch);
    if (cfg) cfg.liuliParams = next;
    const body = document.body;
    body.style.setProperty('--liuli-opacity', String(next.opacity));
    body.style.setProperty('--liuli-glow', String(next.glow));
    wpMeta.dim = next.veil;
    wpMeta.blur = next.blur;
    if (wpEl && wpEl.style.display === 'block' && wpMeta.url) paintWallpaper(wpEl);
  }

  async function apply() {
    const on = liuliOn();
    try { applyMaterialVars(on); } catch (e) {}
    try { await applyWallpaper(on); } catch (e) {}
    try { await applyPalette(on); } catch (e) {}
  }

  window.LiuliTheme = {
    setCfg(c) { cfg = c; },
    apply,
    applyParams,
    currentParams,
    isLiuli: liuliOn
  };
})();
