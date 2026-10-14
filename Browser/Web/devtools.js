/*
 * DevTools front-end. Runs in its own WKWebView and talks to the native side through
 * webkit.messageHandlers.native; the native side forwards page commands to the page agent
 * (inject.js) and streams page events back via DT.onPageEvents().
 */
(function () {
  'use strict';
  const DT = window.DT = {};

  // ================================================================== helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtMs(ms) {
    if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return '–';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }
  function shortUrl(u) {
    try {
      const x = new URL(u);
      if (x.protocol === 'data:') return u.slice(0, 40) + '…';
      const last = x.pathname.split('/').filter(Boolean).pop();
      return decodeURIComponent(last || x.host || u) + x.search;
    } catch (e) { return u; }
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }
  function originOf(u) { try { const x = new URL(u); return x.origin === 'null' ? x.protocol : x.origin; } catch (e) { return ''; } }
  function debounce(fn, ms) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  function timeStr(ts) {
    const d = new Date(ts);
    const p = (n, l) => String(n).padStart(l || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }
  function isColor(v) {
    try { return typeof CSS !== 'undefined' && CSS.supports('color', v) && !/^(inherit|initial|unset|currentcolor|transparent|revert)$/i.test(v); } catch (e) { return false; }
  }
  function errMsg(e) { return (e && e.message) ? e.message : String(e); }

  // ================================================================== settings & theme
  const Settings = {
    theme: 'auto', fontSize: 12, timestamps: false, logXhr: false, preserveConsole: false,
    preserveNetwork: false, groupSimilar: true, panel: 'elements', wrapSources: false
  };
  try { Object.assign(Settings, JSON.parse(localStorage.getItem('dt-settings') || '{}')); } catch (e) {}
  function saveSettings() { try { localStorage.setItem('dt-settings', JSON.stringify(Settings)); } catch (e) {} }
  const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    const dark = Settings.theme === 'dark' || (Settings.theme === 'auto' && (!darkMq || darkMq.matches));
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.style.setProperty('--fs', Settings.fontSize + 'px');
    native('theme', { dark }).catch(() => {});
  }
  if (darkMq) {
    if (darkMq.addEventListener) darkMq.addEventListener('change', applyTheme);
    else if (darkMq.addListener) darkMq.addListener(applyTheme);
  }

  // ================================================================== native bridge
  let reqSeq = 0;
  const pendingReq = new Map();
  function bridge() {
    try { return window.webkit.messageHandlers.native; } catch (e) { return null; }
  }
  function native(cmd, args) {
    return new Promise((resolve, reject) => {
      const b = bridge();
      if (!b) { reject(new Error('Native bridge unavailable')); return; }
      const id = ++reqSeq;
      pendingReq.set(id, { resolve, reject });
      try { b.postMessage({ id, cmd, args: args || {} }); } catch (e) { pendingReq.delete(id); reject(e); }
    });
  }
  DT.reply = function (id, res) {
    const p = pendingReq.get(id);
    if (!p) return;
    pendingReq.delete(id);
    if (res && res.e !== undefined) p.reject(new Error(res.e));
    else p.resolve(res ? res.v : undefined);
  };
  async function page(cmd, args) {
    const s = await native('page', { cmd, args: args || {} });
    if (typeof s !== 'string') return s;
    return JSON.parse(s);
  }
  function copyText(t) {
    native('copy', { text: String(t) }).then(() => toast('Copied to clipboard')).catch(e => toast(errMsg(e)));
  }

  // ================================================================== overlays
  let toastTimer = 0;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast' }); document.body.append(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function dialog(opts) {
    return new Promise(resolve => {
      const inputs = [];
      const box = h('div', { class: 'dlg' }, h('div', { class: 'dlg-title' }, opts.title || ''));
      if (opts.message) box.append(h('div', { class: 'dlg-msg' }, opts.message));
      if (opts.content) box.append(opts.content);
      for (const f of opts.fields || []) {
        const common = { class: 'dlg-input mono', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', placeholder: f.placeholder || '' };
        const inp = f.multiline ? h('textarea', Object.assign({ rows: f.rows || 8 }, common)) : h('input', Object.assign({ type: 'text' }, common));
        inp.value = f.value !== undefined && f.value !== null ? f.value : '';
        if (f.label) box.append(h('label', { class: 'dlg-label' }, f.label));
        box.append(inp);
        inputs.push(inp);
      }
      let back;
      const close = val => { back.remove(); resolve(val); };
      const buttons = h('div', { class: 'dlg-buttons' });
      if (opts.cancel !== false) buttons.append(h('button', { class: 'btn', onclick: () => close(null) }, opts.cancelText || 'Cancel'));
      const ok = h('button', { class: 'btn primary' + (opts.danger ? ' danger' : ''), onclick: () => close(inputs.map(i => i.value)) }, opts.okText || 'OK');
      buttons.append(ok);
      box.append(buttons);
      back = h('div', { class: 'dlg-back', onclick: e => { if (e.target === back) close(null); } }, box);
      box.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey)) { e.preventDefault(); ok.click(); }
      });
      $('#overlay-root').append(back);
      if (inputs[0]) setTimeout(() => { inputs[0].focus(); if (!opts.noSelect && inputs[0].select) inputs[0].select(); }, 40);
    });
  }
  async function confirmDialog(title, message, okText) {
    const r = await dialog({ title, message, okText: okText || 'OK', danger: true });
    return r !== null;
  }
  function popupMenu(items, x, y) {
    let back;
    const m = h('div', { class: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { m.append(h('div', { class: 'menu-sep' })); continue; }
      if (it.title) { m.append(h('div', { class: 'menu-title' }, it.title)); continue; }
      m.append(h('div', {
        class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
        onclick: e => { e.stopPropagation(); back.remove(); try { it.action(); } catch (err) { toast(errMsg(err)); } }
      }, it.label));
    }
    back = h('div', { class: 'menu-back', onclick: () => back.remove() }, m);
    $('#overlay-root').append(back);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  }
  function menuAt(el, items) {
    const r = el.getBoundingClientRect();
    popupMenu(items, r.left, r.bottom + 2);
  }
  function onLongPress(el, cb) {
    let timer = null, sx = 0, sy = 0, fired = false;
    el.addEventListener('touchstart', e => {
      fired = false;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      clearTimeout(timer);
      const target = e.target;
      timer = setTimeout(() => { fired = true; cb(target, sx, sy); }, 520);
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) clearTimeout(timer);
    }, { passive: true });
    el.addEventListener('touchend', e => { clearTimeout(timer); if (fired && e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener('touchcancel', () => clearTimeout(timer));
    el.addEventListener('contextmenu', e => { e.preventDefault(); cb(e.target, e.clientX, e.clientY); });
  }

  // ================================================================== remote object rendering
  function isExpandable(d) { return !!d && (d.t === 'object' || d.t === 'function') && d.id !== undefined && d.sub !== 'node'; }
  function inlineValue(d, opts) {
    opts = opts || {};
    if (!d) return h('span', { class: 'v-undef' }, 'undefined');
    switch (d.t) {
      case 'undefined': return h('span', { class: 'v-undef' }, 'undefined');
      case 'null': return h('span', { class: 'v-null' }, 'null');
      case 'number': case 'bigint': return h('span', { class: 'v-num' }, d.v);
      case 'boolean': return h('span', { class: 'v-bool' }, d.v);
      case 'symbol': return h('span', { class: 'v-sym' }, d.v);
      case 'string': {
        if (opts.top) return h('span', { class: 'v-text' }, d.v);
        const s = opts.short && d.v.length > 120 ? d.v.slice(0, 120) + '…' : d.v;
        return h('span', { class: 'v-str' }, opts.short ? "'" + s + "'" : JSON.stringify(s));
      }
      case 'json': return h('span', { class: 'v-text' }, d.v);
      case 'function': return h('span', { class: 'v-fn' }, opts.short ? (d.v.startsWith('class') ? d.v : 'ƒ') : d.v);
      case 'object': return objectInline(d, opts);
    }
    return h('span', null, String(d.v));
  }
  function nodeLink(d) {
    const el = h('span', { class: 'v-node', title: 'Reveal in Elements panel' }, d.desc || 'node');
    el.addEventListener('click', e => { e.stopPropagation(); Elements.revealNodeId(d.nodeId); });
    el.addEventListener('mouseenter', () => page('highlight', { id: d.nodeId }).catch(() => {}));
    el.addEventListener('mouseleave', () => page('hideHighlight').catch(() => {}));
    return el;
  }
  function objectInline(d, opts) {
    switch (d.sub) {
      case 'node': return nodeLink(d);
      case 'error': return h('span', { class: 'v-err' }, opts.short ? d.desc.split('\n')[0] : d.desc);
      case 'date': return h('span', { class: 'v-text' }, d.desc);
      case 'regexp': return h('span', { class: 'v-str' }, d.desc);
      case 'window': return h('span', null, 'Window');
      case 'promise': return h('span', null, 'Promise');
    }
    const p = d.preview;
    const arrayLike = d.sub === 'array' || d.sub === 'typedarray';
    if (!p || opts.short) {
      if (arrayLike || d.sub === 'map' || d.sub === 'set') return h('span', null, d.cls + '(' + d.len + ')');
      return h('span', null, d.cls === 'Object' ? '{…}' : d.cls);
    }
    const span = h('span', { class: 'v-obj' });
    if (arrayLike) {
      if (d.len > 1 || d.cls !== 'Array') span.append(h('span', { class: 'v-dim' }, (d.cls !== 'Array' ? d.cls : '') + '(' + d.len + ') '));
      span.append('[');
      p.entries.forEach((e, i) => { if (i) span.append(', '); span.append(inlineValue(e[1], { short: true })); });
      if (p.overflow) span.append(', …');
      span.append(']');
      return span;
    }
    if (d.sub === 'map' || d.sub === 'set') {
      span.append(d.cls + '(' + d.len + ') {');
      p.entries.forEach((e, i) => {
        if (i) span.append(', ');
        if (e[0] !== null) span.append(h('span', { class: 'v-key' }, e[0]), ' => ');
        span.append(inlineValue(e[1], { short: true }));
      });
      if (p.overflow) span.append(', …');
      span.append('}');
      return span;
    }
    if (d.cls !== 'Object') span.append(d.cls + ' ');
    span.append('{');
    p.entries.forEach((e, i) => {
      if (i) span.append(', ');
      span.append(h('span', { class: 'v-key' }, e[0]), ': ', inlineValue(e[1], { short: true }));
    });
    if (p.overflow) span.append(', …');
    span.append('}');
    return span;
  }
  function objectTree(d, opts) {
    opts = opts || {};
    const wrap = h('div', { class: 'ot' + (opts.block ? ' ot-block' : '') });
    const head = h('div', { class: 'ot-head' });
    const expandable = isExpandable(d);
    const arrow = h('span', { class: 'ot-arrow' + (expandable ? '' : ' leaf') });
    head.append(arrow);
    if (opts.name !== undefined && opts.name !== null) head.append(h('span', { class: 'ot-name' + (opts.dim ? ' dim' : '') }, opts.name), ': ');
    head.append(inlineValue(d, { top: opts.top, short: opts.name !== undefined && opts.name !== null && !(d && d.preview) }));
    wrap.append(head);
    if (expandable) {
      let body = null;
      let open = false;
      const toggle = async () => {
        open = !open;
        arrow.classList.toggle('open', open);
        if (open && !body) {
          body = h('div', { class: 'ot-body' }, h('span', { class: 'dim' }, '…'));
          wrap.append(body);
          try {
            const props = await page('getProperties', { id: d.id, receiver: opts.receiver || d.id });
            clearEl(body);
            if (!props.length) body.append(h('span', { class: 'dim' }, 'No properties'));
            for (const p of props) body.append(propRow(p, d.id));
          } catch (err) { clearEl(body); body.append(h('span', { class: 'v-err' }, errMsg(err))); }
        }
        if (body) body.hidden = !open;
      };
      head.addEventListener('click', e => {
        if (e.target.closest('.v-node,.getter')) return;
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.type === 'Range') return;
        e.stopPropagation();
        toggle();
      });
      if (opts.expand) toggle();
    }
    return wrap;
  }
  function propRow(p, holderId) {
    if (p.value) return objectTree(p.value, { name: p.name, dim: p.enumerable === false || p.internal, receiver: p.receiver, block: true });
    const row = h('div', { class: 'ot ot-block' }, h('span', { class: 'ot-arrow leaf' }), h('span', { class: 'ot-name dim' }, p.name), ': ');
    if (p.getter && !p.symbol) {
      const g = h('span', { class: 'getter', title: 'Invoke property getter' }, '(...)');
      g.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const v = await page('invokeGetter', { id: holderId, name: p.name, receiver: p.receiverId });
          row.replaceWith(objectTree(v, { name: p.name, block: true }));
        } catch (err) { toast(errMsg(err)); }
      });
      row.append(g);
    } else row.append(h('span', { class: 'dim' }, p.getter ? '(...)' : '(setter)'));
    return row;
  }
  function localInline(v) {
    if (v === null) return h('span', { class: 'v-null' }, 'null');
    if (Array.isArray(v)) return h('span', { class: 'v-dim' }, 'Array(' + v.length + ')');
    if (typeof v === 'object') {
      const ks = Object.keys(v);
      const parts = ks.slice(0, 4).map(k => k + ': ' + (v[k] && typeof v[k] === 'object' ? (Array.isArray(v[k]) ? '[…]' : '{…}') : JSON.stringify(v[k])));
      return h('span', null, '{' + parts.join(', ') + (ks.length > 4 ? ', …' : '') + '}');
    }
    if (typeof v === 'string') return h('span', { class: 'v-str' }, JSON.stringify(v));
    if (typeof v === 'number' || typeof v === 'boolean') return h('span', { class: 'v-num' }, String(v));
    return h('span', null, String(v));
  }
  function localTree(v, name, open) {
    const isObj = v !== null && typeof v === 'object';
    const wrap = h('div', { class: 'ot ot-block' });
    const arrow = h('span', { class: 'ot-arrow' + (isObj ? '' : ' leaf') });
    const head = h('div', { class: 'ot-head' }, arrow);
    if (name !== undefined && name !== null) head.append(h('span', { class: 'ot-name' }, name), ': ');
    head.append(localInline(v));
    wrap.append(head);
    if (isObj) {
      let body = null;
      const toggle = () => {
        const o = !arrow.classList.contains('open');
        arrow.classList.toggle('open', o);
        if (o && !body) {
          body = h('div', { class: 'ot-body' });
          Object.keys(v).slice(0, 2000).forEach(k => body.append(localTree(v[k], k)));
          wrap.append(body);
        }
        if (body) body.hidden = !o;
      };
      head.addEventListener('click', e => { e.stopPropagation(); toggle(); });
      if (open) toggle();
    }
    return wrap;
  }

  // ================================================================== syntax highlighting & pretty printing
  const KW = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in ' +
    'instanceof let new return super switch this throw try typeof var void while with yield async await of static get set null undefined true false NaN Infinity').split(' '));
  function hlJS(src) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b0[xXbBoO][\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b)|([A-Za-z_$][\w$]*)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="s-com">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="s-str">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="s-num">' + esc(m[3]) + '</span>';
      else out += KW.has(m[4]) ? '<span class="s-kw">' + m[4] + '</span>' : esc(m[4]);
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function hlCSS(src) {
    const re = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@[\w-]+)|([\w-]+)(?=\s*:[^{};]*[;}])|(#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|dppx|dpi)?\b)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="s-com">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="s-str">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="s-at">' + esc(m[3]) + '</span>';
      else if (m[4]) out += '<span class="s-prop">' + esc(m[4]) + '</span>';
      else out += '<span class="s-num">' + esc(m[5]) + '</span>';
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function hlTag(t) {
    const m = t.match(/^(<\/?)([^\s>\/]+)([\s\S]*?)(\/?>)?$/);
    if (!m) return esc(t);
    let s = '<span class="s-tag">' + esc(m[1] + m[2]) + '</span>';
    const re = /([^\s=\/>]+)(\s*=\s*("[^"]*"?|'[^']*'?|[^\s>]+))?/g;
    let last = 0;
    let a;
    const rest = m[3];
    while ((a = re.exec(rest))) {
      s += esc(rest.slice(last, a.index));
      s += '<span class="s-attr">' + esc(a[1]) + '</span>';
      if (a[2]) s += esc(a[2].slice(0, a[2].length - a[3].length)) + '<span class="s-val">' + esc(a[3]) + '</span>';
      last = re.lastIndex;
    }
    s += esc(rest.slice(last));
    if (m[4]) s += '<span class="s-tag">' + esc(m[4]) + '</span>';
    return s;
  }
  function hlHTML(src) {
    const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-zA-Z][^>]*>?/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('<!--')) out += '<span class="s-com">' + esc(t) + '</span>';
      else if (t.startsWith('<!')) out += '<span class="s-com">' + esc(t) + '</span>';
      else {
        out += hlTag(t);
        const open = t.match(/^<(script|style)\b/i);
        if (open && !/\/>$/.test(t)) {
          const closeRe = new RegExp('</' + open[1] + '\\s*>', 'ig');
          closeRe.lastIndex = re.lastIndex;
          const c = closeRe.exec(src);
          const end = c ? c.index : src.length;
          const inner = src.slice(re.lastIndex, end);
          out += open[1].toLowerCase() === 'script' ? hlJS(inner) : hlCSS(inner);
          re.lastIndex = end;
        }
      }
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function highlight(src, type) {
    if (type === 'js' || type === 'json') return hlJS(src);
    if (type === 'css') return hlCSS(src);
    if (type === 'html' || type === 'xml' || type === 'svg') return hlHTML(src);
    return esc(src);
  }
  function makeBuf() {
    const buf = [];
    return {
      buf,
      push(s) { buf.push(s); },
      trimEnd() {
        while (buf.length) {
          const t = buf[buf.length - 1].replace(/[ \t\n]+$/, '');
          if (t === '') { buf.pop(); continue; }
          buf[buf.length - 1] = t;
          break;
        }
      },
      endsWithSpace() { const l = buf[buf.length - 1]; return !l || /[\s(\[]$/.test(l); },
      text() { return buf.join(''); }
    };
  }
  function prettyJS(src) {
    const b = makeBuf();
    const IND = '  ';
    let indent = 0, paren = 0, i = 0, lastSig = '';
    const n = src.length;
    const nl = () => { b.trimEnd(); b.push('\n' + IND.repeat(Math.max(0, indent))); };
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        b.push(src.slice(i, j + 1)); i = j + 1; lastSig = 'a'; continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        b.push(src.slice(i, j)); i = j; nl(); continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        b.push(src.slice(i, j)); i = j; continue;
      }
      if (c === '/' && (lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
        let j = i + 1, inClass = false;
        while (j < n) {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if ((d === '/' && !inClass) || d === '\n') break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        b.push(src.slice(i, j)); i = j; lastSig = 'a'; continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        if (!b.endsWithSpace()) b.push(' ');
        i++; continue;
      }
      if (c === '{') { b.push('{'); indent++; nl(); i++; lastSig = '{'; continue; }
      if (c === '}') {
        indent--; nl(); b.push('}'); i++; lastSig = '}';
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        const nx = src[j];
        if (nx && /[;,)\].]/.test(nx)) continue;
        if (src.startsWith('else', j) || src.startsWith('catch', j) || src.startsWith('finally', j) || src.startsWith('while', j)) { b.push(' '); continue; }
        if (nx) nl();
        continue;
      }
      if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      if (c === ';') {
        b.trimEnd(); b.push(';'); i++; lastSig = ';';
        if (paren === 0) nl(); else b.push(' ');
        continue;
      }
      if (c === ',') { b.trimEnd(); b.push(', '); i++; lastSig = ','; continue; }
      b.push(c); i++;
      lastSig = /[\w$]/.test(c) ? 'a' : c;
    }
    return b.text().replace(/[ \t]+\n/g, '\n').trim();
  }
  function prettyCSS(src) {
    const b = makeBuf();
    let indent = 0, i = 0;
    const n = src.length;
    const nl = () => { b.trimEnd(); b.push('\n' + '  '.repeat(Math.max(0, indent))); };
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        b.push(src.slice(i, j)); i = j; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        b.push(src.slice(i, j + 1)); i = j + 1; continue;
      }
      if (c === '{') { b.trimEnd(); b.push(' {'); indent++; nl(); }
      else if (c === '}') { indent--; nl(); b.push('}'); b.push('\n'); nl(); }
      else if (c === ';') { b.push(';'); nl(); }
      else if (/\s/.test(c)) { if (!b.endsWithSpace()) b.push(' '); }
      else if (c === ':' ) { b.push(': '); while (i + 1 < n && src[i + 1] === ' ') i++; }
      else b.push(c);
      i++;
    }
    return b.text().replace(/: {2,}/g, ': ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  }
  function guessType(url, mime) {
    const m = (mime || '').toLowerCase();
    const u = (url || '').split(/[?#]/)[0].toLowerCase();
    if (/javascript|ecmascript/.test(m) || /\.(m?js|cjs|jsx|ts)$/.test(u)) return 'js';
    if (/css/.test(m) || /\.css$/.test(u)) return 'css';
    if (/json/.test(m) || /\.json$/.test(u)) return 'json';
    if (/^image\//.test(m) || /\.(png|jpe?g|gif|webp|ico|avif|bmp|svg)$/.test(u)) return 'img';
    if (/html/.test(m) || /\.html?$/.test(u) || /\/$/.test(u)) return 'html';
    if (/xml/.test(m) || /\.xml$/.test(u)) return 'xml';
    return 'other';
  }
  function fileIcon(type) {
    const map = { js: ['js', 'JS'], css: ['css', '#'], html: ['html', '<>'], img: ['img', '▣'], json: ['js', '{}'] };
    const e = map[type] || ['other', '·'];
    return h('span', { class: 'ficon ' + e[0] }, e[1]);
  }

  // ================================================================== panels framework
  const PANELS = [
    ['elements', 'Elements'], ['console', 'Console'], ['sources', 'Sources'], ['network', 'Network'],
    ['performance', 'Performance'], ['memory', 'Memory'], ['application', 'Application'], ['security', 'Security']
  ];
  const modules = {};
  let currentPanel = null;
  let devtoolsVisible = true;
  let pageUrl = '';
  function showPanel(name) {
    if (!modules[name]) return;
    currentPanel = name;
    Settings.panel = name;
    saveSettings();
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    const tab = document.querySelector('.tab[data-panel="' + name + '"]');
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (modules[name].onShow) Promise.resolve().then(() => modules[name].onShow()).catch(e => console.error(e));
  }
  DT.showPanel = showPanel;

  // ================================================================== Elements
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const Elements = modules.elements = {
    nodes: new Map(), rootId: null, selected: null, rowEls: new Map(), loaded: false, loading: null,
    sideTab: 'styles', disabledProps: new Map(), pendingIds: new Set(), sideToken: 0, computedFilter: '',
    listenerAncestors: true, inspecting: false, searchQ: '', searchRes: [], searchIdx: -1, blocks: [],
    build(el) {
      this.searchCount = h('span', { class: 'dim', style: { padding: '0 4px' } });
      this.searchInput = h('input', { class: 'filter', type: 'search', placeholder: 'Find by string, selector or XPath', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      this.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.search(this.searchInput.value, e.shiftKey ? -1 : 1); } });
      this.searchInput.addEventListener('input', () => { if (!this.searchInput.value) { this.searchQ = ''; this.searchRes = []; this.searchCount.textContent = ''; } });
      const tb = h('div', { class: 'ptb' },
        h('button', { class: 'ibtn', title: 'Reload DOM tree', onclick: () => this.reload() }, '⟳'),
        this.searchInput,
        h('button', { class: 'ibtn', title: 'Previous', onclick: () => this.search(this.searchInput.value, -1) }, '‹'),
        h('button', { class: 'ibtn', title: 'Next', onclick: () => this.search(this.searchInput.value, 1) }, '›'),
        this.searchCount
      );
      this.tree = h('div', { class: 'dom-tree' });
      this.treeScroll = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, this.tree);
      this.crumbs = h('div', { class: 'breadcrumbs' });
      const paneA = h('div', { class: 'pane-a', style: { display: 'flex', flexDirection: 'column' } }, this.treeScroll, this.crumbs);
      const sub = h('div', { class: 'subtabs' });
      [['styles', 'Styles'], ['computed', 'Computed'], ['layout', 'Layout'], ['listeners', 'Event Listeners'], ['properties', 'Properties']].forEach(([k, t]) => {
        sub.append(h('button', { class: 'subtab' + (k === this.sideTab ? ' active' : ''), 'data-k': k, onclick: () => { this.sideTab = k; sub.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.dataset.k === k)); this.refreshSide(); } }, t));
      });
      this.sideBody = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      const paneB = h('div', { class: 'pane-b' }, sub, this.sideBody);
      el.append(tb, h('div', { class: 'split stack' }, paneA, paneB));
      this.tree.append(h('div', { class: 'empty' }, 'Loading…'));
      this.bindTree();
    },
    bindTree() {
      const t = this.tree;
      t.addEventListener('click', e => {
        const row = e.target.closest('.dn-row');
        if (!row) return;
        const id = +row.dataset.id;
        const act = e.target.dataset.act;
        if (act === 'toggle') { this.toggle(id); return; }
        if (act === 'menu') { const r = e.target.getBoundingClientRect(); this.nodeMenu(id, r.left, r.bottom); return; }
        const attr = e.target.dataset.attr;
        if (attr !== undefined && this.selected === id) { this.editAttribute(id, attr); return; }
        if (this.selected === id && e.target.closest('.t-text') && this.nodes.get(id).d.type === 3) { this.editText(id); return; }
        this.select(id);
      });
      t.addEventListener('dblclick', e => {
        const row = e.target.closest('.dn-row');
        if (row) this.toggle(+row.dataset.id);
      });
      t.addEventListener('mouseover', e => {
        const row = e.target.closest('.dn-row');
        if (!row || row === this.hoverRow) return;
        if (this.hoverRow) this.hoverRow.classList.remove('hl');
        this.hoverRow = row;
        row.classList.add('hl');
        if (!this.touching) page('highlight', { id: +row.dataset.id }).catch(() => {});
      });
      t.addEventListener('mouseleave', () => {
        if (this.hoverRow) this.hoverRow.classList.remove('hl');
        this.hoverRow = null;
        if (!this.touching) page('hideHighlight').catch(() => {});
      });
      t.addEventListener('touchstart', () => { this.touching = true; }, { passive: true });
      onLongPress(t, (target, x, y) => {
        const row = target.closest && target.closest('.dn-row');
        if (!row) return;
        const id = +row.dataset.id;
        this.select(id);
        this.nodeMenu(id, x, y);
      });
    },
    reset() {
      this.nodes.clear();
      this.rowEls.clear();
      this.rootId = null;
      this.selected = null;
      this.loaded = false;
      this.pendingIds.clear();
      this.searchQ = '';
      this.searchRes = [];
      this.disabledProps.clear();
      clearEl(this.tree);
      this.tree.append(h('div', { class: 'empty' }, 'Loading…'));
      clearEl(this.crumbs);
      clearEl(this.sideBody);
    },
    onShow() {
      if (!this.loaded) this.reload();
      else if (this.pendingIds.size) { const ids = Array.from(this.pendingIds); this.pendingIds.clear(); this.refreshIds(ids); }
    },
    setChildren(id, kids) {
      const n = this.nodes.get(id);
      if (!n) return;
      n.children = kids.map(k => {
        const ex = this.nodes.get(k.id);
        if (ex) { ex.d = k; ex.parent = id; }
        else this.nodes.set(k.id, { d: k, parent: id, expanded: false, children: null });
        return k.id;
      });
      n.d.count = kids.length;
    },
    async fetchChildren(id) {
      const kids = await page('getChildren', { id });
      this.setChildren(id, kids);
    },
    reload() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        try {
          const doc = await page('getDocument');
          const keepSelected = this.selected;
          this.nodes.clear();
          this.rowEls.clear();
          this.rootId = doc.root.id;
          this.nodes.set(doc.root.id, { d: doc.root, parent: null, expanded: true, children: null, depth: -1 });
          this.setChildren(doc.root.id, doc.children);
          const html = doc.children.find(c => c.type === 1);
          let body = null;
          if (html) {
            await this.fetchChildren(html.id);
            this.nodes.get(html.id).expanded = true;
            const bodyId = this.nodes.get(html.id).children.find(i => this.nodes.get(i).d.name === 'body');
            if (bodyId) {
              body = bodyId;
              await this.fetchChildren(bodyId);
              this.nodes.get(bodyId).expanded = true;
            }
          }
          this.loaded = true;
          this.renderTree();
          if (keepSelected && this.nodes.has(keepSelected)) this.select(keepSelected, { noHighlight: true, scroll: true });
          else if (body) this.select(body, { noHighlight: true });
        } catch (e) {
          clearEl(this.tree);
          this.tree.append(h('div', { class: 'empty' }, 'Cannot inspect this page: ' + errMsg(e)));
        } finally { this.loading = null; }
      })();
      return this.loading;
    },
    renderTree() {
      clearEl(this.tree);
      this.rowEls.clear();
      const root = this.nodes.get(this.rootId);
      if (!root) return;
      for (const c of root.children || []) this.tree.append(this.renderNode(c, 0));
    },
    hasKids(d) { return (d.type === 1 || d.type === 9 || d.type === 11) && d.count > 0 && d.inlineText === undefined; },
    renderNode(id, depth) {
      const n = this.nodes.get(id);
      if (!n) return h('div');
      n.depth = depth;
      const d = n.d;
      const wrap = h('div', { class: 'dn' });
      const row = h('div', { class: 'dn-row' + (id === this.selected ? ' selected' : ''), 'data-id': id });
      row.style.paddingLeft = (depth * 14 + 16) + 'px';
      const kids = this.hasKids(d);
      if (kids) row.append(h('span', { class: 'dn-arrow' + (n.expanded ? ' open' : ''), 'data-act': 'toggle' }));
      row.append(this.rowContent(d, n.expanded && kids, kids, depth));
      row.append(h('span', { class: 'eq0' }));
      row.append(h('button', { class: 'dn-more', 'data-act': 'menu' }, '⋯'));
      wrap.append(row);
      if (kids && n.expanded && n.children) {
        const box = h('div', { class: 'dn-kids' });
        for (const c of n.children) box.append(this.renderNode(c, depth + 1));
        wrap.append(box);
        if (d.type === 1) {
          const close = h('div', { class: 'dn-row', 'data-id': id });
          close.style.paddingLeft = (depth * 14 + 16) + 'px';
          close.append(this.closeTag(d.name));
          wrap.append(close);
        }
      }
      this.rowEls.set(id, wrap);
      return wrap;
    },
    closeTag(name) { return h('span', { class: 't-tag' }, '</' + name + '>'); },
    rowContent(d, expanded, kids, depth) {
      const s = h('span');
      switch (d.type) {
        case 1: {
          s.append(h('span', { class: 't-tag' }, '<' + d.name));
          for (const [k, v] of d.attrs || []) {
            s.append(' ', h('span', { class: 't-attr', 'data-attr': k }, k));
            if (v !== '' || !/^(hidden|disabled|checked|selected|async|defer|readonly|required|multiple|autofocus|novalidate|open|controls|loop|muted|playsinline|nomodule)$/.test(k)) {
              s.append(h('span', { class: 't-tag' }, '="'), h('span', { class: 't-val', 'data-attr': k }, v.length > 150 ? v.slice(0, 150) + '…' : v), h('span', { class: 't-tag' }, '"'));
            }
          }
          s.append(h('span', { class: 't-tag' }, '>'));
          if (d.inlineText !== undefined) s.append(h('span', { class: 't-text' }, d.inlineText), this.closeTag(d.name));
          else if (kids && !expanded) s.append(h('span', { class: 'dim' }, '…'), this.closeTag(d.name));
          else if (!kids && !VOID.has(d.name)) s.append(this.closeTag(d.name));
          break;
        }
        case 3: {
          const t = d.text.replace(/\s+/g, ' ').trim();
          s.append(h('span', { class: 't-text' }, '"' + (t.length > 300 ? t.slice(0, 300) + '…' : t) + '"'));
          break;
        }
        case 4: s.append(h('span', { class: 't-comment' }, '<![CDATA[' + d.text + ']]>')); break;
        case 8: s.append(h('span', { class: 't-comment' }, '<!--' + d.text.replace(/\s+/g, ' ') + '-->')); break;
        case 9: s.append(h('span', { class: 't-pseudo' }, '#document' + (depth > 0 && d.url ? ' (' + d.url + ')' : ''))); break;
        case 10: s.append(h('span', { class: 't-doctype' }, '<!DOCTYPE ' + d.name + '>')); break;
        case 11: s.append(h('span', { class: 't-pseudo' }, '#shadow-root (' + (d.mode || 'open') + ')')); break;
        default: s.append(d.name);
      }
      return s;
    },
    rerender(id) {
      if (id === this.rootId) { this.renderTree(); return; }
      const old = this.rowEls.get(id);
      const n = this.nodes.get(id);
      if (!old || !n || !old.isConnected) return;
      old.replaceWith(this.renderNode(id, n.depth || 0));
    },
    async toggle(id, force) {
      const n = this.nodes.get(id);
      if (!n || !this.hasKids(n.d)) return;
      const want = force !== undefined ? force : !n.expanded;
      try {
        if (want && !n.children) await this.fetchChildren(id);
      } catch (e) { toast(errMsg(e)); return; }
      n.expanded = want;
      this.rerender(id);
    },
    async expandRecursively(id) {
      let budget = 400;
      const walk = async (nid, depth) => {
        const n = this.nodes.get(nid);
        if (!n || !this.hasKids(n.d) || budget <= 0 || depth > 8) return;
        if (!n.children) await this.fetchChildren(nid);
        n.expanded = true;
        budget -= n.children.length;
        for (const c of n.children) await walk(c, depth + 1);
      };
      try { await walk(id, 0); } catch (e) { toast(errMsg(e)); }
      this.rerender(id);
    },
    collapseChildren(id) {
      const walk = nid => { const n = this.nodes.get(nid); if (!n) return; n.expanded = false; (n.children || []).forEach(walk); };
      const n = this.nodes.get(id);
      if (n) (n.children || []).forEach(walk);
      this.rerender(id);
    },
    select(id, opts) {
      opts = opts || {};
      if (!this.nodes.has(id)) return;
      if (this.selected !== null) {
        const prev = this.rowEls.get(this.selected);
        if (prev && prev.firstChild) prev.firstChild.classList.remove('selected');
      }
      this.selected = id;
      const cur = this.rowEls.get(id);
      if (cur && cur.firstChild) {
        cur.firstChild.classList.add('selected');
        if (opts.scroll) this.scrollRowIntoView(cur.firstChild);
      }
      page('select', { id }).catch(() => {});
      if (!opts.noHighlight) this.flashHighlight(id);
      this.renderCrumbs();
      this.refreshSide();
    },
    scrollRowIntoView(row) {
      const s = this.treeScroll;
      const rr = row.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      if (rr.top < sr.top || rr.bottom > sr.bottom) s.scrollTop += rr.top - sr.top - sr.height / 2 + rr.height / 2;
      const left = parseFloat(row.style.paddingLeft) || 0;
      if (left - s.scrollLeft > sr.width * 0.6 || left < s.scrollLeft) s.scrollLeft = Math.max(0, left - 40);
    },
    flashHighlight(id) {
      page('highlight', { id }).catch(() => {});
      clearTimeout(this.hlTimer);
      this.hlTimer = setTimeout(() => page('hideHighlight').catch(() => {}), 1600);
    },
    label(d) {
      if (d.type !== 1) return d.type === 3 ? '#text' : d.type === 9 ? '#document' : d.type === 11 ? '#shadow-root' : d.name;
      let s = d.name;
      const id = (d.attrs || []).find(a => a[0] === 'id');
      const cls = (d.attrs || []).find(a => a[0] === 'class');
      if (id && id[1]) s += '#' + id[1];
      if (cls && cls[1].trim()) s += '.' + cls[1].trim().split(/\s+/).slice(0, 2).join('.');
      return s;
    },
    renderCrumbs() {
      clearEl(this.crumbs);
      const chain = [];
      let cur = this.selected;
      while (cur !== null && cur !== undefined && cur !== this.rootId) {
        const n = this.nodes.get(cur);
        if (!n) break;
        chain.unshift(cur);
        cur = n.parent;
      }
      for (const id of chain) {
        const n = this.nodes.get(id);
        this.crumbs.append(h('span', { class: 'crumb' + (id === this.selected ? ' cur' : ''), onclick: () => this.select(id, { scroll: true }) }, this.label(n.d)));
      }
      this.crumbs.scrollLeft = this.crumbs.scrollWidth;
    },
    async revealData(data) {
      if (!this.loaded) await this.reload();
      for (const step of data.chain) {
        let n = this.nodes.get(step.id);
        if (!n) { n = { d: step.node, parent: null, expanded: false, children: null }; this.nodes.set(step.id, n); }
        else n.d = step.node;
        this.setChildren(step.id, step.children);
        n.expanded = true;
      }
      if (data.chain.length && data.chain[0].id !== this.rootId) { await this.reload(); return this.revealData(data); }
      this.renderTree();
      this.select(data.target, { scroll: true, noHighlight: true });
    },
    async revealNodeId(id) {
      showPanel('elements');
      try { await this.revealData(await page('revealNode', { id })); } catch (e) { toast(errMsg(e)); }
    },
    onInspectNode(data) {
      this.setInspecting(false);
      showPanel('elements');
      this.revealData(data);
    },
    setInspecting(on) {
      this.inspecting = on;
      $('#btn-inspect').classList.toggle('active', on);
    },
    toggleInspect() {
      const on = !this.inspecting;
      page('setInspectMode', { on }).then(() => this.setInspecting(on)).catch(e => toast(errMsg(e)));
      if (on) toast('Tap an element in the page to inspect it');
    },
    async search(q, dir) {
      q = (q || '').trim();
      if (!q) return;
      try {
        if (q !== this.searchQ) { this.searchQ = q; this.searchRes = await page('searchNodes', { query: q }); this.searchIdx = -1; }
        if (!this.searchRes.length) { this.searchCount.textContent = '0 results'; return; }
        this.searchIdx = (this.searchIdx + dir + this.searchRes.length) % this.searchRes.length;
        this.searchCount.textContent = (this.searchIdx + 1) + ' of ' + this.searchRes.length;
        await this.revealData(await page('revealNode', { id: this.searchRes[this.searchIdx] }));
      } catch (e) { toast(errMsg(e)); }
    },
    onDomUpdated(ids) {
      if (!this.loaded) return;
      if (currentPanel !== 'elements' || !devtoolsVisible) { ids.forEach(i => this.pendingIds.add(i)); return; }
      this.refreshIds(ids);
    },
    async refreshIds(ids) {
      const known = ids.filter(id => this.nodes.has(id));
      if (!known.length) return;
      let res;
      try { res = await page('refreshNodes', { ids: known }); } catch (e) { return; }
      const changed = new Set();
      for (const r of res) {
        const n = this.nodes.get(r.id);
        if (!n) continue;
        n.d = r.node;
        if (n.children || n.expanded) this.setChildren(r.id, r.children);
        changed.add(r.id);
      }
      for (const id of changed) {
        let p = this.nodes.get(id).parent;
        let skip = false;
        while (p !== null && p !== undefined) {
          if (changed.has(p)) { skip = true; break; }
          const pn = this.nodes.get(p);
          p = pn ? pn.parent : null;
        }
        if (!skip) this.rerender(id);
      }
      if (this.selected !== null && changed.has(this.selected) && this.sideTab !== 'styles') this.refreshSide(true);
    },
    nodeMenu(id, x, y) {
      const n = this.nodes.get(id);
      if (!n) return;
      const d = n.d;
      const isEl = d.type === 1;
      const paths = async key => { try { copyText((await page('nodePaths', { id }))[key]); } catch (e) { toast(errMsg(e)); } };
      const items = [];
      if (isEl) {
        items.push(
          { label: 'Add attribute', action: () => this.addAttribute(id) },
          { label: 'Edit as HTML', action: () => this.editHTML(id) },
          { label: 'Duplicate element', action: () => this.mutate('duplicateNode', id) },
          { label: 'Delete element', danger: true, action: () => this.mutate('removeNode', id) },
          '-',
          { label: 'Hide element', action: () => page('toggleHide', { id }).catch(e => toast(errMsg(e))) },
          { label: 'Scroll into view', action: () => page('scrollIntoView', { id }).then(() => this.flashHighlight(id)) },
          { label: 'Expand recursively', action: () => this.expandRecursively(id) },
          { label: 'Collapse children', action: () => this.collapseChildren(id) },
          '-',
          { label: 'Copy element (outerHTML)', action: () => paths('outerHTML') },
          { label: 'Copy selector', action: () => paths('selector') },
          { label: 'Copy JS path', action: () => paths('jsPath') },
          { label: 'Copy XPath', action: () => paths('xpath') },
          '-',
          { label: 'Store as global variable', action: () => this.storeGlobal(id) },
          { label: 'Reveal in Console ($0)', action: () => { showPanel('console'); Console.setInput('$0'); } }
        );
      } else if (d.type === 3 || d.type === 8) {
        items.push(
          { label: 'Edit text', action: () => this.editText(id) },
          { label: 'Delete node', danger: true, action: () => this.mutate('removeNode', id) },
          { label: 'Copy text', action: () => copyText(d.text) },
          { label: 'Store as global variable', action: () => this.storeGlobal(id) }
        );
      } else {
        items.push({ label: 'Expand recursively', action: () => this.expandRecursively(id) }, { label: 'Store as global variable', action: () => this.storeGlobal(id) });
      }
      popupMenu(items, x, y);
    },
    async storeGlobal(id) {
      try {
        const name = await page('storeGlobal', { nodeId: id });
        showPanel('console');
        Console.add({ kind: 'result', value: { t: 'string', v: name } });
        Console.setInput(name);
      } catch (e) { toast(errMsg(e)); }
    },
    async mutate(cmd, id) {
      try {
        const parent = await page(cmd, { id });
        if (parent) {
          if (cmd === 'removeNode' && this.selected === id) { this.selected = parent; }
          await this.refreshIds([parent]);
          if (this.selected === parent) this.select(parent, { noHighlight: true });
        }
      } catch (e) { toast(errMsg(e)); }
    },
    async addAttribute(id) {
      const r = await dialog({ title: 'Add attribute', fields: [{ label: 'Name', placeholder: 'class' }, { label: 'Value', placeholder: 'value' }] });
      if (!r || !r[0].trim()) return;
      try { await page('setAttribute', { id, name: r[0].trim(), value: r[1] }); await this.refreshIds([id]); this.refreshSide(true); } catch (e) { toast(errMsg(e)); }
    },
    async editAttribute(id, name) {
      const n = this.nodes.get(id);
      const cur = (n.d.attrs || []).find(a => a[0] === name);
      const r = await dialog({ title: 'Edit attribute', message: 'Clear the name to remove the attribute.', fields: [{ label: 'Name', value: name }, { label: 'Value', value: cur ? cur[1] : '', multiline: cur && cur[1].length > 60, rows: 4 }] });
      if (!r) return;
      try {
        const nn = r[0].trim();
        if (nn !== name) await page('removeAttribute', { id, name });
        if (nn) await page('setAttribute', { id, name: nn, value: r[1] });
        await this.refreshIds([id]);
        this.refreshSide(true);
      } catch (e) { toast(errMsg(e)); }
    },
    async editText(id) {
      const n = this.nodes.get(id);
      const r = await dialog({ title: 'Edit text', fields: [{ value: n.d.text, multiline: true, rows: 6 }] });
      if (!r) return;
      try { await page('setText', { id, text: r[0] }); await this.refreshIds([n.parent, id]); } catch (e) { toast(errMsg(e)); }
    },
    async editHTML(id) {
      let html;
      try { html = await page('getOuterHTML', { id }); } catch (e) { toast(errMsg(e)); return; }
      const r = await dialog({ title: 'Edit as HTML', fields: [{ value: html, multiline: true, rows: 16 }], okText: 'Apply', noSelect: true });
      if (!r) return;
      try {
        const parent = await page('setOuterHTML', { id, html: r[0] });
        if (parent) { await this.refreshIds([parent]); this.select(parent, { noHighlight: true, scroll: true }); }
      } catch (e) { toast(errMsg(e)); }
    },
    setSide(content, token) {
      if (token !== undefined && token !== this.sideToken) return;
      const st = this.sideBody.scrollTop;
      clearEl(this.sideBody);
      this.sideBody.append(content);
      this.sideBody.scrollTop = st;
    },
    refreshSide(soft) {
      const id = this.selected;
      if (id === null || id === undefined) return;
      const token = ++this.sideToken;
      if (!soft) this.setSide(h('div', { class: 'empty' }, 'Loading…'));
      const fn = { styles: this.renderStyles, computed: this.renderComputed, layout: this.renderLayout, listeners: this.renderListeners, properties: this.renderProperties }[this.sideTab];
      fn.call(this, id, token).catch(e => this.setSide(h('div', { class: 'empty' }, errMsg(e)), token));
    },
    notElement(id, token) {
      const n = this.nodes.get(id);
      if (n && n.d.type === 1) return false;
      this.setSide(h('div', { class: 'empty' }, 'Select an element node'), token);
      return true;
    },
    async renderStyles(id, token) {
      if (this.notElement(id, token)) return;
      const st = await page('getStyles', { id });
      const blocks = [{ key: 'inline:' + id, selector: 'element.style', props: st.inline, inline: true }].concat(
        st.rules.map(r => ({ key: 'rule:' + r.id, ruleId: r.id, selector: r.selector, source: r.source, href: r.href, media: r.media, props: r.props })));
      for (const b of blocks) {
        const dis = this.disabledProps.get(b.key) || [];
        b.all = b.props.map(p => Object.assign({}, p, { on: true })).concat(dis.filter(dp => !b.props.some(p => p.n === dp.n)).map(p => Object.assign({}, p, { on: false })));
      }
      const seenImp = new Set();
      const seen = new Set();
      for (const pass of [true, false]) {
        for (const b of blocks) {
          for (let i = b.all.length - 1; i >= 0; i--) {
            const p = b.all[i];
            if (!p.on || !!p.imp !== pass) continue;
            if (pass ? seenImp.has(p.n) : (seen.has(p.n) || seenImp.has(p.n))) p.over = true;
            else (pass ? seenImp : seen).add(p.n);
          }
        }
      }
      this.blocks = blocks;
      const wrap = h('div', { class: 'styles-pane' });
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter', style: { margin: '6px 8px', width: 'calc(100% - 16px)' } });
      filter.value = this.styleFilter || '';
      const list = h('div');
      const draw = () => {
        clearEl(list);
        const q = filter.value.trim().toLowerCase();
        this.styleFilter = filter.value;
        for (const b of blocks) {
          const props = q ? b.all.filter(p => p.n.includes(q) || p.v.toLowerCase().includes(q)) : b.all;
          if (q && !props.length && !b.selector.toLowerCase().includes(q)) continue;
          const rule = h('div', { class: 'rule' });
          const head = h('div', { class: 'rule-head' }, h('span', { class: 'rule-sel' }, b.selector, ' {'));
          if (b.inline) head.append(h('button', { class: 'add-prop', title: 'Add style property', onclick: () => this.addProp(b, id) }, '+'));
          else if (b.source) head.append(h('span', { class: 'rule-src', onclick: () => { if (b.href) Sources.openUrl(b.href); } }, b.source));
          if (b.media) rule.append(h('div', { class: 'rule-media' }, b.media));
          rule.append(head);
          for (const p of props) rule.append(this.propRow(b, p, id));
          rule.append(h('div', { class: 'rule-sel' }, '}'));
          onLongPress(head, () => this.editRule(b, id));
          head.addEventListener('dblclick', () => this.editRule(b, id));
          list.append(rule);
        }
        if (st.blocked) list.append(h('div', { class: 'empty' }, st.blocked + ' cross-origin stylesheet(s) cannot be inspected by the page.'));
      };
      filter.addEventListener('input', draw);
      draw();
      wrap.append(filter, list);
      this.setSide(wrap, token);
    },
    propRow(b, p, id) {
      const cb = h('input', { type: 'checkbox', title: 'Toggle property' });
      cb.checked = p.on;
      cb.addEventListener('change', () => this.toggleProp(b, p, cb.checked, id));
      const sw = isColor(p.v) ? h('span', { class: 'swatch', style: { background: p.v } }) : null;
      const txt = h('span', null, h('span', { class: 'pn' }, p.n), ': ', sw, h('span', { class: 'pv' }, p.v + (p.imp ? ' !important' : '')), ';');
      txt.addEventListener('click', () => this.editProp(b, p, id));
      return h('div', { class: 'prop' + (p.over ? ' over' : '') + (p.on ? '' : ' disabled') }, cb, txt);
    },
    compose(b) {
      return b.all.filter(p => p.on).map(p => p.n + ': ' + p.v + (p.imp ? ' !important' : '') + ';').join(' ');
    },
    async applyBlock(b, id, cssText) {
      try {
        if (b.inline) await page('setInlineStyle', { id, cssText });
        else await page('setRuleStyle', { ruleId: b.ruleId, cssText });
      } catch (e) { toast(errMsg(e)); }
      this.refreshSide(true);
    },
    toggleProp(b, p, on, id) {
      p.on = on;
      let dis = this.disabledProps.get(b.key) || [];
      dis = dis.filter(x => x.n !== p.n);
      if (!on) dis.push({ n: p.n, v: p.v, imp: p.imp });
      this.disabledProps.set(b.key, dis);
      this.applyBlock(b, id, this.compose(b));
    },
    async editProp(b, p, id) {
      const r = await dialog({ title: b.selector, message: 'Clear the name to remove the property.', fields: [{ label: 'Property', value: p.n }, { label: 'Value', value: p.v + (p.imp ? ' !important' : '') }] });
      if (!r) return;
      const name = r[0].trim();
      if (!name) b.all = b.all.filter(x => x !== p);
      else {
        let v = r[1].trim().replace(/;+$/, '');
        p.imp = /!\s*important$/i.test(v);
        v = v.replace(/\s*!\s*important$/i, '');
        p.n = name; p.v = v;
      }
      this.applyBlock(b, id, this.compose(b));
    },
    async addProp(b, id) {
      const r = await dialog({ title: 'Add style property', fields: [{ label: 'Property', placeholder: 'color' }, { label: 'Value', placeholder: 'red' }] });
      if (!r || !r[0].trim()) return;
      let v = r[1].trim().replace(/;+$/, '');
      const imp = /!\s*important$/i.test(v);
      v = v.replace(/\s*!\s*important$/i, '');
      b.all.push({ n: r[0].trim(), v, imp, on: true });
      this.applyBlock(b, id, this.compose(b));
    },
    async editRule(b, id) {
      const text = b.all.filter(p => p.on).map(p => p.n + ': ' + p.v + (p.imp ? ' !important' : '') + ';').join('\n');
      const r = await dialog({ title: b.selector, fields: [{ value: text, multiline: true, rows: 10 }], okText: 'Apply', noSelect: true });
      if (!r) return;
      this.disabledProps.delete(b.key);
      this.applyBlock(b, id, r[0]);
    },
    async renderComputed(id, token) {
      if (this.notElement(id, token)) return;
      const list = await page('getComputed', { id });
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter', style: { margin: '6px 8px', width: 'calc(100% - 16px)' } });
      filter.value = this.computedFilter;
      const body = h('div', { class: 'mono', style: { padding: '0 8px 30px' } });
      const draw = () => {
        clearEl(body);
        const q = filter.value.trim().toLowerCase();
        this.computedFilter = filter.value;
        for (const [k, v] of list) {
          if (q && !k.includes(q) && !v.toLowerCase().includes(q)) continue;
          body.append(h('div', { class: 'prop' }, h('span', null, h('span', { class: 'pn' }, k), ': ', isColor(v) ? h('span', { class: 'swatch', style: { background: v } }) : null, h('span', { class: 'pv' }, v), ';')));
        }
      };
      filter.addEventListener('input', draw);
      draw();
      this.setSide(h('div', null, filter, body), token);
    },
    async renderLayout(id, token) {
      if (this.notElement(id, token)) return;
      const b = await page('getBox', { id });
      if (!b) { this.setSide(h('div', { class: 'empty' }, 'No layout'), token); return; }
      const f = v => (v === 0 ? '–' : String(Math.round(v * 100) / 100));
      const layer = (cls, label, vals, inner) => h('div', { class: 'bm ' + cls },
        h('span', { class: 'bm-label' }, label), h('span', { class: 'bm-t' }, f(vals[0])), h('span', { class: 'bm-r' }, f(vals[1])),
        h('span', { class: 'bm-b' }, f(vals[2])), h('span', { class: 'bm-l' }, f(vals[3])), inner);
      let model = layer('bm-margin', 'margin', b.margin,
        layer('bm-border', 'border', b.border,
          layer('bm-padding', 'padding', b.padding,
            h('div', { class: 'bm-content' }, f(b.width) + ' × ' + f(b.height)))));
      if (b.position && b.position !== 'static') model = layer('bm-pos', 'position', b.posValues.map(v => parseFloat(v) || 0), model);
      const kv = h('div', { class: 'kv' });
      const add = (k, v) => kv.append(h('div', null, k), h('div', { class: 'mono' }, v));
      add('display', b.display); add('position', b.position); add('box-sizing', b.boxSizing); add('z-index', b.zIndex); add('float', b.float);
      add('x, y', Math.round(b.rect.x) + ', ' + Math.round(b.rect.y)); add('width × height', Math.round(b.rect.w * 100) / 100 + ' × ' + Math.round(b.rect.h * 100) / 100);
      add('font', b.fontSize + ' ' + b.fontFamily); add('color', b.color); add('background', b.background);
      this.setSide(h('div', null, h('div', { class: 'boxmodel' }, model), kv), token);
    },
    async renderListeners(id, token) {
      const list = await page('getListeners', { id, ancestors: this.listenerAncestors });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = this.listenerAncestors;
      cb.addEventListener('change', () => { this.listenerAncestors = cb.checked; this.refreshSide(true); });
      const wrap = h('div', null, h('div', { class: 'ptb' }, h('label', { class: 'chk' }, cb, 'Ancestors'), h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.refreshSide(true) }, '⟳')));
      if (!list.length) wrap.append(h('div', { class: 'empty' }, 'No event listeners'));
      const byType = new Map();
      list.forEach(l => { if (!byType.has(l.type)) byType.set(l.type, []); byType.get(l.type).push(l); });
      Array.from(byType.keys()).sort().forEach(type => {
        wrap.append(h('div', { class: 'listener-type' }, type, h('span', { class: 'dim' }, ' (' + byType.get(type).length + ')')));
        byType.get(type).forEach(l => {
          const meta = h('div', { class: 'lmeta' }, h('span', { class: 't-tag mono' }, l.owner));
          const flags = [l.attr ? 'attribute' : null, l.capture ? 'capture' : null, l.passive ? 'passive' : null, l.once ? 'once' : null].filter(Boolean);
          if (flags.length) meta.append(h('span', { class: 'dim' }, flags.join(', ')));
          if (l.idx >= 0) {
            meta.append(h('button', {
              class: 'btn danger lremove', onclick: async () => {
                try { await page('removeListener', { ownerId: l.ownerId, idx: l.idx }); this.refreshSide(true); } catch (e) { toast(errMsg(e)); }
              }
            }, 'Remove'));
          }
          wrap.append(h('div', { class: 'listener' }, meta, h('div', { class: 'lsrc' }, l.src)));
        });
      });
      this.setSide(wrap, token);
    },
    async renderProperties(id, token) {
      const d = await page('nodeObject', { id });
      this.setSide(h('div', { style: { padding: '6px 8px 30px' } }, objectTree(d, { expand: true, block: true })), token);
    }
  };

  // ================================================================== Console
  const LEVEL_GROUP = { error: 'errors', warn: 'warnings', debug: 'verbose', log: 'info', info: 'info' };
  const Console = modules.console = {
    msgs: [], groupStack: [], errors: 0, warns: 0, filter: '', lastTop: null,
    levels: { verbose: false, info: true, warnings: true, errors: true },
    history: [], histPos: 0, draft: '', acItems: [], acIdx: -1,
    build(el) {
      try { this.history = JSON.parse(localStorage.getItem('dt-history') || '[]'); } catch (e) {}
      try { Object.assign(this.levels, JSON.parse(localStorage.getItem('dt-levels') || '{}')); } catch (e) {}
      this.histPos = this.history.length;
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      filter.addEventListener('input', debounce(() => { this.filter = filter.value.trim().toLowerCase(); this.applyFilter(); }, 120));
      this.levelsBtn = h('button', { class: 'tbtn', onclick: e => this.levelsMenu(e.currentTarget) });
      const preserve = h('input', { type: 'checkbox' });
      preserve.checked = Settings.preserveConsole;
      preserve.addEventListener('change', () => { Settings.preserveConsole = preserve.checked; saveSettings(); });
      this.preserveCb = preserve;
      this.countsEl = h('span', { class: 'dim', style: { paddingRight: '6px' } });
      const tb = h('div', { class: 'ptb' },
        h('button', { class: 'ibtn', title: 'Clear console (⌘K)', onclick: () => this.clear() }, h('svg', null)),
        filter, this.levelsBtn,
        h('label', { class: 'chk' }, preserve, 'Preserve log'),
        this.countsEl);
      tb.firstChild.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 15L15 5" stroke="currentColor" stroke-width="1.6"/></svg>';
      this.list = h('div', { class: 'console-msgs' });
      this.input = h('textarea', { rows: 1, placeholder: 'Type JavaScript and press Enter', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'go' });
      this.ac = h('div', { class: 'ac-list', hidden: true });
      const run = h('button', { class: 'run', title: 'Run', onclick: () => this.submit() }, '▶');
      const prompt = h('div', { class: 'cprompt' }, h('span', { class: 'cprompt-caret' }, '›'), this.input, run);
      el.append(tb, h('div', { class: 'console-wrap' }, this.list, this.ac, prompt));
      this.bindInput();
      this.updateLevelsBtn();
      this.updateCounts();
    },
    onShow() {
      if (this.stickToBottom !== false) this.scrollBottom();
    },
    levelsMenu(anchor) {
      const t = k => () => { this.levels[k] = !this.levels[k]; try { localStorage.setItem('dt-levels', JSON.stringify(this.levels)); } catch (e) {} this.updateLevelsBtn(); this.applyFilter(); };
      menuAt(anchor, [
        { label: 'Verbose', checked: this.levels.verbose, action: t('verbose') },
        { label: 'Info', checked: this.levels.info, action: t('info') },
        { label: 'Warnings', checked: this.levels.warnings, action: t('warnings') },
        { label: 'Errors', checked: this.levels.errors, action: t('errors') }
      ]);
    },
    updateLevelsBtn() {
      const l = this.levels;
      let label = 'Custom levels';
      if (l.info && l.warnings && l.errors) label = l.verbose ? 'All levels' : 'Default levels';
      else if (!l.verbose && !l.info && !l.warnings && l.errors) label = 'Errors only';
      else if (!l.verbose && !l.info && !l.warnings && !l.errors) label = 'Hide all';
      this.levelsBtn.textContent = label + ' ▾';
    },
    bindInput() {
      const inp = this.input;
      const autosize = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px'; };
      this.autosize = autosize;
      inp.addEventListener('input', () => { autosize(); this.updateAc(); });
      inp.addEventListener('keydown', e => {
        const acOpen = !this.ac.hidden && this.acItems.length;
        if (acOpen) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.acIdx = (this.acIdx + (e.key === 'ArrowDown' ? 1 : -1) + this.acItems.length) % this.acItems.length;
            this.renderAc();
            return;
          }
          if (e.key === 'Tab' || (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length) || (e.key === 'Enter' && this.acIdx >= 0)) {
            e.preventDefault();
            this.acceptAc(this.acItems[Math.max(0, this.acIdx)]);
            return;
          }
          if (e.key === 'Escape') { e.preventDefault(); this.hideAc(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); return; }
        if (e.key === 'ArrowUp' && !inp.value.slice(0, inp.selectionStart).includes('\n')) {
          if (this.histPos > 0) {
            e.preventDefault();
            if (this.histPos === this.history.length) this.draft = inp.value;
            this.histPos--;
            inp.value = this.history[this.histPos];
            autosize();
          }
          return;
        }
        if (e.key === 'ArrowDown' && !inp.value.slice(inp.selectionEnd).includes('\n')) {
          if (this.histPos < this.history.length) {
            e.preventDefault();
            this.histPos++;
            inp.value = this.histPos === this.history.length ? this.draft : this.history[this.histPos];
            autosize();
          }
          return;
        }
        if ((e.key === 'k' && e.metaKey) || (e.key === 'l' && e.ctrlKey)) { e.preventDefault(); this.clear(); }
      });
      inp.addEventListener('blur', () => setTimeout(() => this.hideAc(), 200));
    },
    setInput(text) {
      this.input.value = text;
      this.autosize();
      this.input.focus();
    },
    submit() {
      const code = this.input.value;
      if (!code.trim()) return;
      this.input.value = '';
      this.autosize();
      this.hideAc();
      this.run(code);
    },
    updateAc: debounce(async function () {
      const inp = this.input;
      const v = inp.value;
      const pos = inp.selectionStart;
      if (pos !== inp.selectionEnd) { this.hideAc(); return; }
      const before = v.slice(0, pos);
      const quotes = (before.match(/["'`]/g) || []).length;
      const m = before.match(/((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)?$/);
      if (quotes % 2 || !m || (!m[1] && !m[2]) || /[\w$]$/.test(before.slice(0, before.length - m[0].length)) && !m[1]) { this.hideAc(); return; }
      const path = m[1] ? m[1].slice(0, -1) : '';
      const prefix = m[2] || '';
      if (!path && prefix.length < 1) { this.hideAc(); return; }
      let list;
      try { list = await page('complete', { path, prefix }); } catch (e) { this.hideAc(); return; }
      if (inp.value !== v) return;
      this.acItems = list;
      this.acPrefix = prefix;
      this.acIdx = -1;
      if (!list.length) { this.hideAc(); return; }
      this.renderAc();
    }, 120),
    renderAc() {
      clearEl(this.ac);
      this.acItems.forEach((it, i) => {
        const p = this.acPrefix;
        const row = h('div', { class: 'ac-item' + (i === this.acIdx ? ' active' : '') });
        if (p && it.toLowerCase().startsWith(p.toLowerCase())) row.append(h('b', null, it.slice(0, p.length)), it.slice(p.length));
        else row.append(it);
        row.addEventListener('mousedown', e => { e.preventDefault(); this.acceptAc(it); });
        row.addEventListener('touchend', e => { e.preventDefault(); this.acceptAc(it); });
        this.ac.append(row);
      });
      this.ac.hidden = false;
      const act = this.ac.querySelector('.active');
      if (act) act.scrollIntoView({ block: 'nearest' });
    },
    hideAc() { this.ac.hidden = true; this.acItems = []; this.acIdx = -1; },
    acceptAc(item) {
      const inp = this.input;
      const pos = inp.selectionStart;
      const start = pos - (this.acPrefix || '').length;
      inp.value = inp.value.slice(0, start) + item + inp.value.slice(pos);
      const np = start + item.length;
      inp.setSelectionRange(np, np);
      this.hideAc();
      inp.focus();
    },
    async run(code) {
      if (this.history[this.history.length - 1] !== code) this.history.push(code);
      if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
      this.histPos = this.history.length;
      this.draft = '';
      try { localStorage.setItem('dt-history', JSON.stringify(this.history)); } catch (e) {}
      this.add({ kind: 'input', text: code });
      this.forceBottom = true;
      try {
        const raw = await native('evaluate', { code });
        const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (res && res.exception) this.add({ level: 'error', exception: true, text: res.text, args: res.result ? [res.result] : [], stack: res.stack || [] });
        else this.add({ kind: 'result', value: res && res.result ? res.result : { t: 'undefined' } });
      } catch (e) {
        this.add({ level: 'error', text: errMsg(e) });
      }
    },
    atBottom() {
      const l = this.list;
      return l.scrollHeight - l.scrollTop - l.clientHeight < 30;
    },
    scrollBottom() { this.list.scrollTop = this.list.scrollHeight; },
    container() { return this.groupStack.length ? this.groupStack[this.groupStack.length - 1] : this.list; },
    signature(m) {
      if (m.kind || (m.method && m.method.startsWith('group')) || m.table) return null;
      try {
        return m.level + '|' + (m.text || '') + '|' + JSON.stringify((m.args || []).map(a => (a.t === 'object' || a.t === 'function') ? 'o' + a.id : a.t + ':' + a.v)) + '|' + (m.loc ? m.loc.url + ':' + m.loc.line : '');
      } catch (e) { return null; }
    },
    add(m) {
      if (m.method === 'groupEnd') { this.groupStack.pop(); return; }
      m.ts = m.ts || Date.now();
      const sig = this.signature(m);
      const last = this.lastTop;
      if (Settings.groupSimilar && sig && last && last.sig === sig && last.container === this.container() && last.el.isConnected) {
        last.count++;
        last.countEl.textContent = last.count;
        last.countEl.hidden = false;
        this.bump(m);
        return;
      }
      const stick = this.forceBottom || this.atBottom();
      this.forceBottom = false;
      const el = this.render(m);
      m.el = el;
      m.sig = sig;
      m.count = 1;
      const parent = this.container();
      m.container = parent;
      parent.append(el);
      if (m.method === 'group' || m.method === 'groupCollapsed') {
        const g = h('div', { class: 'cm-group' });
        g.hidden = m.method === 'groupCollapsed';
        el.classList.add('cm-group-head');
        const arrow = el.querySelector('.cm-icon');
        arrow.textContent = g.hidden ? '▸' : '▾';
        el.addEventListener('click', () => { g.hidden = !g.hidden; arrow.textContent = g.hidden ? '▸' : '▾'; });
        m.groupEl = g;
        parent.append(g);
        this.groupStack.push(g);
      }
      this.msgs.push(m);
      this.lastTop = m;
      this.bump(m);
      if (!this.visible(m)) el.hidden = true;
      if (this.msgs.length > 3000) {
        const old = this.msgs.shift();
        old.el.remove();
        if (old.groupEl) old.groupEl.remove();
      }
      if (stick && currentPanel === 'console') this.scrollBottom();
    },
    bump(m) {
      if (m.level === 'error') this.errors++;
      else if (m.level === 'warn') this.warns++;
      else return;
      this.updateCounts();
    },
    updateCounts() {
      const be = $('#badge-errors');
      const bw = $('#badge-warnings');
      be.hidden = !this.errors; be.textContent = this.errors;
      bw.hidden = !this.warns; bw.textContent = this.warns;
      if (this.countsEl) this.countsEl.textContent = (this.errors ? this.errors + ' errors ' : '') + (this.warns ? this.warns + ' warnings' : '');
    },
    visible(m) {
      if (!m.kind) {
        const g = LEVEL_GROUP[m.level] || 'info';
        if (!this.levels[g]) return false;
      }
      if (this.filter) {
        const t = (m.el.textContent || '').toLowerCase();
        if (!t.includes(this.filter)) return false;
      }
      return true;
    },
    applyFilter() { for (const m of this.msgs) m.el.hidden = !this.visible(m); },
    locLink(loc) {
      if (!loc || !loc.url) return null;
      const name = shortUrl(loc.url) + (loc.line ? ':' + loc.line : '');
      return h('a', { class: 'cm-loc', title: loc.url, onclick: e => { e.stopPropagation(); Sources.openUrl(loc.url, loc.line); } }, name);
    },
    stackEl(stack) {
      const box = h('div', { class: 'cm-stack' });
      for (const f of stack) {
        const line = h('div', null, '    at ' + (f.fn || '(anonymous)') + ' ');
        if (f.url) line.append('(', h('a', { onclick: e => { e.stopPropagation(); Sources.openUrl(f.url, f.line); } }, shortUrl(f.url) + ':' + f.line + ':' + f.col), ')');
        box.append(line);
      }
      return box;
    },
    formatArgs(args, target) {
      let i = 0;
      if (args.length && args[0].t === 'string' && args[0].v.includes('%')) {
        const fmt = args[0].v;
        i = 1;
        let cur = h('span');
        const re = /%([sdifoOc%])/g;
        let last = 0;
        let m;
        while ((m = re.exec(fmt))) {
          cur.append(fmt.slice(last, m.index));
          last = re.lastIndex;
          const c = m[1];
          if (c === '%') { cur.append('%'); continue; }
          if (c === 'c') {
            target.append(cur);
            cur = h('span');
            const css = i < args.length ? String(args[i++].v || '') : '';
            cur.style.cssText = css.replace(/url\s*\([^)]*\)/gi, '').replace(/position\s*:[^;]*/gi, '');
            continue;
          }
          if (i >= args.length) { cur.append(m[0]); continue; }
          const a = args[i++];
          if (c === 's') cur.append(a.t === 'string' ? a.v : inlineValue(a, { short: true }));
          else if (c === 'd' || c === 'i') cur.append(h('span', { class: 'v-num' }, String(parseInt(a.v, 10))));
          else if (c === 'f') cur.append(h('span', { class: 'v-num' }, String(parseFloat(a.v))));
          else cur.append(isExpandable(a) ? objectTree(a) : inlineValue(a));
        }
        cur.append(fmt.slice(last));
        target.append(cur);
      }
      for (; i < args.length; i++) {
        if (target.childNodes.length) target.append(' ');
        const a = args[i];
        if (a.t === 'object' && a.sub === 'error') target.append(this.errorEl(a));
        else target.append(isExpandable(a) ? objectTree(a, { top: true }) : inlineValue(a, { top: true }));
      }
    },
    errorEl(a) {
      const box = h('span', { class: 'v-err' }, a.desc);
      if (a.stack && a.stack.length) box.append(this.stackEl(a.stack));
      return box;
    },
    renderTable(t) {
      const table = h('table', { class: 'ctable' });
      const head = h('tr', null, h('th', null, '(index)'));
      t.cols.forEach(c => head.append(h('th', null, c === '\u0000value' ? 'Value' : c)));
      table.append(head);
      t.rows.forEach(r => {
        const tr = h('tr', null, h('td', null, r.index));
        t.cols.forEach(c => tr.append(h('td', null, r.cells[c] ? inlineValue(r.cells[c], { short: true }) : '')));
        table.append(tr);
      });
      return table;
    },
    render(m) {
      let cls = 'cm-' + (m.kind || m.level || 'log');
      if (m.kind === 'nav') cls = 'cm-nav';
      const row = h('div', { class: 'cm ' + cls });
      const icon = h('span', { class: 'cm-icon' });
      if (m.kind === 'input') icon.textContent = '›';
      else if (m.kind === 'result') icon.textContent = '‹';
      else if (m.level === 'error') icon.textContent = '✖︎';
      else if (m.level === 'warn') icon.textContent = '▲';
      else if (m.level === 'info') icon.textContent = 'ℹ︎';
      row.append(icon);
      const body = h('div', { class: 'cm-body' });
      if (m.kind === 'input') body.innerHTML = hlJS(m.text);
      else if (m.kind === 'result') body.append(isExpandable(m.value) ? objectTree(m.value) : (m.value.sub === 'error' ? this.errorEl(m.value) : inlineValue(m.value)));
      else if (m.kind === 'nav') body.append('Navigated to ', h('span', null, m.url));
      else if (m.kind === 'note') body.append(h('i', { class: 'dim' }, m.text));
      else if (m.table) body.append(this.renderTable(m.table));
      else if (m.method === 'dir' && m.args && m.args[0]) {
        const a = m.args[0];
        body.append(isExpandable(a) || a.sub === 'node' ? objectTree(Object.assign({}, a, a.sub === 'node' ? { sub: 'dirnode' } : {}), { expand: false }) : inlineValue(a));
      } else {
        if (m.text) body.append(m.text);
        if (m.args && m.args.length) this.formatArgs(m.args, body);
        if (m.stack && m.stack.length) {
          if (m.exception || m.method === 'trace') body.append(this.stackEl(m.stack));
          else {
            const st = this.stackEl(m.stack);
            st.hidden = true;
            const tg = h('span', { class: 'cm-stack-toggle dim' }, ' ▸');
            tg.addEventListener('click', e => { e.stopPropagation(); st.hidden = !st.hidden; tg.textContent = st.hidden ? ' ▸' : ' ▾'; });
            body.append(tg, st);
          }
        }
      }
      row.append(body);
      const meta = h('div', { class: 'cm-meta' });
      if (m.frame) meta.append(h('span', { class: 'cm-time', title: m.frame }, 'iframe: ' + shortUrl(m.frame)));
      const link = this.locLink(m.loc);
      if (link) meta.append(link);
      if (Settings.timestamps) meta.append(h('span', { class: 'cm-time' }, timeStr(m.ts)));
      if (meta.childNodes.length) row.append(meta);
      m.countEl = h('span', { class: 'cm-count', hidden: true });
      row.insertBefore(m.countEl, body);
      return row;
    },
    clear(silent) {
      clearEl(this.list);
      this.msgs = [];
      this.groupStack = [];
      this.lastTop = null;
      this.errors = 0;
      this.warns = 0;
      this.updateCounts();
      if (!silent) this.add({ kind: 'note', text: 'Console was cleared' });
    },
    onNavigate(url) {
      if (!Settings.preserveConsole) this.clear(true);
      else this.add({ kind: 'nav', url });
    }
  };

  // ================================================================== Sources
  const Sources = modules.sources = {
    files: [], current: null, pretty: false, loaded: false, matches: [], matchIdx: -1,
    build(el) {
      this.nav = h('div', { class: 'nav-tree' });
      const navTb = h('div', { class: 'ptb' }, h('b', { style: { padding: '0 6px' } }, 'Page'), h('span', { style: { flex: '1' } }), h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.refresh() }, '⟳'));
      const paneA = h('div', { class: 'pane-a', style: { display: 'flex', flexDirection: 'column', flexBasis: '34%' } }, navTb, h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, this.nav));
      this.fname = h('span', { class: 'fname mono' }, 'No file selected');
      this.prettyBtn = h('button', { class: 'ibtn', title: 'Pretty print', onclick: () => { this.pretty = !this.pretty; this.prettyBtn.classList.toggle('on', this.pretty); this.renderCode(); } }, '{ }');
      this.wrapBtn = h('button', { class: 'ibtn' + (Settings.wrapSources ? ' on' : ''), title: 'Line wrapping', onclick: () => { Settings.wrapSources = !Settings.wrapSources; saveSettings(); this.wrapBtn.classList.toggle('on', Settings.wrapSources); this.renderCode(); } }, '↩');
      this.findInput = h('input', { class: 'filter', type: 'search', placeholder: 'Find in file', style: { width: '120px' }, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      this.findInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.find(e.shiftKey ? -1 : 1); } });
      this.findInput.addEventListener('input', () => { this.matches = []; this.matchIdx = -1; this.findCount.textContent = ''; });
      this.findCount = h('span', { class: 'dim' });
      const head = h('div', { class: 'code-head' }, this.fname, this.findInput, this.findCount, this.prettyBtn, this.wrapBtn,
        h('button', { class: 'ibtn', title: 'More', onclick: e => this.fileMenu(e.currentTarget) }, '⋯'));
      this.gutter = h('pre', { class: 'gutter' });
      this.src = h('pre', { class: 'src', style: { position: 'relative' } });
      this.code = h('div', { class: 'code' }, this.gutter, this.src);
      const paneB = h('div', { class: 'pane-b' }, h('div', { class: 'code-wrap' }, head, this.code));
      el.append(h('div', { class: 'split stack' }, paneA, paneB));
      this.src.append(h('div', { class: 'empty' }, 'Select a file to view its source'));
    },
    onShow() { if (!this.loaded) this.refresh(); },
    reset() { this.loaded = false; this.files = []; this.current = null; clearEl(this.nav); },
    async refresh() {
      let res;
      try { res = await page('getResources'); } catch (e) { clearEl(this.nav); this.nav.append(h('div', { class: 'empty' }, errMsg(e))); return; }
      const files = [];
      const seen = new Set();
      const add = f => { const k = f.url || f.key; if (seen.has(k)) return; seen.add(k); files.push(f); };
      add({ key: 'doc', url: res.url, type: 'html', label: shortUrl(res.url) || '(index)', doc: true });
      let si = 0, ci = 0;
      res.scripts.forEach(s => {
        if (s.url) add({ key: s.url, url: s.url, type: 'js' });
        else if (!s.type || /javascript|module|json/.test(s.type)) add({ key: 'inline-script-' + s.inline, inline: { kind: 'script', index: s.inline }, type: s.type && /json/.test(s.type) ? 'json' : 'js', label: '(inline script ' + (++si) + ')', host: hostOf(res.url) });
      });
      res.styles.forEach(s => {
        if (s.url) add({ key: s.url, url: s.url, type: 'css' });
        else add({ key: 'inline-style-' + s.inline, inline: { kind: 'style', index: s.inline }, type: 'css', label: '(inline style ' + (++ci) + ')', host: hostOf(res.url) });
      });
      res.frames.forEach(f => add({ key: f.url, url: f.url, type: 'html' }));
      Network.all().forEach(r => {
        const t = guessType(r.url, r.mime);
        if (/^(data|blob):/.test(r.url)) return;
        if (t === 'js' || t === 'css' || t === 'img' || (t === 'html' && r.type === 'document')) add({ key: r.url, url: r.url, type: t });
      });
      this.files = files;
      this.loaded = true;
      this.renderNav(hostOf(res.url));
      if (this.current) {
        const again = files.find(f => f.key === this.current.key);
        if (again) again.text = this.current.text;
      }
    },
    renderNav(mainHost) {
      clearEl(this.nav);
      const groups = new Map();
      for (const f of this.files) {
        const host = f.host || hostOf(f.url) || '(no domain)';
        if (!groups.has(host)) groups.set(host, []);
        groups.get(host).push(f);
      }
      const hosts = Array.from(groups.keys()).sort((a, b) => (a === mainHost ? -1 : b === mainHost ? 1 : a < b ? -1 : 1));
      this.nav.append(h('div', { class: 'nav-group' }, '▾ ', h('span', null, '⬚ top')));
      for (const host of hosts) {
        this.nav.append(h('div', { class: 'nav-group', style: { paddingLeft: '20px' } }, '☁ ', host));
        for (const f of groups.get(host)) {
          let label = f.label;
          if (!label) { try { const u = new URL(f.url); label = decodeURIComponent(u.pathname + u.search) || '/'; } catch (e) { label = f.url; } }
          const item = h('div', { class: 'nav-item' + (this.current && this.current.key === f.key ? ' active' : ''), title: f.url || label, style: { paddingLeft: '36px' } }, fileIcon(f.type), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label));
          item.addEventListener('click', () => this.open(f));
          f.navEl = item;
          this.nav.append(item);
        }
      }
    },
    async open(f, line) {
      this.current = f;
      this.files.forEach(x => x.navEl && x.navEl.classList.toggle('active', x === f));
      this.fname.textContent = f.url || f.label;
      this.fname.title = f.url || f.label;
      this.matches = []; this.matchIdx = -1; this.findCount.textContent = '';
      if (f.type === 'img') {
        clearEl(this.gutter); clearEl(this.src);
        this.src.append(h('div', { style: { padding: '12px' } }, h('img', { src: f.url, style: { maxWidth: '100%', background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 16px 16px' } })));
        return;
      }
      if (f.text === undefined) {
        clearEl(this.gutter); clearEl(this.src);
        this.src.append(h('div', { class: 'empty' }, 'Loading…'));
        try {
          if (f.inline) f.text = await page('getInlineSource', f.inline);
          else {
            try {
              const r = await native('fetchSource', { url: f.url });
              f.text = r.text;
              if (r.mime) f.type = guessType(f.url, r.mime) === 'other' ? f.type : guessType(f.url, r.mime);
            } catch (e) {
              if (f.doc) f.text = await page('documentHTML');
              else throw e;
            }
          }
        } catch (e) {
          if (this.current !== f) return;
          clearEl(this.src);
          this.src.append(h('div', { class: 'empty' }, 'Could not load the content for ' + (f.url || f.label) + ': ' + errMsg(e)));
          return;
        }
      }
      if (this.current !== f) return;
      const lines = f.text.split('\n');
      const avg = f.text.length / Math.max(1, lines.length);
      this.pretty = !line && (f.type === 'js' || f.type === 'css') && avg > 250 && f.text.length > 2000;
      this.prettyBtn.classList.toggle('on', this.pretty);
      this.renderCode(line);
    },
    displayText() {
      const f = this.current;
      if (!f || f.text === undefined) return '';
      if (!this.pretty) return f.text;
      if (f.prettyText === undefined) {
        try { f.prettyText = f.type === 'css' ? prettyCSS(f.text) : (f.type === 'js' || f.type === 'json') ? prettyJS(f.text) : f.text; } catch (e) { f.prettyText = f.text; }
      }
      return f.prettyText;
    },
    renderCode(line) {
      const f = this.current;
      if (!f || f.text === undefined || f.type === 'img') return;
      const text = this.displayText();
      const count = text.split('\n').length;
      const wrap = Settings.wrapSources;
      this.gutter.hidden = wrap;
      this.src.classList.toggle('wrap', wrap);
      if (!wrap) {
        let g = '';
        for (let i = 1; i <= count; i++) g += i + '\n';
        this.gutter.textContent = g;
      }
      this.src.innerHTML = text.length < 800000 ? highlight(text, f.type) : esc(text);
      if (line) this.revealLine(line);
      else { this.code.scrollTop = 0; this.code.scrollLeft = 0; }
    },
    revealLine(line) {
      let bar = this.src.querySelector('.line-hl');
      if (!bar) {
        bar = h('div', { class: 'line-hl', style: { position: 'absolute', left: '0', right: '0', height: '17px', background: 'var(--warn-bg)', opacity: '.8', pointerEvents: 'none', zIndex: '-1' } });
        this.src.append(bar);
      }
      bar.style.top = (4 + (line - 1) * 17) + 'px';
      bar.style.width = this.src.scrollWidth + 'px';
      this.code.scrollTop = Math.max(0, (line - 1) * 17 - this.code.clientHeight / 3);
    },
    find(dir) {
      const q = this.findInput.value;
      if (!q || !this.current || this.current.text === undefined) return;
      if (!this.matches.length) {
        const lines = this.displayText().split('\n');
        const lq = q.toLowerCase();
        lines.forEach((l, i) => { if (l.toLowerCase().includes(lq)) this.matches.push(i + 1); });
        this.matchIdx = -1;
      }
      if (!this.matches.length) { this.findCount.textContent = '0'; return; }
      this.matchIdx = (this.matchIdx + dir + this.matches.length) % this.matches.length;
      this.findCount.textContent = (this.matchIdx + 1) + '/' + this.matches.length;
      this.revealLine(this.matches[this.matchIdx]);
    },
    fileMenu(anchor) {
      const f = this.current;
      if (!f) return;
      menuAt(anchor, [
        { label: 'Copy content', action: () => copyText(this.displayText()) },
        f.url ? { label: 'Copy link address', action: () => copyText(f.url) } : null,
        f.url ? { label: 'Open in browser tab', action: () => native('navigate', { url: f.url }) } : null,
        { label: 'Reload file', action: () => { f.text = undefined; f.prettyText = undefined; this.open(f); } }
      ]);
    },
    async openUrl(url, line) {
      showPanel('sources');
      if (!this.loaded) await this.refresh();
      let f = this.files.find(x => x.url === url);
      if (!f) {
        f = { key: url, url, type: guessType(url) === 'other' ? 'js' : guessType(url) };
        this.files.push(f);
        this.renderNav(hostOf(pageUrl));
      }
      await this.open(f, line);
    }
  };

  // ================================================================== Network
  const NET_TYPES = [['all', 'All'], ['xhr', 'Fetch/XHR'], ['doc', 'Doc'], ['css', 'CSS'], ['js', 'JS'], ['font', 'Font'], ['img', 'Img'], ['media', 'Media'], ['ws', 'WS'], ['other', 'Other']];
  const Network = modules.network = {
    reqs: new Map(), order: [], recording: true, filterText: '', filterType: 'all', selected: null, detailTab: 'headers',
    seq: 0, dcl: null, load: null, renderTimer: 0,
    build(el) {
      this.recBtn = h('button', { class: 'ibtn rec', title: 'Stop recording network log', onclick: () => { this.recording = !this.recording; this.recBtn.classList.toggle('rec', this.recording); this.recBtn.textContent = this.recording ? '●' : '○'; } }, '●');
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      filter.addEventListener('input', debounce(() => { this.filterText = filter.value.trim().toLowerCase(); this.render(); }, 150));
      const preserve = h('input', { type: 'checkbox' });
      preserve.checked = Settings.preserveNetwork;
      preserve.addEventListener('change', () => { Settings.preserveNetwork = preserve.checked; saveSettings(); });
      const types = h('div', { style: { display: 'flex', gap: '3px' } });
      NET_TYPES.forEach(([k, t]) => types.append(h('button', { class: 'tbtn' + (k === this.filterType ? ' on' : ''), 'data-k': k, onclick: () => { this.filterType = k; types.querySelectorAll('.tbtn').forEach(b => b.classList.toggle('on', b.dataset.k === k)); this.render(); } }, t)));
      const tb = h('div', { class: 'ptb' }, this.recBtn,
        h('button', { class: 'ibtn', title: 'Clear', onclick: () => this.clear() }, '⊘'),
        filter,
        h('label', { class: 'chk' }, preserve, 'Preserve log'),
        h('span', { class: 'sep' }),
        types,
        h('span', { class: 'sep' }),
        h('button', { class: 'ibtn', title: 'Export HAR', onclick: () => this.exportHar() }, '⇩'));
      this.tbody = h('tbody');
      this.tbody.addEventListener('click', e => { const tr = e.target.closest('tr'); if (tr) this.showDetail(tr.dataset.id); });
      const table = h('table', { class: 'grid' },
        h('colgroup', null, h('col', { style: { width: '42%' } }), h('col', { style: { width: '60px' } }), h('col', { class: 'col-type', style: { width: '70px' } }), h('col', { style: { width: '66px' } }), h('col', { style: { width: '62px' } }), h('col', { class: 'col-wf', style: { width: '22%' } })),
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Status'), h('th', { class: 'col-type' }, 'Type'), h('th', null, 'Size'), h('th', null, 'Time'), h('th', { class: 'col-wf' }, 'Waterfall'))),
        this.tbody);
      this.tableWrap = h('div', { class: 'net-table-wrap' }, table);
      this.footer = h('div', { class: 'net-footer' });
      this.detail = h('div', { class: 'net-detail', hidden: true });
      this.empty = h('div', { class: 'empty' }, 'Recording network activity… Perform a request or reload the page (F5) to record the reload.');
      this.tableWrap.append(this.empty);
      el.append(tb, h('div', { class: 'net-wrap' }, this.tableWrap, this.detail), this.footer);
      this.render();
    },
    onShow() { this.render(); },
    all() { return this.order.map(id => this.reqs.get(id)).filter(Boolean); },
    add(r) {
      if (!this.recording) return null;
      if (this.reqs.has(r.id)) return this.reqs.get(r.id);
      r.wall = r.wall || Date.now();
      this.reqs.set(r.id, r);
      this.order.push(r.id);
      if (this.order.length > 3000) { const old = this.order.shift(); this.reqs.delete(old); }
      this.schedule();
      return r;
    },
    update(id, patch) {
      const r = this.reqs.get(id);
      if (!r) return null;
      Object.assign(r, patch);
      this.schedule();
      if (this.selected === id && !this.detail.hidden) this.scheduleDetail();
      return r;
    },
    schedule() {
      if (this.renderTimer) return;
      this.renderTimer = setTimeout(() => { this.renderTimer = 0; if (currentPanel === 'network' && devtoolsVisible) this.render(); }, 200);
    },
    scheduleDetail: debounce(function () { this.renderDetail(); }, 200),
    clear() {
      this.reqs.clear(); this.order = []; this.selected = null; this.detail.hidden = true; this.dcl = null; this.load = null;
      this.render();
    },
    onNavigate() { if (!Settings.preserveNetwork) this.clear(); },
    category(r) {
      const t = r.type;
      if (t === 'fetch' || t === 'xhr' || t === 'xmlhttprequest' || t === 'beacon') return 'xhr';
      if (t === 'websocket') return 'ws';
      if (t === 'document' || t === 'iframe' || t === 'frame') return 'doc';
      const m = (r.mime || '').toLowerCase();
      const u = r.url.split(/[?#]/)[0].toLowerCase();
      if (t === 'css' || /text\/css/.test(m) || /\.css$/.test(u)) return 'css';
      if (t === 'script' || /javascript|ecmascript/.test(m) || /\.m?js$/.test(u)) return 'js';
      if (/font/.test(m) || /\.(woff2?|ttf|otf|eot)$/.test(u)) return 'font';
      if (t === 'img' || t === 'image' || /^image\//.test(m) || /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/.test(u)) return 'img';
      if (t === 'video' || t === 'audio' || /^(audio|video)\//.test(m) || /\.(mp4|webm|mp3|m3u8|ts|ogg|wav|m4a)$/.test(u)) return 'media';
      return 'other';
    },
    typeLabel(r) {
      if (r.type === 'fetch' || r.type === 'xhr' || r.type === 'document' || r.type === 'websocket') return r.type;
      const c = this.category(r);
      if (c === 'js') return 'script';
      if (c === 'css') return 'stylesheet';
      if (c === 'img') { const m = r.url.split(/[?#]/)[0].match(/\.(\w+)$/); return m ? m[1].toLowerCase() : (r.mime || 'image').replace('image/', ''); }
      if (c === 'font') return 'font';
      if (c === 'media') return 'media';
      return r.type || 'other';
    },
    filtered() {
      return this.all().filter(r => {
        if (this.filterType !== 'all' && this.category(r) !== this.filterType) return false;
        if (this.filterText && !r.url.toLowerCase().includes(this.filterText)) return false;
        return true;
      });
    },
    statusText(r) {
      if (r.failed) return '(failed)';
      if (r.status) return String(r.status);
      if (r.done) return r.type === 'websocket' ? 'closed' : 'finished';
      return '(pending)';
    },
    render() {
      if (!this.tbody) return;
      const rows = this.filtered();
      this.empty.hidden = this.order.length > 0;
      let t0 = Infinity, t1 = 0;
      for (const r of rows) { t0 = Math.min(t0, r.wall); t1 = Math.max(t1, r.wall + (r.time || 0)); }
      const span = Math.max(1, t1 - t0);
      let html = '';
      let transfer = 0, resources = 0;
      for (const r of rows) {
        transfer += r.transfer || 0;
        resources += r.size || 0;
        const bad = r.failed || r.status >= 400;
        const l = ((r.wall - t0) / span) * 100;
        const w = Math.max(0.6, ((r.time || 0) / span) * 100);
        const size = r.failed ? '' : r.cached ? '(cache)' : fmtBytes(r.transfer || r.size || 0);
        html += '<tr data-id="' + esc(r.id) + '" class="' + (r.id === this.selected ? 'sel ' : '') + (bad ? 'failed' : '') + '">' +
          '<td title="' + esc(r.url) + '">' + esc(shortUrl(r.url)) + (r.method && r.method !== 'GET' ? ' <span class="dim">' + esc(r.method) + '</span>' : '') + '</td>' +
          '<td>' + esc(this.statusText(r)) + '</td>' +
          '<td class="col-type">' + esc(this.typeLabel(r)) + '</td>' +
          '<td class="r">' + esc(size) + '</td>' +
          '<td class="r">' + esc(r.time !== undefined ? fmtMs(r.time) : (r.done ? '' : 'Pending')) + '</td>' +
          '<td class="col-wf"><div class="wf"><div class="wf-bar' + (r.done || r.time !== undefined ? '' : ' pending') + '" style="left:' + l.toFixed(2) + '%;width:' + Math.min(100 - l, w).toFixed(2) + '%"></div></div></td></tr>';
      }
      this.tbody.innerHTML = html;
      const finish = rows.length ? t1 - t0 : 0;
      const parts = [
        (rows.length === this.order.length ? rows.length : rows.length + ' / ' + this.order.length) + ' requests',
        fmtBytes(transfer) + ' transferred',
        fmtBytes(resources) + ' resources',
        'Finish: ' + fmtMs(finish)
      ];
      if (this.dcl) parts.push('DOMContentLoaded: ' + fmtMs(this.dcl));
      if (this.load) parts.push('Load: ' + fmtMs(this.load));
      clearEl(this.footer);
      parts.forEach((p, i) => this.footer.append(h('span', { style: i === 4 ? { color: '#1a73e8' } : i === 5 ? { color: '#d93025' } : null }, p)));
    },
    showDetail(id) {
      this.selected = id;
      this.tbody.querySelectorAll('tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.id === id));
      this.detail.hidden = false;
      this.renderDetail();
    },
    hideDetail() { this.detail.hidden = true; this.selected = null; this.render(); },
    renderDetail() {
      const r = this.reqs.get(this.selected);
      if (!r) { this.detail.hidden = true; return; }
      clearEl(this.detail);
      const tabs = [['headers', 'Headers']];
      if (r.reqBody || /\?/.test(r.url)) tabs.push(['payload', 'Payload']);
      if (r.type === 'websocket') tabs.push(['messages', 'Messages']);
      else tabs.push(['preview', 'Preview'], ['response', 'Response']);
      tabs.push(['timing', 'Timing']);
      if (!tabs.some(t => t[0] === this.detailTab)) this.detailTab = 'headers';
      const sub = h('div', { class: 'subtabs' });
      tabs.forEach(([k, t]) => sub.append(h('button', { class: 'subtab' + (k === this.detailTab ? ' active' : ''), onclick: () => { this.detailTab = k; this.renderDetail(); } }, t)));
      const head = h('div', { class: 'nd-head' }, h('button', { class: 'ibtn', title: 'Close', onclick: () => this.hideDetail() }, '✕'), sub,
        h('button', { class: 'ibtn', title: 'Copy', onclick: e => this.copyMenu(r, e.currentTarget) }, '⋯'));
      const body = h('div', { class: 'nd-body' });
      this.detail.append(head, body);
      const tab = this.detailTab;
      if (tab === 'headers') this.renderHeaders(r, body);
      else if (tab === 'payload') this.renderPayload(r, body);
      else if (tab === 'preview') this.renderPreview(r, body);
      else if (tab === 'response') this.renderResponse(r, body);
      else if (tab === 'messages') this.renderMessages(r, body);
      else this.renderTiming(r, body);
    },
    hdrSection(title, entries, open) {
      const d = h('details', { class: 'hdr-section', open: open !== false });
      d.append(h('summary', null, title + (entries.length ? ' (' + entries.length + ')' : '')));
      if (!entries.length) d.append(h('div', { class: 'hdr-row dim' }, h('span', null, 'None'), h('span')));
      entries.forEach(([k, v]) => d.append(h('div', { class: 'hdr-row' }, h('span', null, k), h('span', null, v))));
      return d;
    },
    renderHeaders(r, body) {
      const dot = r.failed || r.status >= 400 ? 'bad-dot' : r.status >= 300 ? 'warn-dot' : 'ok-dot';
      const general = [['Request URL', r.url], ['Request Method', r.method || 'GET']];
      const st = h('span', null, h('span', { class: 'status-dot ' + dot }), r.failed ? (r.error || 'Failed') : (r.status ? r.status + ' ' + (r.statusText || '') : this.statusText(r)));
      const sec = this.hdrSection('General', []);
      sec.lastChild.remove();
      general.forEach(([k, v]) => sec.append(h('div', { class: 'hdr-row' }, h('span', null, k), h('span', null, v))));
      sec.append(h('div', { class: 'hdr-row' }, h('span', null, 'Status Code'), st));
      if (r.protocol) sec.append(h('div', { class: 'hdr-row' }, h('span', null, 'Protocol'), h('span', null, r.protocol)));
      if (r.initiator) sec.append(h('div', { class: 'hdr-row' }, h('span', null, 'Initiator'), h('span', null, r.initiator)));
      body.append(sec);
      const sortH = o => Object.keys(o || {}).sort().map(k => [k, String(o[k])]);
      body.append(this.hdrSection('Response Headers', sortH(r.resHeaders)));
      body.append(this.hdrSection('Request Headers', sortH(r.reqHeaders)));
      if (!r.resHeaders && (r.type !== 'fetch' && r.type !== 'xhr' && r.type !== 'document')) {
        body.append(h('div', { class: 'empty' }, 'Headers are not available for resources loaded directly by the browser engine.'));
      }
    },
    renderPayload(r, body) {
      try {
        const u = new URL(r.url);
        const qs = Array.from(u.searchParams.entries());
        if (qs.length) body.append(this.hdrSection('Query String Parameters', qs));
      } catch (e) {}
      if (r.reqBody) {
        const d = h('details', { class: 'hdr-section', open: true }, h('summary', null, 'Request Payload'));
        let parsed;
        try { parsed = JSON.parse(r.reqBody); } catch (e) {}
        if (parsed !== undefined && typeof parsed === 'object') d.append(h('div', { style: { padding: '6px 10px' } }, localTree(parsed, null, true)));
        else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(r.reqBody)) {
          Array.from(new URLSearchParams(r.reqBody).entries()).forEach(([k, v]) => d.append(h('div', { class: 'hdr-row' }, h('span', null, k), h('span', null, v))));
        } else d.append(h('pre', { class: 'pre' }, r.reqBody));
        body.append(d);
      }
    },
    async ensureBody(r) {
      if (r.body !== undefined || r.type === 'websocket') return;
      if (!/^https?:/.test(r.url) || r.method && r.method !== 'GET') return;
      try {
        const res = await native('fetchSource', { url: r.url });
        r.body = res.text;
        r.bodyRefetched = true;
        if (!r.mime && res.mime) r.mime = res.mime;
      } catch (e) { r.bodyError = errMsg(e); }
    },
    async renderPreview(r, body) {
      const cat = this.category(r);
      if (cat === 'img') {
        body.append(h('div', { style: { padding: '12px', textAlign: 'center' } }, h('img', { src: r.url, style: { maxWidth: '100%', background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 16px 16px' } }), h('div', { class: 'dim', style: { marginTop: '6px' } }, fmtBytes(r.size || r.transfer))));
        return;
      }
      if (cat === 'font' || cat === 'media') { body.append(h('div', { class: 'empty' }, 'No preview available for this resource')); return; }
      body.append(h('div', { class: 'empty' }, 'Loading…'));
      await this.ensureBody(r);
      if (this.selected !== r.id || this.detailTab !== 'preview') return;
      clearEl(body);
      if (r.body === undefined) { body.append(h('div', { class: 'empty' }, r.bodyError ? 'Failed to load response data: ' + r.bodyError : 'This request has no response data available.')); return; }
      let parsed;
      try { parsed = JSON.parse(r.body); } catch (e) {}
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') { body.append(h('div', { style: { padding: '6px 10px' } }, localTree(parsed, null, true))); return; }
      const type = guessType(r.url, r.mime);
      const code = h('pre', { class: 'pre' });
      code.innerHTML = r.body.length < 400000 ? highlight(r.type === 'document' ? r.body : r.body, type === 'other' && r.type === 'document' ? 'html' : type) : esc(r.body);
      body.append(code);
    },
    async renderResponse(r, body) {
      body.append(h('div', { class: 'empty' }, 'Loading…'));
      await this.ensureBody(r);
      if (this.selected !== r.id || this.detailTab !== 'response') return;
      clearEl(body);
      if (r.body === undefined) { body.append(h('div', { class: 'empty' }, r.bodyError ? 'Failed to load response data: ' + r.bodyError : 'This request has no response data available.')); return; }
      if (r.bodyRefetched) body.append(h('div', { class: 'dim', style: { padding: '4px 10px' } }, 'Content re-fetched by DevTools (resource was loaded by the browser engine).'));
      if (r.truncated) body.append(h('div', { class: 'dim', style: { padding: '4px 10px' } }, 'Response truncated to 2 MB.'));
      body.append(h('pre', { class: 'pre' }, r.body));
    },
    renderMessages(r, body) {
      const frames = r.frames || [];
      if (!frames.length) { body.append(h('div', { class: 'empty' }, 'No messages yet')); return; }
      frames.forEach(f => body.append(h('div', { class: 'ws-frame ' + f.dir }, h('span', { class: 'wdir' }, f.dir === 'out' ? '↑' : f.dir === 'in' ? '↓' : '■'), h('span', { class: 'wdata' }, f.data), h('span', { class: 'wtime' }, timeStr(f.t)))));
    },
    renderTiming(r, body) {
      const kv = h('div', { class: 'kv' });
      const add = (k, v) => kv.append(h('div', null, k), h('div', null, v));
      add('Started at', timeStr(r.wall));
      add('Duration', r.time !== undefined ? fmtMs(r.time) : 'Pending');
      if (r.ttfb !== undefined) add('Waiting (TTFB)', fmtMs(r.ttfb));
      if (r.transfer) add('Transferred', fmtBytes(r.transfer));
      if (r.size) add('Resource size', fmtBytes(r.size));
      if (r.protocol) add('Protocol', r.protocol);
      body.append(kv);
      const all = this.all();
      if (all.length) {
        const t0 = Math.min(...all.map(x => x.wall));
        const t1 = Math.max(...all.map(x => x.wall + (x.time || 0)));
        const span = Math.max(1, t1 - t0);
        const tl = h('div', { class: 'timeline' }, h('div', { style: { left: ((r.wall - t0) / span * 100) + '%', width: Math.max(0.5, (r.time || 0) / span * 100) + '%', background: '#4285f4', borderRadius: '3px' } }));
        body.append(h('div', { class: 'dim', style: { padding: '8px 10px 0' } }, 'Position in page waterfall'), tl);
      }
    },
    curl(r) {
      const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
      let s = 'curl ' + q(r.url);
      if (r.method && r.method !== 'GET') s += ' \\\n  -X ' + r.method;
      Object.keys(r.reqHeaders || {}).forEach(k => { s += ' \\\n  -H ' + q(k + ': ' + r.reqHeaders[k]); });
      if (r.reqBody) s += ' \\\n  --data-raw ' + q(r.reqBody);
      return s;
    },
    fetchCode(r) {
      const opts = { method: r.method || 'GET', headers: r.reqHeaders || {} };
      if (r.reqBody) opts.body = r.reqBody;
      return 'fetch(' + JSON.stringify(r.url) + ', ' + JSON.stringify(opts, null, 2) + ');';
    },
    copyMenu(r, anchor) {
      menuAt(anchor, [
        { label: 'Copy URL', action: () => copyText(r.url) },
        { label: 'Copy as cURL', action: () => copyText(this.curl(r)) },
        { label: 'Copy as fetch', action: () => copyText(this.fetchCode(r)) },
        { label: 'Copy response', action: async () => { await this.ensureBody(r); copyText(r.body || ''); } },
        { label: 'Copy response headers', action: () => copyText(Object.keys(r.resHeaders || {}).map(k => k + ': ' + r.resHeaders[k]).join('\n')) },
        '-',
        { label: 'Open in Sources panel', action: () => Sources.openUrl(r.url) },
        { label: 'Open in new page', action: () => native('navigate', { url: r.url }) },
        { label: 'Replay XHR', action: () => this.replay(r) }
      ]);
    },
    replay(r) {
      const code = this.fetchCode(r);
      native('evaluate', { code }).then(() => toast('Request sent')).catch(e => toast(errMsg(e)));
    },
    exportHar() {
      const entries = this.all().map(r => ({
        startedDateTime: new Date(r.wall).toISOString(),
        time: r.time || 0,
        request: { method: r.method || 'GET', url: r.url, httpVersion: r.protocol || '', headers: Object.keys(r.reqHeaders || {}).map(k => ({ name: k, value: String(r.reqHeaders[k]) })), queryString: [], cookies: [], headersSize: -1, bodySize: r.reqBody ? r.reqBody.length : 0, postData: r.reqBody ? { mimeType: '', text: r.reqBody } : undefined },
        response: { status: r.status || 0, statusText: r.statusText || '', httpVersion: r.protocol || '', headers: Object.keys(r.resHeaders || {}).map(k => ({ name: k, value: String(r.resHeaders[k]) })), cookies: [], content: { size: r.size || 0, mimeType: r.mime || '', text: r.body }, redirectURL: '', headersSize: -1, bodySize: r.transfer || -1 },
        cache: {}, timings: { send: 0, wait: r.time || 0, receive: 0 }
      }));
      copyText(JSON.stringify({ log: { version: '1.2', creator: { name: 'iOS DevTools', version: '1.0' }, pages: [], entries } }, null, 2));
    },
    // ---- events
    onStart(d) { this.add({ id: d.id, url: d.url, method: d.method, type: d.type, reqHeaders: d.reqHeaders, reqBody: d.reqBody, wall: d.wall }); },
    onResponse(d) {
      const r = this.update(d.id, { status: d.status, statusText: d.statusText, resHeaders: d.headers, mime: d.mime, ttfb: d.time, time: d.time });
      if (r && Settings.logXhr && (r.type === 'fetch' || r.type === 'xhr')) {
        Console.add({ level: 'info', text: (r.type === 'fetch' ? 'Fetch' : 'XHR') + ' finished loading: ' + r.method + ' "' + r.url + '".' });
      }
      if (r && d.status >= 400) Console.add({ level: 'error', text: 'Failed to load resource: the server responded with a status of ' + d.status + ' (' + (d.statusText || '') + ')', loc: { url: r.url, line: 0 } });
    },
    onBody(d) { this.update(d.id, { body: d.body, size: d.size, transfer: d.size, time: d.time, done: true, truncated: d.truncated }); },
    onDone(d) {
      const r = this.reqs.get(d.id);
      if (!r) return;
      this.update(d.id, { done: true, time: d.time !== undefined ? d.time : r.time, size: d.size || r.size, transfer: d.size || r.transfer });
    },
    onFail(d) {
      const r = this.update(d.id, { failed: true, error: d.error, done: true, time: d.time });
      if (r && r.type !== 'websocket') Console.add({ level: 'error', text: (r.type === 'fetch' ? 'Fetch' : 'XHR') + ' failed: ' + r.method + ' ' + r.url + ' — ' + d.error });
    },
    onResource(d) {
      if (!this.recording) return;
      const known = this.all().find(r => r.type === 'document' && r.url === d.url);
      if (known) return;
      this.add({ id: 'r' + (++this.seq), url: d.url, method: 'GET', type: d.type, wall: d.wall, time: d.duration, transfer: d.transfer, size: d.decoded || d.encoded, status: d.status || 0, done: true, protocol: d.protocol, cached: d.transfer === 0 && d.decoded > 0 && d.encoded > 0 });
    },
    onResourceError(d) {
      const r = this.all().reverse().find(x => x.url === d.url && !x.failed);
      if (r) this.update(r.id, { failed: true, error: 'net::ERR_FAILED' });
      else this.add({ id: 'r' + (++this.seq), url: d.url, method: 'GET', type: d.type, wall: d.wall, failed: true, done: true, error: 'net::ERR_FAILED' });
    },
    onWsFrame(d) {
      const r = this.reqs.get(d.id);
      if (!r) return;
      (r.frames = r.frames || []).push(d);
      if (r.frames.length > 2000) r.frames.shift();
      if (d.dir === 'close') r.done = true;
      if (this.selected === d.id && this.detailTab === 'messages') this.scheduleDetail();
    },
    onDocument(d) {
      this.add({ id: d.id, url: d.url, method: 'GET', type: d.mainFrame ? 'document' : 'iframe', status: d.status, statusText: d.statusText, resHeaders: d.headers, mime: d.mime, wall: Date.now(), done: true, initiator: 'Navigation' });
    },
    onLoad(d) {
      if (!d || !d.nav) return;
      this.dcl = d.nav.dcl;
      this.load = d.nav.load;
      const doc = this.all().reverse().find(r => (r.type === 'document') && r.url === d.url) || this.all().reverse().find(r => r.type === 'document');
      if (doc) this.update(doc.id, { wall: d.nav.wall, time: d.nav.duration, transfer: d.nav.transfer, size: d.nav.decoded, protocol: d.nav.protocol });
      this.schedule();
    }
  };

  // ================================================================== Performance
  const Perf = modules.performance = {
    build(el) {
      this.recBtn = h('button', { class: 'tbtn', onclick: () => this.record(5000) }, '● Record 5 s');
      const tb = h('div', { class: 'ptb' }, this.recBtn,
        h('button', { class: 'tbtn', onclick: () => this.reloadAndRecord() }, '⟳ Reload & record'),
        h('button', { class: 'ibtn', title: 'Refresh metrics', onclick: () => this.loadMetrics() }, '⟳'));
      this.body = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0', paddingBottom: '30px' } });
      this.metrics = h('div');
      this.recording = h('div');
      this.body.append(this.recording, this.metrics);
      el.append(tb, this.body);
    },
    onShow() { this.loadMetrics(); },
    vital(label, value, fmt, good, poor, sub) {
      const cls = value === null || value === undefined || good === null ? '' : value <= good ? 'good' : value >= poor ? 'poor' : 'mid';
      return h('div', { class: 'card ' + cls }, h('div', { class: 'cl' }, label), h('div', { class: 'cv' }, value === null || value === undefined ? '–' : fmt(value)), sub ? h('div', { class: 'cs' }, sub) : null);
    },
    async loadMetrics() {
      let m;
      try { m = await page('perfMetrics'); } catch (e) { clearEl(this.metrics); this.metrics.append(h('div', { class: 'empty' }, errMsg(e))); return; }
      clearEl(this.metrics);
      const fcp = (m.paints.find(p => p.name === 'first-contentful-paint') || {}).t;
      const fp = (m.paints.find(p => p.name === 'first-paint') || {}).t;
      const n = m.nav || {};
      this.metrics.append(h('div', { class: 'section-title' }, 'Page load (Web Vitals)'));
      this.metrics.append(h('div', { class: 'cards' },
        this.vital('Time to First Byte', n.ttfb, fmtMs, 800, 1800),
        this.vital('First Contentful Paint', fcp, fmtMs, 1800, 3000, fp ? 'First paint ' + fmtMs(fp) : null),
        this.vital('Largest Contentful Paint', m.lcp, fmtMs, 2500, 4000, m.lcp === null ? 'Not supported by this engine' : null),
        this.vital('Cumulative Layout Shift', m.cls, v => v.toFixed(3), 0.1, 0.25),
        this.vital('DOMContentLoaded', n.dcl, fmtMs, 2000, 4000),
        this.vital('Load', n.load, fmtMs, 3000, 6000),
        this.vital('DOM elements', m.domNodes, v => v.toLocaleString(), 1500, 3000),
        this.vital('Requests', m.resourceCount + 1, v => String(v), 50, 150)
      ));
      if (m.nav) {
        const segs = [['Redirect', n.redirect, '#9aa0a6'], ['DNS', n.dns, '#00bcd4'], ['TCP', n.tcp - (n.tls || 0), '#ff9800'], ['TLS', n.tls, '#9c27b0'], ['Request', n.request, '#4caf50'], ['Response', n.download, '#2196f3'], ['DOM processing', Math.max(0, (n.dcl || 0) - (n.ttfb || 0) - (n.download || 0)), '#ffc107'], ['Load event', Math.max(0, (n.load || 0) - (n.dcl || 0)), '#e91e63']];
        const total = segs.reduce((s, x) => s + Math.max(0, x[1] || 0), 0) || 1;
        const tl = h('div', { class: 'timeline' });
        let left = 0;
        segs.forEach(([name, v, c]) => {
          v = Math.max(0, v || 0);
          if (!v) return;
          tl.append(h('div', { title: name + ': ' + fmtMs(v), style: { left: (left / total * 100) + '%', width: (v / total * 100) + '%', background: c } }));
          left += v;
        });
        const legend = h('div', { class: 'legend' });
        segs.forEach(([name, v, c]) => legend.append(h('span', null, h('i', { style: { background: c } }), name + ' ' + fmtMs(Math.max(0, v || 0)))));
        this.metrics.append(h('div', { class: 'section-title' }, 'Navigation timing' + (n.protocol ? ' · ' + n.protocol : '') + (n.type ? ' · ' + n.type : '')), tl, legend);
      }
      const types = Object.entries(m.resources).sort((a, b) => b[1].transfer - a[1].transfer);
      if (types.length) {
        const max = Math.max(...types.map(t => t[1].transfer), 1);
        const bars = h('div', { class: 'bars' });
        types.forEach(([k, v]) => bars.append(h('div', { class: 'bar-row' }, h('span', null, k + ' (' + v.count + ')'), h('div', { class: 'bar' }, h('div', { style: { width: (v.transfer / max * 100) + '%' } })), h('span', { class: 'bv' }, fmtBytes(v.transfer)))));
        this.metrics.append(h('div', { class: 'section-title' }, 'Resources by type'), bars);
      }
    },
    async reloadAndRecord() {
      native('reload', {}).catch(() => {});
      setTimeout(() => this.record(6000), 400);
    },
    async record(ms) {
      if (this.busy) return;
      this.busy = true;
      this.recBtn.classList.add('on');
      this.recBtn.textContent = '■ Recording…';
      clearEl(this.recording);
      const bar = h('div');
      this.recording.append(h('div', { class: 'section-title' }, 'Recording'), h('div', { class: 'progress', style: { margin: '10px' } }, bar));
      requestAnimationFrame(() => { bar.style.transition = 'width ' + ms + 'ms linear'; bar.style.width = '100%'; });
      let r;
      try { r = await page('perfRecord', { ms }); }
      catch (e) { clearEl(this.recording); this.recording.append(h('div', { class: 'empty' }, errMsg(e))); this.done(); return; }
      this.done();
      this.renderRecording(r);
    },
    done() { this.busy = false; this.recBtn.classList.remove('on'); this.recBtn.textContent = '● Record 5 s'; },
    renderRecording(r) {
      clearEl(this.recording);
      const frames = r.frames;
      const dur = r.duration;
      const deltas = [];
      for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
      const bucket = 250;
      const fps = [];
      for (let t = 0; t < dur; t += bucket) {
        const c = frames.filter(f => f >= t && f < t + bucket).length;
        fps.push([t, c * (1000 / bucket)]);
      }
      const avg = frames.length / (dur / 1000);
      const dropped = deltas.filter(d => d > 25).reduce((s, d) => s + Math.round(d / 16.7) - 1, 0);
      const longest = deltas.length ? Math.max(...deltas) : 0;
      const longTasks = r.lags.filter(l => l[1] > 50);
      const tbt = longTasks.reduce((s, l) => s + (l[1] - 50), 0);
      const minFps = fps.length ? Math.min(...fps.map(f => f[1])) : 0;
      this.recording.append(h('div', { class: 'section-title' }, 'Recording · ' + (dur / 1000).toFixed(1) + ' s'));
      this.recording.append(h('div', { class: 'cards' },
        this.vital('Average FPS', avg, v => v.toFixed(1), null, null),
        this.vital('Min FPS (250 ms)', minFps, v => v.toFixed(0), null, null),
        this.vital('Dropped frames', dropped, v => String(v), 5, 30),
        this.vital('Longest frame', longest, fmtMs, 34, 100),
        this.vital('Long tasks (>50 ms)', longTasks.length, v => String(v), 0, 5),
        this.vital('Total blocking time', tbt, fmtMs, 200, 600)
      ));
      this.recording.querySelectorAll('.card').forEach((c, i) => { if (i < 2) c.classList.add(avg >= 50 ? 'good' : avg >= 30 ? 'mid' : 'poor'); });
      const canvas = h('canvas', { class: 'chart' });
      this.recording.append(canvas, h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: '#34a853' } }), 'Frames per second'), h('span', null, h('i', { style: { background: '#ea4335' } }), 'Main thread blocked (ms)')));
      requestAnimationFrame(() => this.drawChart(canvas, fps, r.lags, dur));
    },
    drawChart(canvas, fps, lags, dur) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = hgt * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const cs = getComputedStyle(document.documentElement);
      const grid = cs.getPropertyValue('--border').trim() || '#888';
      const txt = cs.getPropertyValue('--fg3').trim() || '#888';
      const pad = { l: 30, r: 8, t: 8, b: 18 };
      const W = w - pad.l - pad.r, H = hgt - pad.t - pad.b;
      const maxF = 70;
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = txt;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      [0, 30, 60].forEach(v => {
        const y = pad.t + H - v / maxF * H;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + W, y); ctx.stroke();
        ctx.fillText(String(v), 4, y + 3);
      });
      for (let s = 0; s <= dur / 1000; s++) ctx.fillText(s + 's', pad.l + (s * 1000 / dur) * W - 6, hgt - 4);
      ctx.fillStyle = 'rgba(234,67,53,.7)';
      lags.forEach(([t, l]) => {
        if (l < 4) return;
        const x = pad.l + t / dur * W;
        const bh = Math.min(H, l / 200 * H);
        ctx.fillRect(x - 1.5, pad.t + H - bh, 3, bh);
      });
      ctx.strokeStyle = '#34a853';
      ctx.lineWidth = 2;
      ctx.beginPath();
      fps.forEach(([t, f], i) => {
        const x = pad.l + (t + 125) / dur * W;
        const y = pad.t + H - Math.min(f, maxF) / maxF * H;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  };

  // ================================================================== Memory
  const Memory = modules.memory = {
    snapshots: [],
    build(el) {
      const tb = h('div', { class: 'ptb' },
        h('button', { class: 'tbtn', onclick: () => this.snapshot() }, '📷︎ Take snapshot'),
        h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.refresh() }, '⟳'),
        h('button', { class: 'ibtn', title: 'Clear snapshots', onclick: () => { this.snapshots = []; this.renderSnapshots(); } }, '⊘'));
      this.cards = h('div');
      this.snaps = h('div');
      el.append(tb, h('div', { class: 'scroll', style: { flex: '1', minHeight: '0', paddingBottom: '30px' } }, this.cards, this.snaps));
      this.renderSnapshots();
    },
    onShow() { this.refresh(); },
    card(label, value, sub) { return h('div', { class: 'card' }, h('div', { class: 'cl' }, label), h('div', { class: 'cv' }, value), sub ? h('div', { class: 'cs' }, sub) : null); },
    async refresh() {
      let s;
      try { s = await page('memoryStats'); } catch (e) { clearEl(this.cards); this.cards.append(h('div', { class: 'empty' }, errMsg(e))); return; }
      clearEl(this.cards);
      const heap = s.heap ? this.card('JS heap', fmtBytes(s.heap.used), 'of ' + fmtBytes(s.heap.total) + ' (limit ' + fmtBytes(s.heap.limit) + ')') : this.card('JS heap', 'n/a', 'WebKit does not expose heap size to pages');
      this.cards.append(h('div', { class: 'section-title' }, 'Memory & resources'), h('div', { class: 'cards' },
        heap,
        this.card('DOM nodes', s.domNodes.toLocaleString()),
        this.card('Event listeners', s.listeners.toLocaleString(), 'added via addEventListener'),
        this.card('Storage usage', s.storage ? fmtBytes(s.storage.usage) : '–', s.storage ? 'quota ' + fmtBytes(s.storage.quota) : 'StorageManager unavailable'),
        this.card('localStorage', fmtBytes(s.localStorage)),
        this.card('sessionStorage', fmtBytes(s.sessionStorage)),
        this.card('Resources downloaded', fmtBytes(s.resources)),
        this.card('Iframes', String(s.iframes)),
        this.card('Images', String(s.images)),
        this.card('Scripts', String(s.scripts)),
        this.card('Stylesheets', String(s.stylesheets)),
        this.card('Objects retained by DevTools', String(s.trackedObjects + s.trackedNodes))
      ));
    },
    async snapshot() {
      try {
        const s = await page('memoryStats');
        s.time = Date.now();
        this.snapshots.push(s);
        this.renderSnapshots();
        this.refresh();
      } catch (e) { toast(errMsg(e)); }
    },
    renderSnapshots() {
      clearEl(this.snaps);
      this.snaps.append(h('div', { class: 'section-title' }, 'Snapshots'));
      if (!this.snapshots.length) { this.snaps.append(h('div', { class: 'empty' }, 'Take snapshots to compare DOM size, listeners and storage over time.')); return; }
      const delta = (a, b) => { const d = a - b; return d === 0 ? '' : ' (' + (d > 0 ? '+' : '') + d.toLocaleString() + ')'; };
      const t = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Time'), h('th', null, 'DOM nodes'), h('th', null, 'Listeners'), h('th', null, 'Heap'), h('th', null, 'Storage'))));
      const tb = h('tbody');
      this.snapshots.forEach((s, i) => {
        const p = this.snapshots[i - 1] || s;
        tb.append(h('tr', null, h('td', null, 'Snapshot ' + (i + 1)), h('td', null, timeStr(s.time)), h('td', null, s.domNodes.toLocaleString() + delta(s.domNodes, p.domNodes)), h('td', null, s.listeners + delta(s.listeners, p.listeners)), h('td', null, s.heap ? fmtBytes(s.heap.used) : 'n/a'), h('td', null, s.storage ? fmtBytes(s.storage.usage) : '–')));
      });
      t.append(tb);
      this.snaps.append(t);
    }
  };

  // ================================================================== Application
  const App = modules.application = {
    cur: 'local', extra: null,
    build(el) {
      this.navEl = h('div', { class: 'app-nav' });
      this.view = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
      el.append(h('div', { class: 'split app-split' }, h('div', { class: 'pane-a scroll' }, this.navEl), h('div', { class: 'pane-b' }, this.view)));
    },
    onShow() { this.renderNav(); this.open(this.cur, this.extra); },
    renderNav() {
      clearEl(this.navEl);
      const origin = originOf(pageUrl) || 'page';
      const item = (key, label, sub, extra) => {
        const active = this.cur === key && (extra === undefined || JSON.stringify(extra) === JSON.stringify(this.extra));
        const el = h('div', { class: 'itm' + (sub ? ' sub' : '') + (active ? ' active' : '') }, label);
        el.addEventListener('click', () => { this.open(key, extra); this.renderNav(); });
        this.navEl.append(el);
      };
      this.navEl.append(h('div', { class: 'grp' }, 'Application'));
      item('manifest', '📄︎ Manifest');
      item('sw', '⚙︎ Service workers');
      item('storage', '▤ Storage');
      this.navEl.append(h('div', { class: 'grp' }, 'Storage'));
      item('local', '▦ Local storage');
      item('local', origin, true);
      item('session', '▦ Session storage');
      item('session', origin, true);
      item('idb', '▣ IndexedDB');
      item('cookies', '🍪︎ Cookies');
      item('cookies', origin, true);
      this.navEl.append(h('div', { class: 'grp' }, 'Cache'));
      item('cache', '▤ Cache storage');
    },
    toolbar(...kids) { return h('div', { class: 'ptb' }, ...kids); },
    setView(...kids) { clearEl(this.view); this.view.append(...kids); },
    async open(key, extra) {
      this.cur = key;
      this.extra = extra;
      this.setView(h('div', { class: 'empty' }, 'Loading…'));
      try {
        if (key === 'local' || key === 'session') await this.storageView(key);
        else if (key === 'cookies') await this.cookiesView();
        else if (key === 'idb') await this.idbView(extra);
        else if (key === 'cache') await this.cacheView(extra);
        else if (key === 'manifest') await this.manifestView();
        else if (key === 'sw') await this.swView();
        else await this.storageOverview();
      } catch (e) { this.setView(h('div', { class: 'empty' }, errMsg(e))); }
    },
    valuePreview(text) {
      const box = h('div', { class: 'value-preview' });
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) {}
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') box.append(h('div', { style: { padding: '6px 10px' } }, localTree(parsed, null, true)));
      else box.append(h('pre', { class: 'pre' }, text));
      return box;
    },
    async storageView(type) {
      const list = await page('storageList', { type });
      let filterText = '';
      let selected = null;
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter' });
      const tbody = h('tbody');
      const previewSlot = h('div');
      const draw = () => {
        clearEl(tbody);
        list.filter(([k, v]) => !filterText || k.toLowerCase().includes(filterText) || String(v).toLowerCase().includes(filterText)).forEach(([k, v]) => {
          const tr = h('tr', { class: selected === k ? 'sel' : '' }, h('td', { class: 'mono', title: k }, k), h('td', { class: 'mono val', title: v }, v),
            h('td', { style: { textAlign: 'center' } }, h('button', { class: 'del', title: 'Delete', onclick: async e => { e.stopPropagation(); await page('storageRemove', { type, key: k }); this.open(type); } }, '✕')));
          tr.addEventListener('click', () => { selected = k; draw(); clearEl(previewSlot); previewSlot.append(this.valuePreview(v)); });
          tr.addEventListener('dblclick', () => edit(k, v));
          onLongPress(tr, () => edit(k, v));
          tbody.append(tr);
        });
        if (!tbody.childNodes.length) tbody.append(h('tr', null, h('td', { colspan: 3, class: 'dim' }, list.length ? 'No matches' : 'Storage is empty')));
      };
      const edit = async (k, v) => {
        const r = await dialog({ title: k === undefined ? 'Add item' : 'Edit item', fields: [{ label: 'Key', value: k }, { label: 'Value', value: v, multiline: true, rows: 6 }] });
        if (!r || !r[0]) return;
        await page('storageSet', { type, key: r[0], value: r[1], oldKey: k });
        this.open(type);
      };
      filter.addEventListener('input', () => { filterText = filter.value.toLowerCase(); draw(); });
      const tb = this.toolbar(
        h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.open(type) }, '⟳'),
        filter,
        h('button', { class: 'ibtn', title: 'Add item', onclick: () => edit(undefined, '') }, '+'),
        h('button', { class: 'ibtn', title: 'Clear all', onclick: async () => { if (await confirmDialog('Clear all', 'Delete all ' + (type === 'local' ? 'localStorage' : 'sessionStorage') + ' items for this origin?', 'Clear')) { await page('storageClear', { type }); this.open(type); } } }, '⊘'),
        h('span', { class: 'dim' }, list.length + ' items · tap to preview, long-press to edit'));
      const table = h('table', { class: 'grid kvtable' }, h('colgroup', null, h('col', { style: { width: '35%' } }), h('col'), h('col', { style: { width: '34px' } })), h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Value'), h('th'))), tbody);
      draw();
      this.setView(tb, h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, table), previewSlot);
    },
    async cookiesView() {
      const list = await native('getCookies', {});
      let filterText = '';
      let selected = null;
      const filter = h('input', { class: 'filter', type: 'search', placeholder: 'Filter' });
      const tbody = h('tbody');
      const previewSlot = h('div');
      const cols = ['name', 'value', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'sameSite'];
      const draw = () => {
        clearEl(tbody);
        list.filter(c => !filterText || (c.name + ' ' + c.value + ' ' + c.domain).toLowerCase().includes(filterText)).forEach(c => {
          const key = c.name + '|' + c.domain + '|' + c.path;
          const tr = h('tr', { class: selected === key ? 'sel' : '' });
          cols.forEach(k => tr.append(h('td', { class: k === 'value' ? 'mono val' : k === 'name' ? 'mono' : '', title: String(c[k]) }, typeof c[k] === 'boolean' ? (c[k] ? '✓' : '') : String(c[k]))));
          tr.append(h('td', null, h('button', { class: 'del', title: 'Delete', onclick: async e => { e.stopPropagation(); await native('deleteCookie', c); this.open('cookies'); } }, '✕')));
          tr.addEventListener('click', () => { selected = key; draw(); clearEl(previewSlot); previewSlot.append(this.valuePreview(c.value)); });
          tr.addEventListener('dblclick', () => edit(c));
          onLongPress(tr, () => edit(c));
          tbody.append(tr);
        });
        if (!tbody.childNodes.length) tbody.append(h('tr', null, h('td', { colspan: cols.length + 1, class: 'dim' }, list.length ? 'No matches' : 'No cookies for this site')));
      };
      const edit = async c => {
        const host = hostOf(pageUrl);
        const r = await dialog({
          title: c ? 'Edit cookie' : 'Add cookie', fields: [
            { label: 'Name', value: c ? c.name : '' }, { label: 'Value', value: c ? c.value : '', multiline: true, rows: 3 },
            { label: 'Domain', value: c ? c.domain : host }, { label: 'Path', value: c ? c.path : '/' },
            { label: 'Expires in days (empty = session)', value: c && c.expires !== 'Session' ? String(Math.max(0, Math.round((new Date(c.expires) - Date.now()) / 864e5))) : '' }]
        });
        if (!r || !r[0]) return;
        try {
          if (c && (c.name !== r[0] || c.domain !== r[2] || c.path !== r[3])) await native('deleteCookie', c);
          await native('setCookie', { name: r[0], value: r[1], domain: r[2], path: r[3] || '/', days: r[4] ? parseFloat(r[4]) : null, secure: c ? c.secure : pageUrl.startsWith('https'), httpOnly: c ? c.httpOnly : false, sameSite: c ? c.sameSite : '' });
        } catch (e) { toast(errMsg(e)); }
        this.open('cookies');
      };
      filter.addEventListener('input', () => { filterText = filter.value.toLowerCase(); draw(); });
      const tb = this.toolbar(
        h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.open('cookies') }, '⟳'),
        filter,
        h('button', { class: 'ibtn', title: 'Add cookie', onclick: () => edit(null) }, '+'),
        h('button', { class: 'ibtn', title: 'Clear all cookies', onclick: async () => { if (await confirmDialog('Clear cookies', 'Delete all ' + list.length + ' cookies for this site?', 'Clear')) { for (const c of list) await native('deleteCookie', c); this.open('cookies'); } } }, '⊘'),
        h('span', { class: 'dim' }, list.length + ' cookies'));
      const table = h('table', { class: 'grid kvtable', style: { minWidth: '820px' } },
        h('colgroup', null, h('col', { style: { width: '14%' } }), h('col', { style: { width: '24%' } }), h('col', { style: { width: '14%' } }), h('col', { style: { width: '6%' } }), h('col', { style: { width: '14%' } }), h('col', { style: { width: '5%' } }), h('col', { style: { width: '6%' } }), h('col', { style: { width: '5%' } }), h('col', { style: { width: '7%' } }), h('col', { style: { width: '34px' } })),
        h('thead', null, h('tr', null, ...['Name', 'Value', 'Domain', 'Path', 'Expires', 'Size', 'HttpOnly', 'Secure', 'SameSite', ''].map(t => h('th', null, t)))), tbody);
      draw();
      this.setView(tb, h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, table), previewSlot);
    },
    async idbView(extra) {
      if (extra && extra.store) return this.idbStoreView(extra.db, extra.store);
      const res = await page('idbList');
      const box = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      if (res.unsupported) box.append(h('div', { class: 'empty' }, res.reason || 'IndexedDB is not available on this page'));
      else if (!res.dbs.length) box.append(h('div', { class: 'empty' }, 'No IndexedDB databases'));
      else res.dbs.forEach(db => {
        box.append(h('div', { class: 'section-title' }, db.name, h('span', { class: 'dim' }, '  v' + db.version),
          h('button', { class: 'btn danger', style: { float: 'right', height: '22px', fontSize: '11px' }, onclick: async () => { if (await confirmDialog('Delete database', 'Delete IndexedDB database "' + db.name + '"?', 'Delete')) { await page('idbDelete', { db: db.name }); this.open('idb'); } } }, 'Delete')));
        if (!db.stores.length) box.append(h('div', { class: 'dim', style: { padding: '6px 14px' } }, 'No object stores'));
        db.stores.forEach(s => box.append(h('div', { class: 'nav-item', onclick: () => this.open('idb', { db: db.name, store: s }) }, '▤ ', s)));
      });
      this.setView(this.toolbar(h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.open('idb') }, '⟳'), h('b', null, 'IndexedDB')), box);
    },
    async idbStoreView(db, store) {
      const info = await page('idbEntries', { db, store, limit: 200 });
      const tbody = h('tbody');
      const previewSlot = h('div');
      info.entries.forEach((e, i) => {
        const tr = h('tr', null, h('td', null, String(i)), h('td', { class: 'mono' }, inlineValue(e.key, { short: true })), h('td', { class: 'mono' }, inlineValue(e.value, { short: true })));
        tr.addEventListener('click', () => { tbody.querySelectorAll('tr').forEach(x => x.classList.remove('sel')); tr.classList.add('sel'); clearEl(previewSlot); previewSlot.append(h('div', { class: 'value-preview', style: { padding: '6px 10px' } }, objectTree(e.value, { expand: true, block: true }))); });
        tbody.append(tr);
      });
      if (!info.entries.length) tbody.append(h('tr', null, h('td', { colspan: 3, class: 'dim' }, 'Object store is empty')));
      const table = h('table', { class: 'grid' }, h('colgroup', null, h('col', { style: { width: '40px' } }), h('col', { style: { width: '30%' } }), h('col')), h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Key' + (info.keyPath ? ' (Key path: ' + info.keyPath + ')' : '')), h('th', null, 'Value'))), tbody);
      this.setView(this.toolbar(
        h('button', { class: 'ibtn', title: 'Back', onclick: () => this.open('idb') }, '‹'),
        h('button', { class: 'ibtn', title: 'Refresh', onclick: () => this.open('idb', { db, store }) }, '⟳'),
        h('button', { class: 'ibtn', title: 'Clear object store', onclick: async () => { if (await confirmDialog('Clear object store', 'Delete all entries in "' + store + '"?', 'Clear')) { await page('idbClear', { db, store }); this.open('idb', { db, store }); } } }, '⊘'),
        h('b', null, db + ' › ' + store), h('span', { class: 'dim' }, ' ' + info.total + ' entries' + (info.autoIncrement ? ' · autoIncrement' : '') + (info.indexes.length ? ' · indexes: ' + info.indexes.join(', ') : ''))),
      h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, table), previewSlot);
    },
    async cacheView(extra) {
      if (extra && extra.name) {
        const list = await page('cacheEntries', { name: extra.name });
        const tbody = h('tbody');
        list.forEach(e => tbody.append(h('tr', null, h('td', { title: e.url }, e.url), h('td', null, e.method), h('td', null, String(e.status)), h('td', null, e.type), h('td', null, h('button', { class: 'del', onclick: async () => { await page('cacheDelete', { name: extra.name, url: e.url }); this.open('cache', extra); } }, '✕')))));
        if (!list.length) tbody.append(h('tr', null, h('td', { colspan: 5, class: 'dim' }, 'Cache is empty')));
        this.setView(this.toolbar(h('button', { class: 'ibtn', onclick: () => this.open('cache') }, '‹'), h('button', { class: 'ibtn', onclick: () => this.open('cache', extra) }, '⟳'), h('b', null, extra.name)),
          h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } }, h('table', { class: 'grid' }, h('colgroup', null, h('col'), h('col', { style: { width: '60px' } }), h('col', { style: { width: '50px' } }), h('col', { style: { width: '22%' } }), h('col', { style: { width: '34px' } })), h('thead', null, h('tr', null, ...['Request', 'Method', 'Status', 'Content-Type', ''].map(t => h('th', null, t)))), tbody)));
        return;
      }
      const res = await page('cacheList');
      const box = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      if (res.unsupported) box.append(h('div', { class: 'empty' }, 'Cache Storage is not available on this page (requires a secure context)'));
      else if (!res.names.length) box.append(h('div', { class: 'empty' }, 'No caches'));
      else res.names.forEach(n => box.append(h('div', { class: 'nav-item', onclick: () => this.open('cache', { name: n }) }, '▤ ', n)));
      this.setView(this.toolbar(h('button', { class: 'ibtn', onclick: () => this.open('cache') }, '⟳'), h('b', null, 'Cache storage')), box);
    },
    async manifestView() {
      const url = await page('manifestUrl');
      const box = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      if (!url) box.append(h('div', { class: 'empty' }, 'No manifest detected. This page does not link a web app manifest.'));
      else {
        box.append(h('div', { class: 'section-title' }, 'App manifest'), h('div', { class: 'kv' }, h('div', null, 'URL'), h('div', null, h('a', { onclick: () => Sources.openUrl(url) }, url))));
        try {
          const r = await native('fetchSource', { url });
          const m = JSON.parse(r.text);
          const kv = h('div', { class: 'kv' });
          ['name', 'short_name', 'description', 'start_url', 'scope', 'display', 'orientation', 'theme_color', 'background_color', 'id'].forEach(k => {
            if (m[k] !== undefined) kv.append(h('div', null, k), h('div', null, isColor(String(m[k])) && /color/.test(k) ? h('span', { class: 'swatch', style: { background: m[k] } }) : null, String(m[k])));
          });
          box.append(h('div', { class: 'section-title' }, 'Identity & presentation'), kv);
          if (Array.isArray(m.icons) && m.icons.length) {
            const icons = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', padding: '10px' } });
            m.icons.forEach(i => { let src = i.src; try { src = new URL(i.src, url).href; } catch (e) {} icons.append(h('div', { style: { textAlign: 'center' } }, h('img', { src, style: { width: '56px', height: '56px', objectFit: 'contain', border: '1px solid var(--border)', borderRadius: '8px' } }), h('div', { class: 'dim' }, i.sizes || ''))); });
            box.append(h('div', { class: 'section-title' }, 'Icons'), icons);
          }
          box.append(h('div', { class: 'section-title' }, 'Raw'), h('div', { style: { padding: '6px 10px' } }, localTree(m, null, true)));
        } catch (e) { box.append(h('div', { class: 'empty' }, 'Failed to load manifest: ' + errMsg(e))); }
      }
      this.setView(this.toolbar(h('button', { class: 'ibtn', onclick: () => this.open('manifest') }, '⟳'), h('b', null, 'Manifest')), box);
    },
    async swView() {
      const res = await page('swList');
      const box = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      if (res.unsupported) box.append(h('div', { class: 'empty' }, 'Service workers are not available in this context'));
      else if (!res.regs.length) box.append(h('div', { class: 'empty' }, 'No service workers registered for this origin'));
      else res.regs.forEach(r => {
        box.append(h('div', { class: 'section-title' }, r.scope));
        box.append(h('div', { class: 'kv' }, h('div', null, 'Source'), h('div', null, h('a', { onclick: () => Sources.openUrl(r.script) }, r.script)), h('div', null, 'Status'), h('div', null, h('span', { class: 'status-dot ' + (r.state === 'activated' ? 'ok-dot' : 'warn-dot') }), r.state + (r.waiting ? ' (waiting to activate)' : ''))));
        box.append(h('div', { style: { display: 'flex', gap: '8px', padding: '4px 10px 10px' } },
          h('button', { class: 'btn', onclick: async () => { await page('swUpdate', { scope: r.scope }); this.open('sw'); } }, 'Update'),
          h('button', { class: 'btn danger', onclick: async () => { await page('swUnregister', { scope: r.scope }); this.open('sw'); } }, 'Unregister')));
      });
      this.setView(this.toolbar(h('button', { class: 'ibtn', onclick: () => this.open('sw') }, '⟳'), h('b', null, 'Service workers')), box);
    },
    async storageOverview() {
      const s = await page('memoryStats');
      let cookies = [];
      try { cookies = await native('getCookies', {}); } catch (e) {}
      const box = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0' } });
      box.append(h('div', { class: 'section-title' }, 'Usage · ' + (originOf(pageUrl) || '')));
      box.append(h('div', { class: 'cards' },
        Memory.card('Total usage', s.storage ? fmtBytes(s.storage.usage) : '–', s.storage ? 'of ' + fmtBytes(s.storage.quota) + ' quota' : ''),
        Memory.card('localStorage', fmtBytes(s.localStorage)), Memory.card('sessionStorage', fmtBytes(s.sessionStorage)), Memory.card('Cookies', String(cookies.length))));
      box.append(h('div', { style: { padding: '10px' } }, h('button', {
        class: 'btn danger', onclick: async () => {
          if (!await confirmDialog('Clear site data', 'Delete cookies, local/session storage, IndexedDB, caches and service workers for ' + hostOf(pageUrl) + '?', 'Clear site data')) return;
          try { await page('storageClear', { type: 'local' }); await page('storageClear', { type: 'session' }); } catch (e) {}
          try { const n = await native('clearSiteData', {}); toast('Site data cleared (' + n + ' records)'); } catch (e) { toast(errMsg(e)); }
          this.open('storage');
        }
      }, 'Clear site data')));
      this.setView(this.toolbar(h('button', { class: 'ibtn', onclick: () => this.open('storage') }, '⟳'), h('b', null, 'Storage')), box);
    },
    onNavigate() { if (currentPanel === 'application') setTimeout(() => this.onShow(), 600); }
  };

  // ================================================================== Security
  const Security = modules.security = {
    build(el) {
      this.body = h('div', { class: 'scroll', style: { flex: '1', minHeight: '0', paddingBottom: '30px' } });
      el.append(h('div', { class: 'ptb' }, h('button', { class: 'ibtn', onclick: () => this.onShow() }, '⟳'), h('b', null, 'Security overview')), this.body);
    },
    async onShow() {
      let s;
      try { s = await native('security', {}); } catch (e) { clearEl(this.body); this.body.append(h('div', { class: 'empty' }, errMsg(e))); return; }
      clearEl(this.body);
      const https = /^https:/.test(s.url);
      const certs = s.certificates || [];
      const mixed = https && !s.secureContent;
      const level = !https ? 'bad' : mixed ? 'warn' : 'ok';
      const title = !https ? 'This page is not secure' : mixed ? 'This page is not fully secure' : 'This page is secure (valid HTTPS).';
      this.body.append(h('div', { class: 'sec-hero' }, h('div', { class: 'sec-icon ' + level }, level === 'ok' ? '🔒︎' : '!'), h('div', null, h('h3', null, title), h('div', { class: 'dim' }, s.url))));
      const item = (ok, name, text) => this.body.append(h('div', { class: 'sec-item' }, h('span', { class: 'status-dot dot ' + (ok === true ? 'ok-dot' : ok === false ? 'bad-dot' : 'warn-dot') }), h('div', null, h('b', null, name), h('span', { class: 'dim' }, text))));
      if (https) {
        item(certs.length > 0, 'Certificate', certs.length ? 'valid and trusted — the connection to this site is using a valid, trusted server certificate issued by ' + (certs[1] ? certs[1].subject : certs[0].subject) + '.' : 'certificate information is not available.');
        item(true, 'Connection', 'secure connection settings — the connection is encrypted and authenticated (TLS).');
        item(!mixed, 'Resources', mixed ? 'mixed content — this page includes resources loaded over insecure HTTP.' : 'all served securely — all resources on this page are served securely.');
      } else {
        item(false, 'Connection', /^http:/.test(s.url) ? 'not secure — this page is loaded over plain HTTP. Information you submit could be read by others.' : 'not a network page.');
      }
      if (certs.length) {
        this.body.append(h('div', { class: 'section-title' }, 'Certificate chain'));
        const kv = h('div', { class: 'kv' });
        certs.forEach((c, i) => kv.append(h('div', null, i === 0 ? 'Leaf' : i === certs.length - 1 ? 'Root' : 'Intermediate'), h('div', null, c.subject + (c.summary ? ' · ' + c.summary : ''))));
        this.body.append(kv);
      }
      const origins = new Map();
      Network.all().forEach(r => { const o = originOf(r.url); if (o && /^https?:/.test(o)) origins.set(o, (origins.get(o) || 0) + 1); });
      if (origins.size) {
        this.body.append(h('div', { class: 'section-title' }, 'Origins (' + origins.size + ')'));
        Array.from(origins.entries()).sort((a, b) => b[1] - a[1]).forEach(([o, n]) => this.body.append(h('div', { class: 'sec-item' }, h('span', { class: 'status-dot dot ' + (o.startsWith('https') ? 'ok-dot' : 'bad-dot') }), h('div', null, h('b', null, o), h('span', { class: 'dim' }, n + ' request' + (n > 1 ? 's' : '') + (o.startsWith('https') ? ' · secure' : ' · not secure'))))));
      }
    }
  };

  // ================================================================== settings, menus, toolbar
  let dockMode = 'bottom';
  let desktopMode = false;
  function seg(options, value, onChange) {
    const box = h('div', { class: 'seg' });
    options.forEach(([v, label]) => box.append(h('button', { class: v === value ? 'on' : '', onclick: () => { box.querySelectorAll('button').forEach(b => b.classList.remove('on')); box.querySelector('[data-v="' + v + '"]').classList.add('on'); onChange(v); }, 'data-v': v }, label)));
    return box;
  }
  function chkRow(label, key, after) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!Settings[key];
    cb.addEventListener('change', () => { Settings[key] = cb.checked; saveSettings(); if (after) after(); });
    return h('label', { class: 'srow' }, h('span', null, label), cb);
  }
  function openSettings() {
    const content = h('div', null,
      h('div', { class: 'settings-group' }, h('h4', null, 'Theme'), seg([['auto', 'System'], ['light', 'Light'], ['dark', 'Dark']], Settings.theme, v => { Settings.theme = v; saveSettings(); applyTheme(); })),
      h('div', { class: 'settings-group' }, h('h4', null, 'Font size'), seg([[11, 'S'], [12, 'M'], [13, 'L'], [14, 'XL']], Settings.fontSize, v => { Settings.fontSize = +v; saveSettings(); applyTheme(); })),
      h('div', { class: 'settings-group' }, h('h4', null, 'Panel layout'), seg([['bottom', 'Bottom'], ['right', 'Right'], ['full', 'Full screen']], dockMode, v => native('dock', { mode: v }))),
      h('div', { class: 'settings-group' }, h('h4', null, 'Console'),
        chkRow('Show timestamps', 'timestamps'),
        chkRow('Group similar messages', 'groupSimilar'),
        chkRow('Log XMLHttpRequests and fetch', 'logXhr'),
        chkRow('Preserve log upon navigation', 'preserveConsole', () => { Console.preserveCb.checked = Settings.preserveConsole; })),
      h('div', { class: 'settings-group' }, h('h4', null, 'Network'), chkRow('Preserve log upon navigation', 'preserveNetwork')),
      h('div', { class: 'settings-group' }, h('h4', null, 'Page'), chkRow('Request desktop site', '_desktop'))
    );
    const desk = content.querySelectorAll('input[type=checkbox]');
    const deskCb = desk[desk.length - 1];
    deskCb.checked = desktopMode;
    deskCb.addEventListener('change', () => native('setDesktop', { on: deskCb.checked }).then(v => setDesktop(!!v)));
    dialog({ title: 'Settings', content, cancel: false, okText: 'Done' });
  }
  function showShortcuts() {
    const rows = [
      ['F12 / ⌘⌥I', 'Open or close DevTools'], ['⌘⌥J', 'Open Console'], ['⌘⇧C', 'Inspect element'], ['F5 / ⌘R', 'Reload page (DevTools stay open)'],
      ['⇧F5 / ⌘⇧R', 'Hard reload (bypass cache)'], ['⌘L', 'Focus address bar'], ['⌘[ / ⌘]', 'Back / Forward'], ['⌘K', 'Clear console'],
      ['Enter', 'Run console expression'], ['⇧Enter', 'New line in console'], ['↑ / ↓', 'Console history'], ['Tab / →', 'Accept autocomplete']
    ];
    const kv = h('div', { class: 'kv', style: { padding: '0' } });
    rows.forEach(([k, v]) => kv.append(h('div', { class: 'mono' }, k), h('div', null, v)));
    dialog({ title: 'Keyboard shortcuts', content: kv, cancel: false, okText: 'Close' });
  }
  function moreMenu(anchor) {
    menuAt(anchor, [
      { title: 'Dock side' },
      { label: 'Dock to bottom', checked: dockMode === 'bottom', action: () => native('dock', { mode: 'bottom' }) },
      { label: 'Dock to right', checked: dockMode === 'right', action: () => native('dock', { mode: 'right' }) },
      { label: 'Full screen', checked: dockMode === 'full', action: () => native('dock', { mode: 'full' }) },
      '-',
      { label: 'Reload page (F5)', action: () => native('reload', {}) },
      { label: 'Hard reload (⇧F5)', action: () => native('reload', { hard: true }) },
      { label: 'Request desktop site', checked: desktopMode, action: () => native('setDesktop', { on: !desktopMode }).then(v => setDesktop(!!v)) },
      '-',
      { label: 'Settings', action: openSettings },
      { label: 'Keyboard shortcuts', action: showShortcuts },
      { label: 'Close DevTools', action: () => native('close', {}) }
    ]);
  }
  function setDesktop(on) {
    desktopMode = on;
    $('#btn-device').classList.toggle('active', on);
  }

  // ================================================================== events from native / page
  DT.onPageEvents = function (list) {
    for (const ev of list) {
      try { dispatch(ev); } catch (e) { /* keep going */ }
    }
  };
  function dispatch(ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'hello':
        if (!ev.frame) { pageUrl = d.url; Elements.reset(); Sources.reset(); if (currentPanel === 'elements' && devtoolsVisible) setTimeout(() => Elements.reload(), 0); }
        break;
      case 'console': Console.add(Object.assign({ ts: ev.ts, frame: ev.frame }, d)); break;
      case 'consoleClear': Console.clear(); break;
      case 'netStart': Network.onStart(d); break;
      case 'netResponse': Network.onResponse(d); break;
      case 'netBody': Network.onBody(d); break;
      case 'netDone': Network.onDone(d); break;
      case 'netFail': Network.onFail(d); break;
      case 'netResource': Network.onResource(d); break;
      case 'netResourceError': Network.onResourceError(d); break;
      case 'wsFrame': Network.onWsFrame(d); break;
      case 'domUpdated': if (!ev.frame) Elements.onDomUpdated(d.ids); break;
      case 'domReady':
        if (!ev.frame && currentPanel === 'elements' && devtoolsVisible) Elements.reload();
        break;
      case 'load':
        if (!ev.frame) {
          Network.onLoad(d);
          if (currentPanel === 'performance' && devtoolsVisible) Perf.loadMetrics();
          if (currentPanel === 'sources') Sources.refresh();
        }
        break;
      case 'inspectNode': if (!ev.frame) Elements.onInspectNode(d); break;
      case 'inspectCancel': Elements.setInspecting(false); break;
      case 'copy': copyText(d.text); break;
    }
  }
  DT.onNavigate = function (info) {
    pageUrl = info.url || pageUrl;
    Console.onNavigate(info.url);
    Network.onNavigate();
    Elements.reset();
    Elements.setInspecting(false);
    Sources.reset();
    App.onNavigate();
  };
  DT.onDocumentResponse = function (r) { Network.onDocument(r); };
  DT.onPageLoad = function (info) {
    pageUrl = info.url || pageUrl;
    if (currentPanel === 'elements' && devtoolsVisible && !Elements.loaded) Elements.reload();
    if (currentPanel === 'security' && devtoolsVisible) Security.onShow();
  };
  DT.onPageError = function (info) {
    Console.add({ level: 'error', text: 'Failed to load ' + (info.url || 'page') + ': ' + info.error });
    if (info.url) Network.add({ id: 'err' + Date.now(), url: info.url, method: 'GET', type: 'document', failed: true, error: info.error, done: true });
  };
  DT.onVisibility = function (v) {
    devtoolsVisible = !!v;
    if (v && currentPanel && modules[currentPanel].onShow) modules[currentPanel].onShow();
    if (!v && Elements.inspecting) page('setInspectMode', { on: false }).catch(() => {}).then(() => Elements.setInspecting(false));
  };
  DT.onState = function (s) {
    if (!s) return;
    if (s.dock) dockMode = s.dock;
    if (s.desktop !== undefined) setDesktop(!!s.desktop);
    if (s.url) pageUrl = s.url;
  };
  DT.startInspect = function () {
    if (!Elements.inspecting) Elements.toggleInspect();
  };

  // ================================================================== keyboard
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'F12') { e.preventDefault(); native('close', {}); return; }
    if (e.key === 'F5') { e.preventDefault(); native('reload', { hard: e.shiftKey || e.ctrlKey }); return; }
    if (mod && e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); Elements.toggleInspect(); return; }
    if (mod && (e.key === '[' || e.key === ']')) {
      e.preventDefault();
      const i = PANELS.findIndex(p => p[0] === currentPanel);
      showPanel(PANELS[(i + (e.key === ']' ? 1 : -1) + PANELS.length) % PANELS.length][0]);
      return;
    }
    if (e.key === 'Escape' && Elements.inspecting) { page('setInspectMode', { on: false }).catch(() => {}); Elements.setInspecting(false); }
    if (mod && e.key === 'f' && currentPanel === 'elements') { e.preventDefault(); Elements.searchInput.focus(); }
    if (mod && e.key === 'f' && currentPanel === 'sources') { e.preventDefault(); Sources.findInput.focus(); }
    if (mod && e.key === 'k' && currentPanel === 'console') { e.preventDefault(); Console.clear(); }
  });

  // ================================================================== init
  function init() {
    applyTheme();
    const tabs = $('#tabs');
    const panels = $('#panels');
    for (const [name, title] of PANELS) {
      tabs.append(h('button', { class: 'tab', 'data-panel': name, onclick: () => showPanel(name) }, title));
      const el = h('section', { class: 'panel', id: 'panel-' + name });
      panels.append(el);
      modules[name].build(el);
    }
    $('#btn-inspect').addEventListener('click', () => Elements.toggleInspect());
    $('#btn-device').addEventListener('click', () => native('setDesktop', { on: !desktopMode }).then(v => { setDesktop(!!v); toast(v ? 'Requesting desktop site' : 'Requesting mobile site'); }).catch(e => toast(errMsg(e))));
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-more').addEventListener('click', e => moreMenu(e.currentTarget));
    $('#btn-close').addEventListener('click', () => native('close', {}));
    $('#badge-errors').addEventListener('click', () => { showPanel('console'); });
    $('#badge-warnings').addEventListener('click', () => { showPanel('console'); });
    showPanel(PANELS.some(p => p[0] === Settings.panel) ? Settings.panel : 'elements');
    native('ready', {}).then(s => DT.onState(s)).catch(() => {});
  }
  init();
})();
