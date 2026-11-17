'use strict';

// 首帧后空闲分片任务队列。
// 磁盘扫描、exe 图标提取、长列表渲染等重活推迟到窗口首帧绘制之后，逐项让出主线程，
// 避免冷启动或开启毛玻璃重建窗口时同步扫描阻塞首帧，造成整窗卡顿 / 未响应。
(function () {
  const ric = typeof window.requestIdleCallback === 'function'
    ? (fn) => window.requestIdleCallback(fn, { timeout: 200 })
    : (fn) => window.setTimeout(() => fn({ didTimeout: true }), 0);
  const tick = () => new Promise((res) => ric(() => res()));
  const afterPaint = () => new Promise((res) =>
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => window.setTimeout(res, 50))));

  window.IdleTasks = {
    afterPaint,
    // 顺序执行任务；每项之间把主线程让回给合成与输入，保证动画、滚动、点击不掉帧。
    async run(tasks, opts) {
      const waitFirstPaint = !opts || opts.waitFirstPaint !== false;
      if (waitFirstPaint) {
        try { await afterPaint(); } catch (e) { await new Promise((r) => setTimeout(r, 90)); }
      }
      for (const t of tasks) {
        try { await t(); } catch (e) { console.warn('idle task failed:', e); }
        await tick();
      }
    }
  };
})();
