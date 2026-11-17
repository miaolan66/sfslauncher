/* virt-mods.js — 模组「已安装」长列表虚拟滚动（窗口化渲染）
 *
 * 只把可视区 + overscan 内的少量单元放进 DOM，前后用占位元素撑出完整滚动高度，
 * 弱 GPU 不必为几百行长期维护图层与首次光栅化，滚动只复用视口内那一屏内容。
 *
 * 设计要点：
 *  - 不使用 transform 定位（.mod-item 被「防文字糊」规则强制 transform:none），
 *    可见单元夹在两个占位元素之间走正常文档流，展开动画由原生布局自然推动。
 *  - 选中 / 展开状态保存在数据层（Set），单元滚出视口被回收后状态不丢失。
 *  - 单元高度以真实 DOM 测量为准并回填；展开动画期间用 rAF 实测高度同步占位，
 *    总高恒定为终态，滚动条不跳动。
 *  - 蓝图树是不定高嵌套结构，不做虚拟化（仍由 renderBlueprintTree 全量渲染）。
 */
(function () {
  'use strict';

  const OVERSCAN = 900;   // 视口上下额外渲染像素：缓冲约 12 行，单次掉帧也不越界触发全量重建
  const ANIM_MS = 240;    // 展开/收起高度同步时长，略大于 CSS 的 .16s
  const EST_ITEM = 52;    // 折叠单元行高初估，首帧后用实测校正
  const EST_ROW = 26;     // 单个文件行高初估，首帧后用实测校正
  const UNIT_GAP = 8;     // .virt-unit 底部间距
  const FILES_EXTRA = 20; // 展开 files 区固定增量：margin-top 4 + padding 上下 16

  const V = {
    items: [], heights: [], prefix: [], total: 0,
    itemH: EST_ITEM, rowH: EST_ROW, calibrated: false,
    expanded: new Set(), selected: new Set(), animating: new Set(),
    start: -1, end: -1, fullMode: false, rafScroll: 0, rafAnim: 0, listTop: 0,
    sc: null, box: null, top: null, view: null, bot: null, bound: false,

    setData(items) {
      this.items = Array.isArray(items) ? items : [];
      this.expanded = new Set();
      this.selected = new Set();
      this.animating = new Set();
      this.start = -1; this.end = -1; this.calibrated = false;
      this.box = document.getElementById('installed-list');
      this.sc = document.getElementById('view-mods');
      if (!this.box) return;

      // 两种模式统一走全量原生 + content-visibility：停用滚动时 JS 增删 DOM 与强制回流，消除材质闪烁。
      // 玻璃开关只会销毁重建窗口并 reload；全量渲染对两种外观一视同仁。
      this.fullMode = true;

      if (!this.items.length) {
        this.box.classList.remove('virt');
        this.box.classList.remove('full');
        this.box.innerHTML =
          '<div class="empty-tip"><div>尚未安装模组</div>' +
          '<div class="empty-sub">通过上方按钮导入本地文件，或在模组商店下载后导入</div></div>';
        this.bindEmptyClick();
        return;
      }
      this.bindEmptyClick();

      if (this.fullMode) { this.renderFull(); return; }

      this.box.classList.add('virt');
      if (!this.box.querySelector('.virt-view')) {
        this.box.innerHTML =
          '<div class="virt-top"></div><div class="virt-view"></div><div class="virt-bot"></div>';
        this.top = this.box.querySelector('.virt-top');
        this.view = this.box.querySelector('.virt-view');
        this.bot = this.box.querySelector('.virt-bot');
        this.bindOnce();
      }
      this.itemH = EST_ITEM; this.rowH = EST_ROW;
      this.estimateHeights();
      this.refresh(true);
    },

    // 毛玻璃（弱 GPU 分层透明窗）：全量渲染 + 浏览器原生 content-visibility 屏外跳过。
    // 真机帧率对照：手写窗口化每帧的区间计算 / DOM 增删 / offsetHeight 同步测量 / spacer 回流，
    // 在透明 RGBA 表面上比原生 content-visibility 更慢；普通不透明窗仍走虚拟渲染。
    // 事件仍复用 bindUnit；展开/收起在全量下交给 CSS grid 动画，无需 JS 高度同步。
    renderFull() {
      const box = this.box;
      box.classList.remove('virt');
      box.classList.add('full');
      box.innerHTML = this.items.map((m, i) => this.unitHtml(i, m)).join('');
      box.querySelectorAll('.virt-unit').forEach((u) => this.bindUnit(u));
      this.bindBlankDeselect();
    },

    // ---- 高度模型 ----
    estimateHeights() {
      this.heights = this.items.map((m, i) => this.unitEstimate(i, m));
      this.rebuildPrefix();
    },
    unitEstimate(i, m) {
      let h = this.itemH + UNIT_GAP;
      if (this.expanded.has(i)) h += FILES_EXTRA + (m.files || []).length * this.rowH;
      return h;
    },
    rebuildPrefix() {
      const p = [0]; let acc = 0;
      for (const h of this.heights) { acc += h; p.push(acc); }
      this.prefix = p; this.total = acc;
    },
    measureVisible() {
      this.view.querySelectorAll('.virt-unit').forEach((u) => {
        const idx = Number(u.dataset.unit);
        if (!this.animating.has(idx) && u.offsetHeight > 0) this.heights[idx] = u.offsetHeight;
      });
      this.rebuildPrefix();
    },
    // 首屏渲染后用真实行高校正，消除估算误差
    calibrate() {
      const firstItem = this.view.querySelector('.mod-item');
      const firstRow = this.view.querySelector('.mod-file-row');
      if (firstItem && firstItem.offsetHeight > 0) this.itemH = firstItem.offsetHeight;
      if (firstRow && firstRow.offsetHeight > 0) this.rowH = firstRow.offsetHeight;
      this.estimateHeights();
      this.measureVisible();
      this.calibrated = true;
      this.refresh(true);
    },

    // ---- 可视区间 ----
    range() {
      const sc = this.sc;
      const rb = this.box.getBoundingClientRect(), rs = sc.getBoundingClientRect();
      this.listTop = rb.top - rs.top + sc.scrollTop - (sc.clientTop || 0);
      const relTop = sc.scrollTop - this.listTop;
      const relBot = relTop + sc.clientHeight;
      let s = 0, e = this.items.length - 1, acc = 0;
      for (let i = 0; i < this.items.length; i++) {
        const h = this.heights[i];
        if (acc + h < relTop - OVERSCAN) s = i + 1;
        if (acc < relBot + OVERSCAN) e = i;
        acc += h;
      }
      return [Math.max(0, s), Math.min(this.items.length - 1, e)];
    },

    refresh(force) {
      if (this.fullMode) return; // 全量模式 DOM 常驻，屏外由 content-visibility 原生处理
      if (!this.sc || !this.view || !this.items.length) return;
      if (this.sc.clientHeight === 0) return; // 页面隐藏（display:none）
      const probe = this.view.querySelector('.mod-item');
      if (!this.calibrated && probe && probe.offsetHeight > 0) { this.calibrate(); return; }
      const [s, e] = this.range();
      if (force || s !== this.start || e !== this.end) {
        this.start = s; this.end = e;
        this.renderRange(s, e);
      }
      this.syncSpacers();
    },

    renderRange(s, e) {
      const oldS = this.start, oldE = this.end;
      const cur = [...this.view.children];
      // 仅当新区间与旧区间重叠或紧邻时做增量增删，保留交集单元 DOM（复用光栅缓存）；
      // 首次渲染或大范围跳滚时退化为全量重建。
      const canDelta = oldS >= 0 && cur.length && s <= oldE + 1 && e >= oldS - 1;
      if (canDelta) {
        const have = new Set(cur.map((u) => Number(u.dataset.unit)));
        cur.forEach((u) => { const i = Number(u.dataset.unit); if (i < s || i > e) u.remove(); });
        for (let i = s; i <= e; i++) if (!have.has(i)) this.insertUnit(i);
        this.start = s; this.end = e;
        this.measureNew(have);
      } else {
        let html = '';
        for (let i = s; i <= e; i++) html += this.unitHtml(i, this.items[i]);
        this.view.innerHTML = html;
        this.view.querySelectorAll('.virt-unit').forEach((u) => this.bindUnit(u));
        this.start = s; this.end = e;
        this.measureVisible();
      }
      if (!this.calibrated && this.sc.clientHeight > 0) {
        requestAnimationFrame(() => { if (!this.calibrated) this.calibrate(); });
      }
    },
    insertUnit(i) {
      const tmp = document.createElement('div');
      tmp.innerHTML = this.unitHtml(i, this.items[i]).trim();
      const node = tmp.firstChild;
      this.bindUnit(node);
      let placed = false;
      for (const c of this.view.children) {
        if (Number(c.dataset.unit) > i) { this.view.insertBefore(node, c); placed = true; break; }
      }
      if (!placed) this.view.appendChild(node);
    },
    measureNew(have) {
      this.view.querySelectorAll('.virt-unit').forEach((u) => {
        const idx = Number(u.dataset.unit);
        if (!have.has(idx) && !this.animating.has(idx) && u.offsetHeight > 0) this.heights[idx] = u.offsetHeight;
      });
      this.rebuildPrefix();
    },

    // 总高恒定为终态：底部占位 = 总高 - 顶部占位 - 可见区实时高度。
    // 展开动画中可见区高度逐帧变化，底部占位随之增减，滚动条不跳。
    syncSpacers() {
      const s = this.start;
      this.top.style.height = this.prefix[s] + 'px';
      const bot = this.total - this.prefix[s] - this.view.offsetHeight;
      this.bot.style.height = Math.max(0, bot) + 'px';
    },

    // ---- 单元 HTML（结构与原全量渲染保持一致）----
    unitHtml(idx, m) {
      const files = m.files || [];
      const open = this.expanded.has(idx);
      const expandBtn = files.length > 0
        ? '<button class="btn small ghost expand-btn" data-expand="' + idx +
          '" title="展开文件列表"><span class="chevron' + (open ? ' up' : '') + '"></span></button>'
        : '';
      // 折叠态不渲染文件行（可能有数百行），展开时才惰性注入，避免窗口重建创建大量节点
      const rows = open ? files.map((f) =>
        '<div class="mod-file-row"><span class="mod-file-name">' + esc(f) + '</span>' +
        '<button class="btn small ghost" data-fopen="' + idx + '" data-file="' + esc(f) +
        '">打开位置</button></div>').join('') : '';
      return '<div class="virt-unit" data-unit="' + idx + '">' +
        '<div class="mod-item">' +
        '<input type="checkbox" class="mod-check" data-check="' + idx + '"' +
        (this.selected.has(idx) ? ' checked' : '') + ' />' +
        '<span class="mod-type ' + esc(m.type) + '">' + (TYPE_LABEL[m.type] || m.type) + '</span>' +
        '<span class="mod-name">' + esc(m.name) + '</span>' +
        '<span class="mod-meta">' + m.count + ' 个文件</span>' +
        expandBtn +
        '<button class="btn small ghost" data-export="' + idx + '">导出</button>' +
        '<button class="btn small ghost" data-locate="' + idx + '">打开位置</button>' +
        '<button class="btn small danger" data-rminstalled="' + idx + '">删除</button>' +
        '</div>' +
        '<div class="mod-files ' + (open ? '' : 'hidden') + '" id="mod-files-' + idx + '">' +
        '<div class="mod-files-inner">' + rows + '</div></div>' +
        '</div>';
    },

    bindUnit(u) {
      const idx = Number(u.dataset.unit);
      const m = this.items[idx];
      const row = u.querySelector('.mod-item');
      const box = u.querySelector('.mod-files');
      const tri = row.querySelector('[data-expand]');

      // 首次展开时才把文件行注入 DOM 并绑定「打开位置」
      const fillFiles = () => {
        const inner = box.querySelector('.mod-files-inner');
        if (!inner || inner.children.length) return;
        inner.innerHTML = (m.files || []).map((f) =>
          '<div class="mod-file-row"><span class="mod-file-name">' + esc(f) + '</span>' +
          '<button class="btn small ghost" data-fopen="' + idx + '" data-file="' + esc(f) +
          '">打开位置</button></div>').join('');
        inner.querySelectorAll('[data-fopen]').forEach((b) =>
          b.addEventListener('click', () => window.launcher.modShowInFolder(b.dataset.file)));
      };
      const toggle = () => {
        const willOpen = !this.expanded.has(idx);
        if (willOpen) { this.expanded.add(idx); fillFiles(); } else this.expanded.delete(idx);
        box.classList.toggle('hidden', !willOpen);
        const ch = tri && tri.querySelector('.chevron');
        if (ch) ch.classList.toggle('up', willOpen);
        if (!this.fullMode) this.beginAnim(idx); // 全量无 spacer，高度由 CSS grid 动画原生处理
      };
      if (tri) {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          if (this._dragJustEnded) { this._dragJustEnded = false; return; } // 拖动区间选择后不展开
          toggle();
        });
        tri.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      }

      const ck = u.querySelector('.mod-check');
      if (ck) {
        ck.addEventListener('click', (e) => e.stopPropagation());
        ck.addEventListener('change', () => {
          if (ck.checked) this.selected.add(idx); else this.selected.delete(idx);
          this.syncChecks();
          if (typeof updateBatchBar === 'function') updateBatchBar();
        });
      }

      // 左键拖动区间多选（类文件管理器）：起点未选中=拖过的全部加选；起点已选中=拖过的全部取消。
      // 短按（未拖动）仍走展开/收起。
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button') || e.target.closest('.mod-check')) return;
        const startY = e.clientY;
        const startIdx = idx;
        const removeMode = this.selected.has(idx); // 起点已选中 → 本次拖动是取消
        let dragging = false;
        const onMove = (ev) => {
          if (!dragging && Math.abs(ev.clientY - startY) < 8) return;
          if (!dragging) dragging = true;
          ev.preventDefault();
          const cur = this.idxAtY(ev.clientY);
          if (cur == null) return;
          const [a, b] = startIdx < cur ? [startIdx, cur] : [cur, startIdx];
          for (let i = a; i <= b; i++) {
            if (removeMode) this.selected.delete(i); else this.selected.add(i);
          }
          this.syncChecks();
          if (typeof updateBatchBar === 'function') updateBatchBar();
        };
        const onUp = () => {
          if (dragging) this._dragJustEnded = true; // 抑制拖动后的那次 click 触发展开
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      const rm = u.querySelector('[data-rminstalled]');
      if (rm) rm.addEventListener('click', async () => {
        await window.launcher.modRemoveInstalled(idx);
        toast('已删除模组及其文件');
        renderMods();
      });
      const loc = u.querySelector('[data-locate]');
      if (loc) loc.addEventListener('click', async () => {
        const m = this.items[idx];
        const target = (m.files && m.files[0]) || m.target;
        if (target) await window.launcher.modShowInFolder(target);
      });
      const ex = u.querySelector('[data-export]');
      if (ex) ex.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await window.launcher.modExport(idx);
        if (r && r.canceled) return;
        toast(r.success ? ('已导出到：' + r.path) : ('导出失败：' + (r.error || '')));
      });
      u.querySelectorAll('[data-fopen]').forEach((b) =>
        b.addEventListener('click', () => window.launcher.modShowInFolder(b.dataset.file)));
    },

    // ---- 展开/收起动画高度同步 ----
    beginAnim(idx) {
      const u0 = this.view.querySelector('[data-unit="' + idx + '"]');
      const fr = u0 && u0.querySelector('.mod-file-row');
      if (fr && fr.offsetHeight > 0) this.rowH = fr.offsetHeight;
      if (this.items[idx]) {
        this.heights[idx] = this.unitEstimate(idx, this.items[idx]);
        this.rebuildPrefix();
      }
      this.animating.add(idx);
      if (!this.rafAnim) {
        const tick = () => {
          this.animating.forEach((i) => {
            const u = this.view.querySelector('[data-unit="' + i + '"]');
            if (u && u.offsetHeight > 0) this.heights[i] = u.offsetHeight;
          });
          this.rebuildPrefix();
          this.syncSpacers();
          this.rafAnim = this.animating.size ? requestAnimationFrame(tick) : 0;
        };
        this.rafAnim = requestAnimationFrame(tick);
      }
      setTimeout(() => {
        this.animating.delete(idx);
        const u = this.view.querySelector('[data-unit="' + idx + '"]');
        if (u && u.offsetHeight > 0) this.heights[idx] = u.offsetHeight;
        this.rebuildPrefix();
        if (this.animating.size === 0) { this.rafAnim = 0; this.refresh(true); }
      }, ANIM_MS);
    },

    // 把所有可见 checkbox 的勾选状态同步到数据层 selected（修「最后选的没打勾」）
    syncChecks() {
      if (!this.box) return;
      this.box.querySelectorAll('.mod-check').forEach((ck) => {
        const idx = Number(ck.dataset.check);
        ck.checked = this.selected.has(idx);
      });
    },
    // 点列表空白处清空全部多选
    bindBlankDeselect() {
      if (!this.box || this.box._blankBound) return;
      this.box._blankBound = true;
      this.box.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.virt-unit')) return; // 点在行上不管
        if (!this.selected.size) return;
        this.selected.clear();
        this.syncChecks();
        if (typeof updateBatchBar === 'function') updateBatchBar();
      });
    },
    // 根据客户端 Y 坐标反推单元索引（全量模式遍历可见 .virt-unit 求命中）
    idxAtY(y) {
      if (!this.box) return null;
      const units = this.box.querySelectorAll('.virt-unit');
      for (const u of units) {
        const r = u.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) return Number(u.dataset.unit);
      }
      // 超出可视区：夹到最近的首/尾可见单元
      let best = null, bestD = Infinity;
      for (const u of units) {
        const r = u.getBoundingClientRect();
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < bestD) { bestD = d; best = Number(u.dataset.unit); }
      }
      return best;
    },

    // 点列表空白处（非行内）清空所有勾选
    bindEmptyClick() {
      if (!this.box || this.box._emptyBound) return;
      this.box._emptyBound = true;
      this.box.addEventListener('mousedown', (e) => {
        if (e.target.closest('.virt-unit')) return; // 点在行上不管
        if (this.selected.size) {
          this.selected.clear();
          this.syncChecks();
          if (typeof updateBatchBar === 'function') updateBatchBar();
        }
      });
    },

    bindOnce() {
      if (this.bound) return;
      this.bound = true;
      this.sc.addEventListener('scroll', () => {
        if (this.rafScroll) return;
        this.rafScroll = requestAnimationFrame(() => { this.rafScroll = 0; this.refresh(false); });
      }, { passive: true });
      window.addEventListener('resize', () => this.refresh(false));
    }
  };

  window.VirtInstalled = V;
})();
