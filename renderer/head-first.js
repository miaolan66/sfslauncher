// 首帧防闪 / 毛玻璃无缝重建遮罩 —— 确定性最早执行点。
// 作为 <head> 中第一个、且位于样式表之前的外部同步脚本加载：
// 解析到此处时 <html> 元素必然已创建，而首次样式计算/绘制尚未发生，
// 同步取回初始主题/玻璃/材质并写到 documentElement，保证第一帧就是目标外观，
// 不依赖 preload(document-start 时 documentElement 可能为 null) 或 MutationObserver 的不确定时机。
(function () {
  try {
    window.__BOOTR = {}; window.__bt = function (k) { try { window.__BOOTR[k] = Math.round(performance.now()); } catch (e) {} }; window.__bt('head_first');
    var L = window.launcher;
    var ini = (L && L.glassInitialSync) ? L.glassInitialSync() : null;
    if (!ini) return;
    var root = document.documentElement;
    if (!root) return;

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

    // 无缝重建：首帧盖整窗不透明遮罩（主题实色），主进程确认旧窗销毁后通知淡出溶入目标材质。
    if (ini.transition === true) {
      root.classList.add('glass-mask-on');
      if (L && L.onGlassTransitionFade) {
        L.onGlassTransitionFade(function () {
          try {
            root.classList.add('glass-mask-fade');
            setTimeout(function () { root.classList.remove('glass-mask-on', 'glass-mask-fade'); }, 340);
          } catch (e) {}
        });
      }
    }

    var syncBody = function () {
      if (!document.body) return;
      document.body.classList.toggle('glass', ini.enabled === true);
      if (mat) document.body.classList.add(mat);
    };
    if (document.body) syncBody();
    else document.addEventListener('DOMContentLoaded', syncBody, { once: true });
  } catch (e) {}
})();
