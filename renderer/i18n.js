/* ================================================================
 * SFS 启动器 - 多语言核心
 * 职责：注册字典、替换静态节点、给动态文案提供 t()
 * 约定：
 *   data-i18n       文本节点整段替换（该元素内不能有需要保留的子元素）
 *   data-i18n-ph    输入框 placeholder
 *   data-i18n-title 元素 title
 * 首次替换前缓存原文，字典缺 key 时回退原文，不会把界面清空。
 * ================================================================ */
(function () {
  var DICT = { zh: Object.create(null), en: Object.create(null) };
  var CUR = 'zh';
  var LISTENERS = [];

  window.LangLabel = { zh: '中文', en: 'English' };

  function register(lang, map) {
    if (!map || !DICT[lang]) return;
    for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) DICT[lang][k] = map[k]; }
  }
  window.I18NRegister = register;

  function fmt(s, vars) {
    if (!vars) return String(s);
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] == null ? m : String(vars[k]);
    });
  }

  // 当前语言优先，缺失回退中文
  function raw(key) {
    var a = DICT[CUR][key];
    if (a != null) return a;
    var b = DICT.zh[key];
    return b != null ? b : null;
  }

  window.t = function (key, vars) {
    var s = raw(key);
    return s == null ? key : fmt(s, vars);
  };

  function cacheAttr(el, attr, store) {
    if (!el.hasAttribute(store)) {
      el.setAttribute(store, el.getAttribute(attr) == null ? '' : el.getAttribute(attr));
    }
  }

  function applyNode(el) {
    var key = el.getAttribute('data-i18n');
    if (key) {
      if (!el.hasAttribute('data-i18n-src')) el.setAttribute('data-i18n-src', el.textContent);
      var v = raw(key);
      el.textContent = v != null ? fmt(v, {}) : (el.getAttribute('data-i18n-src') || '');
    }
    var hk = el.getAttribute('data-i18n-html');
    if (hk) {
      if (!el.hasAttribute('data-i18n-src')) el.setAttribute('data-i18n-src', el.innerHTML);
      var hv = raw(hk);
      el.innerHTML = hv != null ? fmt(hv, {}) : (el.getAttribute('data-i18n-src') || '');
    }
    var ph = el.getAttribute('data-i18n-ph');
    if (ph) {
      cacheAttr(el, 'placeholder', 'data-i18n-phsrc');
      var pv = raw(ph);
      el.setAttribute('placeholder', pv != null ? pv : (el.getAttribute('data-i18n-phsrc') || ''));
    }
    var ti = el.getAttribute('data-i18n-title');
    if (ti) {
      cacheAttr(el, 'title', 'data-i18n-titlesrc');
      var tv = raw(ti);
      el.setAttribute('title', tv != null ? tv : (el.getAttribute('data-i18n-titlesrc') || ''));
    }
  }

  function apply(root) {
    var base = root || document;
    var list = base.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-ph], [data-i18n-title]');
    for (var i = 0; i < list.length; i++) applyNode(list[i]);
    if (base.getAttribute && base.getAttribute('data-i18n')) applyNode(base);
  }
  window.applyI18n = apply;

  /* ---------- 运行时动态文案翻译 ----------
   * 页面里大量内容由 JS 拼字符串写入（列表、空态、toast、弹窗）。
   * 这些不走 data-i18n，改为按「中文原文 → 英文」映射整体替换文本节点。
   * 只匹配字典里存在的界面文案，用户数据（模组名、路径）原样保留。
   */
  // 有汉字才可能命中 SRC_EN/SRC_PAT；纯英文、数字、路径直接跳过。
  var HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  // 译文缓存：同一串（列表标签、筛选项、重复卡片）只算一次。
  var TCACHE = Object.create(null);
  var TCACHE_N = 0;
  var TCACHE_MAX = 8000;

  function trText(s) {
    if (CUR !== 'en' || !s) return s;
    var t = s.trim();
    if (!t) return s;

    var cached = TCACHE[s];
    if (cached !== undefined) return cached;

    var out = s;
    var exact = window.SRC_EN && window.SRC_EN[t];
    if (exact != null) out = s.replace(t, exact);
    else if (!HAN.test(t)) out = s; // 纯 ASCII 用户数据，不进正则
    else {
      var pats = window.SRC_PAT || [];
      for (var i = 0; i < pats.length; i++) {
        var src = pats[i][0], dst = pats[i][1], rep = null;
        if (src.test(t)) {
          // 单参数拼接串（如「导入失败：{详情}」）：详情先递归翻译，再拼回
          if (dst.indexOf('$2') < 0 && dst.indexOf('$1') >= 0) {
            var m1 = src.exec(t);
            if (m1 && m1[1] && m1[1].length < t.length) {
              var tail1 = trText(m1[1]);
              rep = t.replace(src, function () { return dst.replace('$1', function () { return tail1; }); });
            }
          }
          if (rep == null) rep = t.replace(src, dst);
          if (rep !== t) { out = s.replace(t, rep); break; }
        }
      }

      if (out === s) {
        var pres = window.SRC_PRE || [];
        for (var j = 0; j < pres.length; j++) {
          var mm = pres[j][0].exec(t);
          if (mm && mm[1] && mm[1].length < t.length) {
            var tail = trText(mm[1]);
            var full = t.replace(pres[j][0], function () { return pres[j][1] + tail; });
            if (full !== t) { out = s.replace(t, full); break; }
          }
        }
      }

      if (out === s) {
        var subs = window.SRC_SUB;
        if (subs) {
          for (var k in subs) {
            if (Object.prototype.hasOwnProperty.call(subs, k) && out.indexOf(k) >= 0) {
              out = out.split(k).join(subs[k]);
            }
          }
        }
      }
    }

    if (TCACHE_N >= TCACHE_MAX) { TCACHE = Object.create(null); TCACHE_N = 0; }
    TCACHE[s] = out;
    TCACHE_N++;
    return out;
  }

  function trNode(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      var v = trText(node.nodeValue);
      if (v !== node.nodeValue) node.nodeValue = v;
      return;
    }
    if (node.nodeType !== 1) return;
    // 自绘区域（商店卡片等）由各自渲染逻辑负责翻译，Observer 不再整棵重扫
    if (node.hasAttribute && node.hasAttribute('data-i18n-skip')) return;
    var walker = document.createTreeWalker(node, 1 | 4, { // ELEMENT_NODE | TEXT_NODE
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          // 返回 2（FILTER_REJECT）会连同整棵子树一起跳过，比逐个文本节点 closest() 便宜得多。
          if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE') return 2;
          if (n.hasAttribute && n.hasAttribute('data-i18n-skip')) return 2;
          return 1;
        }
        return 1;
      }
    });
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n.nodeType !== 3) continue;
      var nv = trText(n.nodeValue);
      if (nv !== n.nodeValue) n.nodeValue = nv;
    }
  }
  window.I18NTrText = trText;
  window.I18NTrDom = trNode;

  function startObserver() {
    if (window.__i18nObserver || !window.MutationObserver || !document.body) return;
    var queue = [];
    var scheduled = false;
    var flushing = false;
    function flush() {
      scheduled = false;
      var items = queue; queue = [];
      flushing = true;
      for (var i = 0; i < items.length; i++) trNode(items[i]);
      flushing = false;
    }
    var mo = new MutationObserver(function (muts) {
      if (CUR !== 'en' || flushing) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') queue.push(m.target);
        else if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]);
        }
      }
      if (!queue.length) return;
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__i18nObserver = mo;
  }

  function setLang(lang) {
    if (!DICT[lang]) return false;
    var changed = CUR !== lang;
    CUR = lang;
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.documentElement.setAttribute('data-lang', lang);
    apply(document);
    // 只翻当前可见页，避免每次切语言都重扫整棵 DOM（英文模式这一步原来要 200ms+）。
    // 其余页由 renderer 的 setAppLang 重绘或在进入页面时补翻。
    var active = document.querySelector('.view.active');
    if (lang === 'en' && active) trNode(active);
    startObserver();
    if (changed) {
      for (var i = 0; i < LISTENERS.length; i++) {
        try { LISTENERS[i](lang); } catch (e) { console.warn('i18n listener failed:', e); }
      }
    }
    return true;
  }
  window.I18NSetLang = setLang;
  window.I18NGetLang = function () { return CUR; };
  window.I18NOnChange = function (fn) { if (typeof fn === 'function') LISTENERS.push(fn); };
})();
