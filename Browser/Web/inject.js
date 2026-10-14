/*
 * DevTools page agent.
 * Injected at document start into every frame of the browsed page. It hooks the console,
 * errors, fetch/XHR/WebSocket and event listeners, and answers commands sent by the
 * DevTools UI (DOM tree, styles, storage, evaluation results, ...).
 */
(function () {
  'use strict';
  if (window.__iosDevTools) return;

  var handler;
  try { handler = window.webkit.messageHandlers.iosDevTools; } catch (e) { return; }
  if (!handler) return;

  const SELF = 'ios-devtools-agent';
  const isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  const frameUrl = isTop ? null : String(location.href);
  const _stringify = JSON.stringify;
  const _Promise = Promise;
  const _setTimeout = setTimeout;
  const _clearTimeout = clearTimeout;
  const _getComputedStyle = getComputedStyle;

  // ---------------------------------------------------------------- transport
  let queue = [];
  let scheduled = false;
  function flush() {
    scheduled = false;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    let s;
    try { s = _stringify(batch); } catch (e) { return; }
    try { handler.postMessage(s); } catch (e) {}
  }
  function emit(type, data) {
    queue.push({ type: type, data: data, frame: frameUrl, ts: Date.now() });
    if (queue.length >= 300) { flush(); return; }
    if (!scheduled) { scheduled = true; _Promise.resolve().then(flush); }
  }

  // ---------------------------------------------------------------- registries
  const objIds = new WeakMap();
  const objById = new Map();
  let nextObjId = 1;
  function objId(o) {
    let id = objIds.get(o);
    if (id === undefined) { id = nextObjId++; objIds.set(o, id); objById.set(id, o); }
    return id;
  }
  const nodeIds = new WeakMap();
  const nodeById = new Map();
  let nextNodeId = 1;
  function nodeId(n) {
    let id = nodeIds.get(n);
    if (id === undefined) { id = nextNodeId++; nodeIds.set(n, id); nodeById.set(id, n); }
    return id;
  }
  function nodeOf(id) {
    const n = nodeById.get(id);
    if (!n) throw new Error('Node ' + id + ' not found');
    return n;
  }

  // ---------------------------------------------------------------- helpers
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function safeString(v) {
    try { return String(v); } catch (e) {
      try { return Object.prototype.toString.call(v); } catch (e2) { return '[object]'; }
    }
  }
  function className(o) {
    try {
      const c = o.constructor;
      if (c && typeof c.name === 'string' && c.name) return c.name;
    } catch (e) {}
    try { return Object.prototype.toString.call(o).slice(8, -1); } catch (e) { return 'Object'; }
  }
  function isNode(v) {
    try {
      if (v instanceof Node) return true;
      return typeof v.nodeType === 'number' && typeof v.nodeName === 'string' && 'ownerDocument' in v;
    } catch (e) { return false; }
  }
  function isError(v) {
    try { return v instanceof Error || Object.prototype.toString.call(v) === '[object Error]'; } catch (e) { return false; }
  }
  function setStyle(el, styles) { for (const k in styles) el.style[k] = styles[k]; }
  function absUrl(u) { try { return new URL(String(u), location.href).href; } catch (e) { return String(u); } }

  function nodeLabel(n) {
    switch (n.nodeType) {
      case 1: {
        let s = n.localName;
        if (n.id) s += '#' + n.id;
        let cls = '';
        try { cls = (n.getAttribute('class') || '').trim(); } catch (e) {}
        if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
        return s;
      }
      case 3: return '#text "' + truncate(n.nodeValue.trim(), 60) + '"';
      case 8: return '<!--' + truncate(n.nodeValue, 60) + '-->';
      case 9: return '#document';
      case 10: return '<!DOCTYPE ' + n.name + '>';
      case 11: return n.host ? '#shadow-root' : '#document-fragment';
      default: return n.nodeName;
    }
  }

  function fnDesc(f) {
    let src = '';
    try { src = Function.prototype.toString.call(f); } catch (e) {}
    let name = '';
    try { name = f.name || ''; } catch (e) {}
    if (/^class\b/.test(src)) return 'class ' + name;
    const isAsync = /^async\b/.test(src);
    if (!/^(async\s+)?function\b/.test(src) && /^[^{]*=>/.test(src.slice(0, 300)) && !/\[native code\]/.test(src)) {
      return truncate(src.replace(/\s+/g, ' '), 100);
    }
    const m = src.match(/^[^(]*\(([^)]*)\)/);
    const params = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    return (isAsync ? 'async ' : '') + 'ƒ ' + name + '(' + truncate(params, 60) + ')';
  }

  function parseStack(stack, skipOwn) {
    if (!stack || typeof stack !== 'string') return [];
    const out = [];
    let leading = true;
    let skip = skipOwn || 0;
    const lines = stack.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      let fn = '';
      let loc = l;
      if (/^at /.test(l)) {
        const m = l.match(/^at (?:(.*?) \()?(.*?)\)?$/);
        if (m) { fn = m[1] || ''; loc = m[2]; } else continue;
      } else {
        const at = l.indexOf('@');
        if (at >= 0) { fn = l.slice(0, at); loc = l.slice(at + 1); }
        else if (!/:\d+:\d+$/.test(l)) continue; // e.g. "TypeError: msg" header line (Chrome)
      }
      const m = loc.match(/^(.*):(\d+):(\d+)$/);
      const f = m ? { fn: fn, url: m[1], line: +m[2], col: +m[3] } : { fn: fn || l, url: '', line: 0, col: 0 };
      if (skip > 0) { skip--; continue; }
      if (f.url.indexOf(SELF) >= 0 || /^user-script:/.test(f.url)) continue;
      if (leading && !f.url) continue;
      leading = false;
      out.push(f);
      if (out.length >= 40) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- serialization
  function ser(v, depth) {
    switch (typeof v) {
      case 'undefined': return { t: 'undefined' };
      case 'number': return { t: 'number', v: Object.is(v, -0) ? '-0' : String(v) };
      case 'string': return { t: 'string', v: v.length > 20000 ? v.slice(0, 20000) + '…' : v };
      case 'boolean': return { t: 'boolean', v: String(v) };
      case 'bigint': return { t: 'bigint', v: v.toString() + 'n' };
      case 'symbol': return { t: 'symbol', v: safeString(v) };
      case 'function': return { t: 'function', id: objId(v), v: fnDesc(v) };
    }
    if (v === null) return { t: 'null' };
    const d = { t: 'object', id: objId(v), cls: className(v) };
    try {
      if (Array.isArray(v)) { d.sub = 'array'; d.len = v.length; }
      else if (ArrayBuffer.isView(v) && !(v instanceof DataView)) { d.sub = 'typedarray'; d.len = v.length; }
      else if (v === window) { d.sub = 'window'; d.desc = 'Window'; }
      else if (isNode(v)) { d.sub = 'node'; d.nodeId = nodeId(v); d.desc = nodeLabel(v); d.nodeType = v.nodeType; }
      else if (isError(v)) { d.sub = 'error'; d.desc = safeString(v); d.stack = parseStack(v.stack); }
      else if (v instanceof Date) { d.sub = 'date'; d.desc = safeString(v); }
      else if (v instanceof RegExp) { d.sub = 'regexp'; d.desc = safeString(v); }
      else if (v instanceof Map) { d.sub = 'map'; d.len = v.size; }
      else if (v instanceof Set) { d.sub = 'set'; d.len = v.size; }
      else if (v instanceof WeakMap || v instanceof WeakSet) { d.sub = 'weak'; }
      else if (v instanceof Promise) { d.sub = 'promise'; }
    } catch (e) {}
    if (depth > 0 && d.sub !== 'node' && d.sub !== 'window') d.preview = preview(v, d);
    return d;
  }

  function shortDesc(v) {
    if (typeof v === 'string') return '"' + truncate(v, 50) + '"';
    if (v === null || typeof v !== 'object' && typeof v !== 'function') return safeString(v);
    return className(v);
  }

  function preview(v, d) {
    const p = { entries: [], overflow: false };
    const arrayLike = d.sub === 'array' || d.sub === 'typedarray';
    const limit = arrayLike ? 100 : 5;
    try {
      if (arrayLike) {
        const n = Math.min(v.length, limit);
        for (let i = 0; i < n; i++) p.entries.push([String(i), ser(v[i], 0)]);
        p.overflow = v.length > limit;
      } else if (d.sub === 'map') {
        let i = 0;
        for (const kv of v) {
          if (i++ >= limit) { p.overflow = true; break; }
          p.entries.push([shortDesc(kv[0]), ser(kv[1], 0)]);
        }
      } else if (d.sub === 'set') {
        let i = 0;
        for (const val of v) {
          if (i++ >= limit) { p.overflow = true; break; }
          p.entries.push([null, ser(val, 0)]);
        }
      } else if (!d.sub) {
        const keys = Object.keys(v);
        for (let i = 0; i < keys.length && i < limit; i++) {
          let val;
          try { val = v[keys[i]]; } catch (e) { val = '[Exception: ' + safeString(e) + ']'; }
          p.entries.push([keys[i], ser(val, 0)]);
        }
        p.overflow = keys.length > limit;
      }
    } catch (e) {}
    return p;
  }

  function getProperties(a) {
    const o = objById.get(a.id);
    if (o === undefined || o === null) return [];
    const receiverId = a.receiver || a.id;
    const out = [];
    let keys = [];
    try { keys = Reflect.ownKeys(o); } catch (e) {}
    const max = 3000;
    for (let i = 0; i < keys.length && out.length < max; i++) {
      const k = keys[i];
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(o, k); } catch (e) { continue; }
      if (!desc) continue;
      const name = typeof k === 'symbol' ? safeString(k) : k;
      if ('value' in desc) out.push({ name: name, value: ser(desc.value, 1), enumerable: desc.enumerable });
      else out.push({ name: name, getter: !!desc.get, setter: !!desc.set, enumerable: desc.enumerable, receiverId: receiverId, symbol: typeof k === 'symbol' });
    }
    if (keys.length > max) out.push({ name: '…', value: { t: 'string', v: (keys.length - max) + ' more properties' }, internal: true });
    try {
      if (o instanceof Map) out.push({ name: '[[Entries]]', internal: true, value: ser(Array.from(o.entries()).map(function (e) { return { key: e[0], value: e[1] }; }), 1) });
      else if (o instanceof Set) out.push({ name: '[[Entries]]', internal: true, value: ser(Array.from(o.values()), 1) });
    } catch (e) {}
    let proto = null;
    try { proto = Object.getPrototypeOf(o); } catch (e) {}
    if (proto) out.push({ name: '[[Prototype]]', internal: true, value: ser(proto, 0), receiver: receiverId });
    return out;
  }

  function invokeGetter(a) {
    const holder = objById.get(a.id);
    const recv = objById.get(a.receiver) || holder;
    const desc = Object.getOwnPropertyDescriptor(holder, a.name);
    if (!desc || !desc.get) return { t: 'undefined' };
    try { return ser(desc.get.call(recv), 1); } catch (e) { return { t: 'string', v: '[Exception: ' + safeString(e) + ']' }; }
  }

  // ---------------------------------------------------------------- event listener tracking
  const listenerMap = new WeakMap();
  let listenerCount = 0;
  const ETP = EventTarget.prototype;
  const _add = ETP.addEventListener;
  const _remove = ETP.removeEventListener;
  function captureFlag(opts) { return typeof opts === 'boolean' ? opts : !!(opts && opts.capture); }
  ETP.addEventListener = function addEventListener(type, fn, opts) {
    try {
      if (fn && this) {
        let arr = listenerMap.get(this);
        if (!arr) { arr = []; listenerMap.set(this, arr); }
        const cap = captureFlag(opts);
        const t = String(type);
        let dup = false;
        for (let i = 0; i < arr.length; i++) if (arr[i].type === t && arr[i].fn === fn && arr[i].capture === cap) { dup = true; break; }
        if (!dup) {
          arr.push({ type: t, fn: fn, capture: cap, once: !!(opts && opts.once), passive: !!(opts && opts.passive) });
          listenerCount++;
        }
      }
    } catch (e) {}
    return _add.apply(this, arguments);
  };
  ETP.removeEventListener = function removeEventListener(type, fn, opts) {
    try {
      const arr = listenerMap.get(this);
      if (arr) {
        const cap = captureFlag(opts);
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].type === String(type) && arr[i].fn === fn && arr[i].capture === cap) { arr.splice(i, 1); listenerCount--; break; }
        }
      }
    } catch (e) {}
    return _remove.apply(this, arguments);
  };

  // ---------------------------------------------------------------- console
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group',
    'groupCollapsed', 'groupEnd', 'assert', 'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'clear'];
  const counters = new Map();
  const timers = new Map();

  function tableData(data, columns) {
    if (data === null || typeof data !== 'object') return null;
    const rows = [];
    const cols = [];
    let hasValue = false;
    const keys = data instanceof Map ? Array.from(data.keys()) : Object.keys(data);
    for (let i = 0; i < keys.length && i < 500; i++) {
      const k = keys[i];
      const row = data instanceof Map ? data.get(k) : data[k];
      const cells = {};
      if (row !== null && typeof row === 'object') {
        const rk = Object.keys(row);
        for (let j = 0; j < rk.length; j++) {
          if (columns && columns.indexOf(rk[j]) < 0) continue;
          if (cols.indexOf(rk[j]) < 0) cols.push(rk[j]);
          cells[rk[j]] = ser(row[rk[j]], 0);
        }
      } else { hasValue = true; cells['\u0000value'] = ser(row, 0); }
      rows.push({ index: shortDesc(k).replace(/^"|"$/g, ''), cells: cells });
    }
    const allCols = (columns && Array.isArray(columns)) ? columns.map(String) : cols;
    if (hasValue) allCols.push('\u0000value');
    return { cols: allCols, rows: rows };
  }

  function handleConsole(method, args) {
    let level = method;
    let a = args;
    let label;
    switch (method) {
      case 'assert':
        if (args[0]) return;
        level = 'error';
        a = args.length > 1 ? ['Assertion failed:'].concat(Array.prototype.slice.call(args, 1)) : ['Assertion failed'];
        break;
      case 'count':
        label = args.length && args[0] !== undefined ? String(args[0]) : 'default';
        counters.set(label, (counters.get(label) || 0) + 1);
        level = 'log'; a = [label + ': ' + counters.get(label)];
        break;
      case 'countReset':
        counters.delete(args.length && args[0] !== undefined ? String(args[0]) : 'default');
        return;
      case 'time':
        timers.set(args.length && args[0] !== undefined ? String(args[0]) : 'default', performance.now());
        return;
      case 'timeLog':
      case 'timeEnd': {
        label = args.length && args[0] !== undefined ? String(args[0]) : 'default';
        const s = timers.get(label);
        if (s === undefined) { level = 'warn'; a = ["Timer '" + label + "' does not exist"]; }
        else {
          level = 'log';
          a = [label + ': ' + (performance.now() - s).toFixed(3) + ' ms' + (method === 'timeEnd' ? ' - timer ended' : '')]
            .concat(method === 'timeLog' ? Array.prototype.slice.call(args, 1) : []);
          if (method === 'timeEnd') timers.delete(label);
        }
        break;
      }
      case 'clear':
        emit('consoleClear', {});
        return;
      case 'dirxml': level = 'log'; break;
      case 'dir': level = 'log'; break;
      case 'table': level = 'log'; break;
      case 'trace': level = 'log'; break;
      case 'group': case 'groupCollapsed': level = 'log'; break;
      case 'groupEnd': emit('console', { level: 'log', method: 'groupEnd', args: [] }); return;
    }
    const frames = parseStack(new Error().stack, 2);
    const msg = {
      level: level,
      method: method,
      args: Array.prototype.map.call(a, function (x) { return ser(x, 1); }),
      loc: frames[0] || null
    };
    if (method === 'trace' || level === 'error' || level === 'warn') msg.stack = frames;
    if (method === 'table') {
      try { msg.table = tableData(args[0], args[1]); } catch (e) {}
    }
    emit('console', msg);
  }

  consoleMethods.forEach(function (m) {
    const orig = console[m];
    console[m] = function () {
      try { handleConsole(m, arguments); } catch (e) {}
      if (typeof orig === 'function') return orig.apply(this, arguments);
    };
  });

  _add.call(window, 'error', function (e) {
    try {
      const t = e.target;
      if (t && t !== window && t.nodeType === 1) {
        const url = t.currentSrc || t.src || t.href || '';
        emit('console', { level: 'error', args: [{ t: 'string', v: 'Failed to load resource: ' + url }], loc: { url: url, line: 0, col: 0 } });
        emit('netResourceError', { url: url, type: t.localName, wall: Date.now() });
        return;
      }
      const err = e.error;
      const text = 'Uncaught ' + (err !== undefined && err !== null ? (isError(err) ? safeString(err) : '') : (e.message || 'Error'));
      const msg = { level: 'error', exception: true, text: text, args: [], loc: e.filename ? { url: e.filename, line: e.lineno, col: e.colno } : null };
      if (err !== undefined && err !== null && !isError(err)) msg.args = [ser(err, 1)];
      if (err && err.stack) msg.stack = parseStack(err.stack);
      emit('console', msg);
    } catch (x) {}
  }, true);

  _add.call(window, 'unhandledrejection', function (e) {
    try {
      const r = e.reason;
      const msg = { level: 'error', exception: true, text: 'Uncaught (in promise)', args: [] };
      if (isError(r)) { msg.text += ' ' + safeString(r); msg.stack = parseStack(r.stack); msg.loc = msg.stack[0] || null; }
      else msg.args = [ser(r, 1)];
      emit('console', msg);
    } catch (x) {}
  });

  _add.call(document, 'securitypolicyviolation', function (e) {
    try {
      emit('console', {
        level: 'error',
        args: [{ t: 'string', v: "Refused to load '" + (e.blockedURI || 'inline') + "' because it violates the following Content Security Policy directive: \"" + e.violatedDirective + '"' }],
        loc: e.sourceFile ? { url: e.sourceFile, line: e.lineNumber, col: e.columnNumber } : null
      });
    } catch (x) {}
  });

  // ---------------------------------------------------------------- network
  let nextReq = 1;
  const BODY_LIMIT = 2 * 1024 * 1024;
  function isTextual(ct) {
    ct = (ct || '').toLowerCase();
    if (/event-stream/.test(ct)) return false;
    return !ct || /json|text|javascript|ecmascript|xml|html|css|graphql|x-www-form-urlencoded/.test(ct);
  }
  function bodyPreview(b) {
    try {
      if (b === null || b === undefined) return null;
      if (typeof b === 'string') return truncate(b, 200000);
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        const parts = [];
        b.forEach(function (v, k) { parts.push(encodeURIComponent(k) + '=' + (typeof v === 'string' ? encodeURIComponent(v) : '[File ' + (v.name || '') + ']')); });
        return parts.join('&');
      }
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes]';
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return '[binary ' + b.byteLength + ' bytes]';
      return safeString(b);
    } catch (e) { return null; }
  }
  function parseRawHeaders(raw) {
    const h = {};
    (raw || '').trim().split(/[\r\n]+/).forEach(function (line) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return h;
  }

  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function fetch(input, init) {
      const id = 'f' + (nextReq++) + '-' + Math.random().toString(36).slice(2, 6);
      let url = '';
      let method = 'GET';
      const headers = {};
      let body = null;
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url; method = input.method;
          input.headers.forEach(function (v, k) { headers[k] = v; });
        } else url = absUrl(input);
        if (init) {
          if (init.method) method = String(init.method).toUpperCase();
          if (init.headers) new Headers(init.headers).forEach(function (v, k) { headers[k] = v; });
          if (init.body !== undefined && init.body !== null) body = bodyPreview(init.body);
        }
      } catch (e) {}
      const start = performance.now();
      emit('netStart', { id: id, url: url, method: method, type: 'fetch', reqHeaders: headers, reqBody: body, wall: Date.now() });
      let p;
      try { p = _fetch.apply(this, arguments); } catch (e) {
        emit('netFail', { id: id, error: safeString(e), time: performance.now() - start });
        throw e;
      }
      p.then(function (res) {
        const h = {};
        try { res.headers.forEach(function (v, k) { h[k] = v; }); } catch (e) {}
        const time = performance.now() - start;
        emit('netResponse', { id: id, status: res.status, statusText: res.statusText, headers: h, mime: (h['content-type'] || '').split(';')[0], url: res.url, time: time, opaque: res.type === 'opaque' });
        if (res.type !== 'opaque' && isTextual(h['content-type'])) {
          try {
            res.clone().text().then(function (t) {
              emit('netBody', { id: id, body: t.length > BODY_LIMIT ? t.slice(0, BODY_LIMIT) : t, truncated: t.length > BODY_LIMIT, size: t.length, time: performance.now() - start });
            }, function () { emit('netDone', { id: id, time: performance.now() - start }); });
          } catch (e) { emit('netDone', { id: id, time: time }); }
        } else {
          emit('netDone', { id: id, time: time, size: +h['content-length'] || 0 });
        }
      }, function (err) {
        emit('netFail', { id: id, error: safeString(err), time: performance.now() - start });
      });
      return p;
    };
  }

  const XHRP = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (XHRP) {
    const xhrInfo = new WeakMap();
    const _open = XHRP.open;
    const _send = XHRP.send;
    const _setRH = XHRP.setRequestHeader;
    XHRP.open = function open(method, url) {
      try { xhrInfo.set(this, { id: 'x' + (nextReq++) + '-' + Math.random().toString(36).slice(2, 6), method: String(method).toUpperCase(), url: absUrl(url), headers: {} }); } catch (e) {}
      return _open.apply(this, arguments);
    };
    XHRP.setRequestHeader = function setRequestHeader(k, v) {
      try { const r = xhrInfo.get(this); if (r) r.headers[k] = v; } catch (e) {}
      return _setRH.apply(this, arguments);
    };
    XHRP.send = function send(body) {
      const r = xhrInfo.get(this);
      if (r) {
        const xhr = this;
        const start = performance.now();
        emit('netStart', { id: r.id, url: r.url, method: r.method, type: 'xhr', reqHeaders: r.headers, reqBody: bodyPreview(body), wall: Date.now() });
        _add.call(xhr, 'loadend', function () {
          const time = performance.now() - start;
          if (!xhr.status) { emit('netFail', { id: r.id, error: 'net::ERR_FAILED', time: time }); return; }
          const h = parseRawHeaders(xhr.getAllResponseHeaders());
          emit('netResponse', { id: r.id, status: xhr.status, statusText: xhr.statusText, headers: h, mime: (h['content-type'] || '').split(';')[0], url: xhr.responseURL, time: time });
          let text = null;
          try {
            if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText;
            else if (xhr.responseType === 'json') text = _stringify(xhr.response);
            else if (xhr.responseType === 'document' && xhr.response) text = xhr.response.documentElement.outerHTML;
          } catch (e) {}
          if (text !== null && text !== undefined) emit('netBody', { id: r.id, body: text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text, truncated: text.length > BODY_LIMIT, size: text.length, time: time });
          else emit('netDone', { id: r.id, time: time, size: +h['content-length'] || 0 });
        });
      }
      return _send.apply(this, arguments);
    };
  }

  const _WS = window.WebSocket;
  if (typeof _WS === 'function') {
    const frameData = function (d) {
      if (typeof d === 'string') return truncate(d, 20000);
      if (d && d.byteLength !== undefined) return '[binary ' + d.byteLength + ' bytes]';
      if (d && d.size !== undefined) return '[Blob ' + d.size + ' bytes]';
      return safeString(d);
    };
    const WS = function WebSocket(url, protocols) {
      const ws = protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
      const id = 'w' + (nextReq++) + '-' + Math.random().toString(36).slice(2, 6);
      try {
        emit('netStart', { id: id, url: ws.url, method: 'GET', type: 'websocket', reqHeaders: {}, wall: Date.now() });
        _add.call(ws, 'open', function () { emit('netResponse', { id: id, status: 101, statusText: 'Switching Protocols', headers: {}, mime: '' }); });
        _add.call(ws, 'message', function (ev) { emit('wsFrame', { id: id, dir: 'in', data: frameData(ev.data), t: Date.now() }); });
        _add.call(ws, 'close', function (ev) { emit('wsFrame', { id: id, dir: 'close', data: 'Connection closed (' + ev.code + ')', t: Date.now() }); });
        _add.call(ws, 'error', function () { emit('netFail', { id: id, error: 'WebSocket error' }); });
        const send = ws.send;
        ws.send = function (data) {
          try { emit('wsFrame', { id: id, dir: 'out', data: frameData(data), t: Date.now() }); } catch (e) {}
          return send.apply(this, arguments);
        };
      } catch (e) {}
      return ws;
    };
    WS.prototype = _WS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { WS[k] = _WS[k]; } catch (e) {} });
    window.WebSocket = WS;
  }

  // Resources loaded by the parser (scripts, styles, images, fonts, ...)
  let lcpValue = null;
  let clsValue = 0;
  if (isTop && typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') return;
          emit('netResource', {
            url: e.name, type: e.initiatorType, wall: performance.timeOrigin + e.startTime, duration: e.duration,
            transfer: e.transferSize || 0, encoded: e.encodedBodySize || 0, decoded: e.decodedBodySize || 0,
            status: e.responseStatus || 0, protocol: e.nextHopProtocol || ''
          });
        });
      }).observe({ type: 'resource', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver(function (list) {
        const es = list.getEntries();
        if (es.length) lcpValue = es[es.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) { if (!e.hadRecentInput) clsValue += e.value; });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- DOM
  let overlayHost = null;
  function isOverlay(n) { return overlayHost !== null && n === overlayHost; }

  function childList(n) {
    const out = [];
    try {
      if (n.nodeType === 1 && n.shadowRoot) out.push(n.shadowRoot);
      const src = (n.nodeType === 1 && n.localName === 'template' && n.content) ? n.content.childNodes : n.childNodes;
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c.nodeType === 3 && !c.nodeValue.trim()) continue;
        if (isOverlay(c)) continue;
        out.push(c);
      }
      if (n.nodeType === 1 && (n.localName === 'iframe' || n.localName === 'frame')) {
        try { if (n.contentDocument) out.push(n.contentDocument); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  function describe(n) {
    const d = { id: nodeId(n), type: n.nodeType, name: n.nodeName };
    switch (n.nodeType) {
      case 1: {
        d.name = n.localName || n.nodeName.toLowerCase();
        d.attrs = [];
        const attrs = n.attributes;
        for (let i = 0; i < attrs.length; i++) d.attrs.push([attrs[i].name, truncate(attrs[i].value, 2000)]);
        const kids = childList(n);
        d.count = kids.length;
        if (kids.length === 1 && kids[0].nodeType === 3 && kids[0].nodeValue.length <= 80 && kids[0].nodeValue.indexOf('\n') < 0) {
          d.inlineText = kids[0].nodeValue;
        }
        break;
      }
      case 3: case 4: case 8: d.text = truncate(n.nodeValue, 2000); break;
      case 10: d.name = n.name; d.publicId = n.publicId; break;
      case 9: case 11: d.count = childList(n).length; if (n.host) d.mode = n.mode; if (n.nodeType === 9) d.url = n.URL; break;
    }
    return d;
  }

  function parentOf(n) {
    if (n.parentNode) return n.parentNode;
    if (n.nodeType === 11 && n.host) return n.host;
    if (n.nodeType === 9) { try { return n.defaultView && n.defaultView.frameElement; } catch (e) { return null; } }
    return null;
  }

  function revealData(node) {
    const chain = [];
    let cur = node;
    for (;;) {
      const p = parentOf(cur);
      if (!p) break;
      chain.unshift(p);
      cur = p;
    }
    return {
      target: nodeId(node),
      chain: chain.map(function (p) { return { id: nodeId(p), node: describe(p), children: childList(p).map(describe) }; })
    };
  }

  let mo = null;
  const dirty = new Set();
  let moTimer = 0;
  function startDomWatch() {
    if (mo || typeof MutationObserver !== 'function') return;
    mo = new MutationObserver(function (muts) {
      for (let i = 0; i < muts.length; i++) {
        const m = muts[i];
        if (isOverlay(m.target)) continue;
        if (m.type === 'childList') {
          let onlyOverlay = true;
          for (let j = 0; j < m.addedNodes.length; j++) if (!isOverlay(m.addedNodes[j])) onlyOverlay = false;
          for (let j = 0; j < m.removedNodes.length; j++) if (!isOverlay(m.removedNodes[j])) onlyOverlay = false;
          if (onlyOverlay) continue;
        }
        const t = m.type === 'characterData' ? m.target.parentNode : m.target;
        if (t) { const id = nodeIds.get(t); if (id !== undefined) dirty.add(id); }
        if (m.type === 'characterData') { const id = nodeIds.get(m.target); if (id !== undefined) dirty.add(id); }
      }
      if (dirty.size && !moTimer) {
        moTimer = _setTimeout(function () {
          moTimer = 0;
          const ids = Array.from(dirty);
          dirty.clear();
          emit('domUpdated', { ids: ids });
        }, 350);
      }
    });
    mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  // ---------------------------------------------------------------- highlight overlay
  let ov = null;
  function overlay() {
    if (ov && ov.host.isConnected) return ov;
    const parent = document.documentElement || document.body;
    if (!parent) return null;
    const host = document.createElement('div');
    overlayHost = host;
    setStyle(host, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none', display: 'none' });
    let root = host;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (e) {}
    const mk = function (styles) {
      const d = document.createElement('div');
      setStyle(d, { position: 'fixed', boxSizing: 'border-box', pointerEvents: 'none', borderStyle: 'solid', borderWidth: '0', margin: '0', padding: '0' });
      setStyle(d, styles);
      root.appendChild(d);
      return d;
    };
    ov = {
      host: host,
      margin: mk({ borderColor: 'rgba(246,178,107,0.66)' }),
      border: mk({ borderColor: 'rgba(255,229,153,0.66)' }),
      padding: mk({ borderColor: 'rgba(147,196,125,0.55)' }),
      content: mk({ background: 'rgba(111,168,220,0.66)' }),
      tip: mk({ background: '#ffffff', color: '#202124', font: '11px/1.5 -apple-system, Helvetica, sans-serif', padding: '2px 6px', borderRadius: '3px', boxShadow: '0 1px 4px rgba(0,0,0,0.4)', whiteSpace: 'nowrap', maxWidth: '90vw', overflow: 'hidden', textOverflow: 'ellipsis' })
    };
    parent.appendChild(host);
    return ov;
  }
  function place(d, x, y, w, hgt, bw) {
    setStyle(d, {
      left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, hgt) + 'px',
      borderWidth: bw.map(function (v) { return Math.max(0, v) + 'px'; }).join(' ')
    });
  }
  function highlightNode(n) {
    if (!n) { hideHighlight(); return; }
    const el = n.nodeType === 1 ? n : (n.nodeType === 3 ? n.parentElement : (n.host || null));
    if (!el || !el.getBoundingClientRect || el.ownerDocument !== document) { hideHighlight(); return; }
    const o = overlay();
    if (!o) return;
    const r = el.getBoundingClientRect();
    const cs = _getComputedStyle(el);
    const px = function (k) { return parseFloat(cs[k]) || 0; };
    const m = [px('marginTop'), px('marginRight'), px('marginBottom'), px('marginLeft')];
    const b = [px('borderTopWidth'), px('borderRightWidth'), px('borderBottomWidth'), px('borderLeftWidth')];
    const p = [px('paddingTop'), px('paddingRight'), px('paddingBottom'), px('paddingLeft')];
    place(o.margin, r.left - Math.max(0, m[3]), r.top - Math.max(0, m[0]), r.width + Math.max(0, m[1]) + Math.max(0, m[3]), r.height + Math.max(0, m[0]) + Math.max(0, m[2]), m);
    place(o.border, r.left, r.top, r.width, r.height, b);
    place(o.padding, r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2], p);
    place(o.content, r.left + b[3] + p[3], r.top + b[0] + p[0], r.width - b[1] - b[3] - p[1] - p[3], r.height - b[0] - b[2] - p[0] - p[2], [0, 0, 0, 0]);
    o.tip.textContent = nodeLabel(el) + '  ' + Math.round(r.width * 100) / 100 + ' × ' + Math.round(r.height * 100) / 100;
    const below = r.bottom + 6;
    const top = below + 24 < window.innerHeight ? below : Math.max(2, r.top - 28);
    setStyle(o.tip, { left: Math.max(2, Math.min(r.left, window.innerWidth - 220)) + 'px', top: top + 'px' });
    o.host.style.display = 'block';
  }
  function hideHighlight() { if (ov) ov.host.style.display = 'none'; }

  // ---------------------------------------------------------------- inspect mode
  let inspecting = false;
  let inspectTarget = null;
  function pointTarget(e) {
    const p = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    if (typeof p.clientX !== 'number') return null;
    return document.elementFromPoint(p.clientX, p.clientY);
  }
  function stop(e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function finishInspect(t) {
    if (!inspecting) return;
    setInspectMode(false);
    if (t) {
      highlightNode(t);
      emit('inspectNode', revealData(t));
      _setTimeout(hideHighlight, 1500);
    } else emit('inspectCancel', {});
  }
  const inspectHandlers = {
    touchstart: function (e) { stop(e); const t = pointTarget(e); if (t) { inspectTarget = t; highlightNode(t); } },
    touchmove: function (e) { stop(e); const t = pointTarget(e); if (t) { inspectTarget = t; highlightNode(t); } },
    touchend: function (e) { stop(e); finishInspect(pointTarget(e) || inspectTarget); },
    mousemove: function (e) { const t = pointTarget(e); if (t) { inspectTarget = t; highlightNode(t); } },
    click: function (e) { stop(e); finishInspect(pointTarget(e) || inspectTarget); },
    mousedown: stop, mouseup: stop, pointerdown: stop, pointerup: stop, contextmenu: stop
  };
  function setInspectMode(on) {
    on = !!on;
    if (on === inspecting) return;
    inspecting = on;
    for (const k in inspectHandlers) {
      if (on) _add.call(window, k, inspectHandlers[k], { capture: true, passive: false });
      else _remove.call(window, k, inspectHandlers[k], { capture: true });
    }
    if (!on) { inspectTarget = null; hideHighlight(); }
  }

  // ---------------------------------------------------------------- CSS
  function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  function declProps(style) {
    const out = [];
    const text = style.cssText || '';
    splitTopLevel(text, ';').forEach(function (decl) {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const n = decl.slice(0, i).trim();
      let v = decl.slice(i + 1).trim();
      let imp = false;
      if (/!\s*important$/i.test(v)) { imp = true; v = v.replace(/\s*!\s*important$/i, ''); }
      if (n) out.push({ n: n, v: v, imp: imp });
    });
    return out;
  }
  function specificity(sel) {
    let s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/:(?:not|is|has|matches)\(((?:[^()]|\([^()]*\))*)\)/g, ' $1 ');
    s = s.replace(/"[^"]*"|'[^']*'/g, '');
    const a = (s.match(/#[\w-]+/g) || []).length;
    const b = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
    const c = (s.replace(/\[[^\]]*\]/g, '').replace(/[#.][\w-]+/g, '').match(/(^|[\s>+~(,])[a-zA-Z][\w-]*|::[\w-]+/g) || []).length;
    return [a, b, c];
  }
  function cmpSpec(x, y) { return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); }
  function matchedSpec(el, selectorText) {
    let best = null;
    splitTopLevel(selectorText, ',').forEach(function (part) {
      part = part.trim();
      let ok = false;
      try { ok = el.matches(part); } catch (e) {}
      if (ok) { const sp = specificity(part); if (!best || cmpSpec(sp, best) > 0) best = sp; }
    });
    return best;
  }
  function sheetLabel(sheet) {
    if (!sheet) return '';
    if (sheet.href) { try { const u = new URL(sheet.href); return (u.pathname.split('/').pop() || u.host); } catch (e) { return sheet.href; } }
    const owner = sheet.ownerNode;
    if (owner && owner.localName === 'style') return '<style>';
    return 'constructed';
  }
  function getStyles(el) {
    const rules = [];
    let order = 0;
    let blocked = 0;
    const visit = function (list, sheet, media) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        order++;
        if (r.selectorText !== undefined && r.style) {
          const sp = matchedSpec(el, r.selectorText);
          if (sp) rules.push({ id: objId(r), selector: r.selectorText, spec: sp, order: order, source: sheetLabel(sheet), href: sheet && sheet.href || '', media: media, props: declProps(r.style) });
        } else if (r.media && r.cssRules && r.type === 4) {
          let ok = false;
          try { ok = window.matchMedia(r.media.mediaText).matches; } catch (e) {}
          if (ok) visit(r.cssRules, sheet, '@media ' + r.media.mediaText);
        } else if (r.styleSheet) {
          try { visit(r.styleSheet.cssRules, r.styleSheet, media); } catch (e) { blocked++; }
        } else if (r.cssRules) {
          let ok = true;
          if (r.conditionText !== undefined && typeof CSS !== 'undefined' && CSS.supports && r.type === 12) {
            try { ok = CSS.supports(r.conditionText); } catch (e) {}
          }
          if (ok) visit(r.cssRules, sheet, media);
        }
      }
    };
    const sheets = Array.prototype.slice.call(document.styleSheets);
    try { if (document.adoptedStyleSheets) sheets.push.apply(sheets, document.adoptedStyleSheets); } catch (e) {}
    sheets.forEach(function (sheet) {
      if (sheet.disabled) return;
      let list;
      try { list = sheet.cssRules; } catch (e) { blocked++; return; }
      if (list) visit(list, sheet, null);
    });
    rules.sort(function (a, b) { return cmpSpec(b.spec, a.spec) || (b.order - a.order); });
    return { inline: declProps(el.style), rules: rules, blocked: blocked };
  }

  function cssPath(el) {
    if (el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let part = cur.localName;
      if (cur.id) { part += '#' + (window.CSS && CSS.escape ? CSS.escape(cur.id) : cur.id); parts.unshift(part); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (c) { return c.localName === cur.localName; });
        if (same.length > 1) part += ':nth-child(' + (Array.prototype.indexOf.call(parent.children, cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function xPath(n) {
    if (n.nodeType === 1 && n.id) return '//*[@id="' + n.id + '"]';
    const parts = [];
    let cur = n;
    while (cur && cur.nodeType !== 9) {
      let idx = 1;
      let sib = cur.previousSibling;
      while (sib) { if (sib.nodeType === cur.nodeType && sib.nodeName === cur.nodeName) idx++; sib = sib.previousSibling; }
      const name = cur.nodeType === 1 ? cur.localName : cur.nodeType === 3 ? 'text()' : cur.nodeType === 8 ? 'comment()' : '';
      if (!name) break;
      parts.unshift(name + '[' + idx + ']');
      cur = cur.parentNode;
    }
    return '/' + parts.join('/');
  }

  let ttPolicy;
  function trusted(html) {
    if (ttPolicy === undefined) {
      ttPolicy = null;
      try { if (window.trustedTypes && trustedTypes.createPolicy) ttPolicy = trustedTypes.createPolicy('ios-devtools', { createHTML: function (s) { return s; } }); } catch (e) {}
    }
    return ttPolicy ? ttPolicy.createHTML(html) : html;
  }

  // ---------------------------------------------------------------- command line API
  const selectedHistory = [];
  let lastResult;
  let apiInstalled = [];
  let apiTimer = 0;
  function listenersOf(t) {
    const out = {};
    (listenerMap.get(t) || []).forEach(function (l) {
      (out[l.type] = out[l.type] || []).push({ listener: l.fn, useCapture: l.capture, passive: l.passive, once: l.once, type: l.type });
    });
    return out;
  }
  const api = {
    $: function (s, root) { return (root || document).querySelector(s); },
    $$: function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); },
    $x: function (xp, ctx) {
      const r = document.evaluate(xp, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    },
    clear: function () { emit('consoleClear', {}); },
    copy: function (v) {
      let s;
      if (typeof v === 'string') s = v;
      else if (isNode(v)) s = v.outerHTML || v.textContent;
      else { try { s = _stringify(v, null, 2); } catch (e) { s = safeString(v); } }
      emit('copy', { text: s === undefined ? 'undefined' : s });
    },
    inspect: function (v) { if (isNode(v)) emit('inspectNode', revealData(v)); return v; },
    keys: function (o) { return Object.keys(o); },
    values: function (o) { return Object.values(o); },
    dir: function (o) { console.dir(o); },
    dirxml: function (o) { console.dirxml(o); },
    table: function (d, c) { console.table(d, c); },
    getEventListeners: listenersOf,
    monitorEvents: function (t, types) {
      (Array.isArray(types) ? types : [types || 'click']).forEach(function (ty) {
        _add.call(t, ty, function (e) { console.log(ty, e); });
      });
    }
  };
  function uninstallAPI() {
    if (apiTimer) { _clearTimeout(apiTimer); apiTimer = 0; }
    apiInstalled.forEach(function (k) {
      try {
        const d = Object.getOwnPropertyDescriptor(window, k);
        if (d && d.configurable && (d.get ? d.get.__dt : d.value === api[k])) delete window[k];
      } catch (e) {}
    });
    apiInstalled = [];
  }
  function installAPI(keep) {
    uninstallAPI();
    Object.keys(api).forEach(function (k) {
      if (k in window) return;
      try { Object.defineProperty(window, k, { value: api[k], configurable: true, writable: true, enumerable: false }); apiInstalled.push(k); } catch (e) {}
    });
    const getters = { $0: function () { return selectedHistory[0]; }, $1: function () { return selectedHistory[1]; }, $2: function () { return selectedHistory[2]; }, $3: function () { return selectedHistory[3]; }, $4: function () { return selectedHistory[4]; }, $_: function () { return lastResult; } };
    Object.keys(getters).forEach(function (k) {
      if (k in window) return;
      getters[k].__dt = true;
      try { Object.defineProperty(window, k, { get: getters[k], configurable: true, enumerable: false }); apiInstalled.push(k); } catch (e) {}
    });
    if (!keep) apiTimer = _setTimeout(uninstallAPI, 0);
  }
  function captureValue(v) {
    uninstallAPI();
    lastResult = v;
    return _stringify({ result: ser(v, 1) });
  }
  function captureError(e) {
    uninstallAPI();
    const out = { exception: true, text: 'Uncaught ' + (isError(e) ? safeString(e) : ''), stack: isError(e) ? parseStack(e.stack) : [] };
    if (!isError(e)) out.result = ser(e, 1);
    return _stringify(out);
  }

  // ---------------------------------------------------------------- perf
  function perfMetrics() {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    const t = performance.timing;
    let n = null;
    if (nav) {
      n = {
        type: nav.type, redirect: nav.redirectEnd - nav.redirectStart, dns: nav.domainLookupEnd - nav.domainLookupStart,
        tcp: nav.connectEnd - nav.connectStart, tls: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
        request: nav.responseStart - nav.requestStart, ttfb: nav.responseStart - nav.startTime, download: nav.responseEnd - nav.responseStart,
        domInteractive: nav.domInteractive, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, transfer: nav.transferSize || 0,
        encoded: nav.encodedBodySize || 0, decoded: nav.decodedBodySize || 0, protocol: nav.nextHopProtocol || ''
      };
    } else if (t) {
      const s = t.navigationStart;
      n = { type: 'navigate', dns: t.domainLookupEnd - t.domainLookupStart, tcp: t.connectEnd - t.connectStart, tls: 0, request: t.responseStart - t.requestStart, ttfb: t.responseStart - s, download: t.responseEnd - t.responseStart, domInteractive: t.domInteractive - s, dcl: t.domContentLoadedEventEnd - s, load: t.loadEventEnd - s };
    }
    const paints = (performance.getEntriesByType ? performance.getEntriesByType('paint') : []).map(function (p) { return { name: p.name, t: p.startTime }; });
    const res = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
    const byType = {};
    res.forEach(function (r) {
      const k = r.initiatorType || 'other';
      const b = byType[k] || (byType[k] = { count: 0, transfer: 0, duration: 0 });
      b.count++; b.transfer += r.transferSize || r.encodedBodySize || 0; b.duration += r.duration;
    });
    return { nav: n, paints: paints, lcp: lcpValue, cls: clsValue, resources: byType, resourceCount: res.length, now: performance.now(), domNodes: document.getElementsByTagName('*').length };
  }
  function perfRecord(a) {
    const ms = Math.min(Math.max(+a.ms || 5000, 1000), 30000);
    return new _Promise(function (resolve) {
      const frames = [];
      const lags = [];
      const t0 = performance.now();
      let done = false;
      let expected = t0 + 50;
      const iv = setInterval(function () {
        const now = performance.now();
        lags.push([now - t0, Math.max(0, now - expected)]);
        expected = now + 50;
      }, 50);
      const finish = function () {
        if (done) return;
        done = true;
        clearInterval(iv);
        resolve({ duration: ms, frames: frames, lags: lags });
      };
      const loop = function (ts) {
        if (done) return;
        frames.push(performance.now() - t0);
        if (performance.now() - t0 < ms) requestAnimationFrame(loop); else finish();
      };
      requestAnimationFrame(loop);
      _setTimeout(finish, ms + 700);
    });
  }
  async function memoryStats() {
    const all = document.getElementsByTagName('*');
    const out = {
      domNodes: all.length, listeners: listenerCount, iframes: document.getElementsByTagName('iframe').length,
      images: document.images.length, scripts: document.scripts.length, stylesheets: document.styleSheets.length,
      trackedObjects: objById.size, trackedNodes: nodeById.size, heap: null, storage: null, localStorage: 0, sessionStorage: 0, resources: 0
    };
    try { if (performance.memory) out.heap = { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit }; } catch (e) {}
    try { if (navigator.storage && navigator.storage.estimate) out.storage = await navigator.storage.estimate(); } catch (e) {}
    const sz = function (s) { let n = 0; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); n += k.length + (s.getItem(k) || '').length; } } catch (e) {} return n * 2; };
    out.localStorage = sz(window.localStorage);
    out.sessionStorage = sz(window.sessionStorage);
    try { (performance.getEntriesByType('resource') || []).forEach(function (r) { out.resources += r.transferSize || r.encodedBodySize || 0; }); } catch (e) {}
    try { const nav = performance.getEntriesByType('navigation')[0]; if (nav) out.resources += nav.transferSize || nav.encodedBodySize || 0; } catch (e) {}
    return out;
  }

  // ---------------------------------------------------------------- storage helpers
  function storageOf(type) { return type === 'session' ? window.sessionStorage : window.localStorage; }
  function idbOpen(name) {
    return new _Promise(function (resolve, reject) {
      let created = false;
      const req = indexedDB.open(name);
      req.onupgradeneeded = function () { created = true; };
      req.onsuccess = function () {
        const db = req.result;
        if (created) { db.close(); try { indexedDB.deleteDatabase(name); } catch (e) {} reject(new Error('Database not found')); return; }
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('open failed')); };
    });
  }

  // ---------------------------------------------------------------- commands
  const commands = {
    ping: function () { return { url: location.href, title: document.title }; },
    pageInfo: function () {
      return { url: location.href, title: document.title, readyState: document.readyState, charset: document.characterSet, contentType: document.contentType, referrer: document.referrer, origin: location.origin, secure: window.isSecureContext };
    },
    getDocument: function () {
      startDomWatch();
      return { root: describe(document), children: childList(document).map(describe) };
    },
    getChildren: function (a) { return childList(nodeOf(a.id)).slice(0, 3000).map(describe); },
    refreshNodes: function (a) {
      const out = [];
      (a.ids || []).forEach(function (id) {
        const n = nodeById.get(id);
        if (!n) return;
        out.push({ id: id, node: describe(n), children: a.withChildren === false ? null : childList(n).slice(0, 3000).map(describe), connected: n.isConnected !== false });
      });
      return out;
    },
    revealNode: function (a) { return revealData(nodeOf(a.id)); },
    searchNodes: function (a) {
      const q = String(a.query || '').trim();
      const out = [];
      if (!q) return out;
      if (q.charAt(0) === '/' || q.indexOf('(') === 0) {
        try {
          const r = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength && out.length < 500; i++) out.push(nodeId(r.snapshotItem(i)));
          if (out.length) return out;
        } catch (e) {}
      }
      try {
        const list = document.querySelectorAll(q);
        for (let i = 0; i < list.length && out.length < 500; i++) if (!isOverlay(list[i])) out.push(nodeId(list[i]));
        if (out.length) return out;
      } catch (e) {}
      const lq = q.toLowerCase();
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
      let n;
      while ((n = walker.nextNode()) && out.length < 500) {
        if (isOverlay(n)) continue;
        if (n.nodeType === 1) {
          let hit = n.localName.indexOf(lq) >= 0;
          for (let i = 0; !hit && i < n.attributes.length; i++) {
            if (n.attributes[i].name.toLowerCase().indexOf(lq) >= 0 || n.attributes[i].value.toLowerCase().indexOf(lq) >= 0) hit = true;
          }
          if (hit) out.push(nodeId(n));
        } else if (n.nodeValue && n.nodeValue.toLowerCase().indexOf(lq) >= 0) {
          out.push(nodeId(n));
        }
      }
      return out;
    },
    highlight: function (a) { highlightNode(nodeById.get(a.id)); return true; },
    hideHighlight: function () { hideHighlight(); return true; },
    setInspectMode: function (a) { setInspectMode(a.on); return true; },
    select: function (a) {
      const n = nodeById.get(a.id);
      if (n && selectedHistory[0] !== n) { selectedHistory.unshift(n); selectedHistory.length = Math.min(selectedHistory.length, 5); }
      return true;
    },
    nodeObject: function (a) { return ser(nodeOf(a.id), 1); },
    getOuterHTML: function (a) {
      const n = nodeOf(a.id);
      if (n.nodeType === 1) return n.outerHTML;
      if (n.nodeType === 9) return n.documentElement ? n.documentElement.outerHTML : '';
      return n.nodeValue || '';
    },
    setOuterHTML: function (a) {
      const n = nodeOf(a.id);
      const parent = n.parentNode;
      n.outerHTML = trusted(a.html);
      return parent ? nodeId(parent) : null;
    },
    setAttribute: function (a) { nodeOf(a.id).setAttribute(a.name, a.value); return true; },
    removeAttribute: function (a) { nodeOf(a.id).removeAttribute(a.name); return true; },
    setText: function (a) { nodeOf(a.id).nodeValue = a.text; return true; },
    removeNode: function (a) {
      const n = nodeOf(a.id);
      const p = n.parentNode;
      if (p) p.removeChild(n);
      return p ? nodeId(p) : null;
    },
    duplicateNode: function (a) {
      const n = nodeOf(a.id);
      n.parentNode.insertBefore(n.cloneNode(true), n.nextSibling);
      return nodeId(n.parentNode);
    },
    toggleHide: function (a) {
      const n = nodeOf(a.id);
      if (n.style.visibility === 'hidden') n.style.removeProperty('visibility');
      else n.style.setProperty('visibility', 'hidden', 'important');
      return true;
    },
    scrollIntoView: function (a) {
      const n = nodeOf(a.id);
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      return true;
    },
    nodePaths: function (a) {
      const n = nodeOf(a.id);
      let js = '';
      if (n.nodeType === 1) js = 'document.querySelector(' + _stringify(cssPath(n)) + ')';
      return { selector: cssPath(n), jsPath: js, xpath: xPath(n), outerHTML: n.outerHTML || n.nodeValue || '' };
    },
    getStyles: function (a) { return getStyles(nodeOf(a.id)); },
    setInlineStyle: function (a) { nodeOf(a.id).style.cssText = a.cssText; return true; },
    setRuleStyle: function (a) {
      const r = objById.get(a.ruleId);
      if (!r || !r.style) throw new Error('Rule not found');
      r.style.cssText = a.cssText;
      return true;
    },
    getComputed: function (a) {
      const n = nodeOf(a.id);
      if (n.nodeType !== 1) return [];
      const cs = _getComputedStyle(n);
      const out = [];
      for (let i = 0; i < cs.length; i++) out.push([cs[i], cs.getPropertyValue(cs[i])]);
      out.sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; });
      return out;
    },
    getBox: function (a) {
      const n = nodeOf(a.id);
      if (n.nodeType !== 1) return null;
      const cs = _getComputedStyle(n);
      const r = n.getBoundingClientRect();
      const four = function (pre, post) { return ['Top', 'Right', 'Bottom', 'Left'].map(function (s) { return parseFloat(cs[pre + s + (post || '')]) || 0; }); };
      const m = four('margin'), b = four('border', 'Width'), p = four('padding');
      return {
        margin: m, border: b, padding: p,
        width: Math.max(0, r.width - b[1] - b[3] - p[1] - p[3]), height: Math.max(0, r.height - b[0] - b[2] - p[0] - p[2]),
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
        position: cs.position, display: cs.display, boxSizing: cs.boxSizing, zIndex: cs.zIndex, float: cs.cssFloat || cs.float,
        posValues: [cs.top, cs.right, cs.bottom, cs.left], fontFamily: cs.fontFamily, fontSize: cs.fontSize, color: cs.color, background: cs.backgroundColor
      };
    },
    getListeners: function (a) {
      const n = nodeOf(a.id);
      const targets = [];
      let cur = n;
      while (cur) { targets.push(cur); if (!a.ancestors) break; cur = parentOf(cur); }
      if (a.ancestors) targets.push(window);
      const out = [];
      targets.forEach(function (t) {
        const owner = t === window ? 'Window' : nodeLabel(t);
        const ownerId = t === window ? 'window' : nodeId(t);
        (listenerMap.get(t) || []).forEach(function (l, idx) {
          let src = '';
          try { src = truncate(Function.prototype.toString.call(l.fn), 400); } catch (e) { src = typeof l.fn === 'object' ? '[object handleEvent]' : ''; }
          out.push({ type: l.type, owner: owner, ownerId: ownerId, idx: idx, capture: l.capture, passive: l.passive, once: l.once, src: src, fn: ser(l.fn, 0) });
        });
        if (t !== window && t.nodeType === 1) {
          for (let i = 0; i < t.attributes.length; i++) {
            const an = t.attributes[i].name;
            if (/^on/.test(an)) out.push({ type: an.slice(2), owner: owner, ownerId: ownerId, idx: -1, attr: true, capture: false, passive: false, once: false, src: truncate(t.attributes[i].value, 400) });
          }
        }
      });
      return out;
    },
    removeListener: function (a) {
      const t = a.ownerId === 'window' ? window : nodeOf(a.ownerId);
      const arr = listenerMap.get(t) || [];
      const l = arr[a.idx];
      if (!l) throw new Error('Listener not found');
      t.removeEventListener(l.type, l.fn, l.capture);
      return true;
    },
    getProperties: getProperties,
    invokeGetter: invokeGetter,
    storeGlobal: function (a) {
      const v = a.nodeId ? nodeOf(a.nodeId) : objById.get(a.id);
      let i = 1;
      while (('temp' + i) in window) i++;
      window['temp' + i] = v;
      return 'temp' + i;
    },
    complete: function (a) {
      let o = window;
      if (a.path) {
        const parts = a.path.split('.');
        for (let i = 0; i < parts.length; i++) {
          if (o === null || o === undefined) return [];
          try { o = o[parts[i]]; } catch (e) { return []; }
        }
      }
      if (o === null || o === undefined) return [];
      const seen = new Set();
      let cur = (typeof o === 'object' || typeof o === 'function') ? o : Object(o);
      let depth = 0;
      while (cur && depth < 25) {
        let names = [];
        try { names = Object.getOwnPropertyNames(cur); } catch (e) {}
        names.forEach(function (n) { if (/^[A-Za-z_$][\w$]*$/.test(n)) seen.add(n); });
        try { cur = Object.getPrototypeOf(cur); } catch (e) { cur = null; }
        depth++;
      }
      if (!a.path) {
        ['$0', '$_', '$', '$$', '$x', 'copy', 'clear', 'inspect', 'keys', 'values', 'getEventListeners', 'monitorEvents',
          'await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
          'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null',
          'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'].forEach(function (n) { seen.add(n); });
      }
      const p = a.prefix || '';
      const lower = p.toLowerCase();
      const res = Array.from(seen).filter(function (n) { return n !== p && n.toLowerCase().indexOf(lower) === 0; });
      res.sort(function (x, y) {
        const xs = x.indexOf(p) === 0 ? 0 : 1, ys = y.indexOf(p) === 0 ? 0 : 1;
        return (xs - ys) || (x.length - y.length) || (x < y ? -1 : 1);
      });
      return res.slice(0, 60);
    },
    getResources: function () {
      const scripts = [];
      Array.prototype.forEach.call(document.scripts, function (s, i) {
        if (s.src) scripts.push({ url: s.src, kind: 'script' });
        else scripts.push({ inline: i, kind: 'script', len: s.textContent.length, type: s.type || '' });
      });
      const styles = [];
      Array.prototype.forEach.call(document.querySelectorAll('link[rel~="stylesheet"][href], style'), function (s, i) {
        if (s.localName === 'link') styles.push({ url: s.href, kind: 'style' });
        else styles.push({ inline: i, kind: 'style', len: s.textContent.length });
      });
      const frames = [];
      Array.prototype.forEach.call(document.querySelectorAll('iframe[src]'), function (f) { frames.push({ url: f.src, kind: 'frame' }); });
      return { url: location.href, title: document.title, scripts: scripts, styles: styles, frames: frames };
    },
    getInlineSource: function (a) {
      if (a.kind === 'script') { const s = document.scripts[a.index]; return s ? s.textContent : ''; }
      const s = document.querySelectorAll('link[rel~="stylesheet"][href], style')[a.index];
      return s ? s.textContent : '';
    },
    documentHTML: function () {
      const dt = document.doctype;
      return (dt ? '<!DOCTYPE ' + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') + (dt.systemId ? ' "' + dt.systemId + '"' : '') + '>\n' : '') + (document.documentElement ? document.documentElement.outerHTML : '');
    },
    storageList: function (a) {
      const s = storageOf(a.type);
      const out = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push([k, s.getItem(k)]); }
      return out;
    },
    storageSet: function (a) {
      const s = storageOf(a.type);
      if (a.oldKey !== undefined && a.oldKey !== null && a.oldKey !== a.key) s.removeItem(a.oldKey);
      s.setItem(a.key, a.value);
      return true;
    },
    storageRemove: function (a) { storageOf(a.type).removeItem(a.key); return true; },
    storageClear: function (a) { storageOf(a.type).clear(); return true; },
    idbList: async function () {
      if (!window.indexedDB) return { unsupported: true };
      if (!indexedDB.databases) return { unsupported: true, reason: 'indexedDB.databases() is not supported' };
      const dbs = await indexedDB.databases();
      const out = [];
      for (let i = 0; i < dbs.length; i++) {
        const info = dbs[i];
        let stores = [];
        try {
          const db = await idbOpen(info.name);
          stores = Array.prototype.slice.call(db.objectStoreNames);
          db.close();
        } catch (e) {}
        out.push({ name: info.name, version: info.version, stores: stores });
      }
      return { dbs: out };
    },
    idbEntries: async function (a) {
      const db = await idbOpen(a.db);
      try {
        const tx = db.transaction(a.store, 'readonly');
        const os = tx.objectStore(a.store);
        const info = { keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes: Array.prototype.slice.call(os.indexNames), entries: [], total: 0 };
        info.total = await new _Promise(function (res) { const r = os.count(); r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(0); }; });
        await new _Promise(function (res) {
          const req = os.openCursor();
          req.onsuccess = function () {
            const c = req.result;
            if (!c || info.entries.length >= (a.limit || 200)) { res(); return; }
            info.entries.push({ key: ser(c.key, 1), primaryKey: ser(c.primaryKey, 0), value: ser(c.value, 1) });
            c.continue();
          };
          req.onerror = function () { res(); };
        });
        return info;
      } finally { db.close(); }
    },
    idbClear: async function (a) {
      const db = await idbOpen(a.db);
      try {
        await new _Promise(function (res, rej) {
          const tx = db.transaction(a.store, 'readwrite');
          tx.objectStore(a.store).clear();
          tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
        });
      } finally { db.close(); }
      return true;
    },
    idbDelete: function (a) {
      return new _Promise(function (res, rej) {
        const r = indexedDB.deleteDatabase(a.db);
        r.onsuccess = function () { res(true); }; r.onerror = function () { rej(r.error); }; r.onblocked = function () { res(false); };
      });
    },
    cacheList: async function () {
      if (!window.caches) return { unsupported: true };
      return { names: await caches.keys() };
    },
    cacheEntries: async function (a) {
      const c = await caches.open(a.name);
      const reqs = await c.keys();
      const out = [];
      for (let i = 0; i < reqs.length && i < 500; i++) {
        let res = null;
        try { res = await c.match(reqs[i]); } catch (e) {}
        out.push({ url: reqs[i].url, method: reqs[i].method, status: res ? res.status : 0, type: res ? (res.headers.get('content-type') || '') : '', size: res ? (+res.headers.get('content-length') || 0) : 0 });
      }
      return out;
    },
    cacheDelete: async function (a) {
      if (a.url) { const c = await caches.open(a.name); return c.delete(a.url); }
      return caches.delete(a.name);
    },
    swList: async function () {
      if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return { unsupported: true };
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        regs: regs.map(function (r) {
          const w = r.active || r.waiting || r.installing;
          return { scope: r.scope, script: w ? w.scriptURL : '', state: w ? w.state : 'none', waiting: !!r.waiting, installing: !!r.installing };
        })
      };
    },
    swUnregister: async function (a) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (let i = 0; i < regs.length; i++) if (regs[i].scope === a.scope) return regs[i].unregister();
      return false;
    },
    swUpdate: async function (a) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (let i = 0; i < regs.length; i++) if (regs[i].scope === a.scope) { await regs[i].update(); return true; }
      return false;
    },
    manifestUrl: function () {
      const l = document.querySelector('link[rel="manifest"]');
      return l ? l.href : null;
    },
    perfMetrics: perfMetrics,
    perfRecord: perfRecord,
    memoryStats: memoryStats,
    frameUrls: function () {
      return Array.prototype.map.call(document.querySelectorAll('iframe'), function (f) { return f.src || 'about:blank'; });
    }
  };

  async function handle(cmd, a) {
    const fn = commands[cmd];
    if (!fn) throw new Error('Unknown command: ' + cmd);
    const r = await fn(a || {});
    return _stringify(r === undefined ? null : r);
  }

  Object.defineProperty(window, '__iosDevTools', {
    value: Object.freeze({ handle: handle, captureValue: captureValue, captureError: captureError, installAPI: installAPI, uninstallAPI: uninstallAPI }),
    configurable: false, enumerable: false, writable: false
  });

  // ---------------------------------------------------------------- lifecycle events
  if (isTop) {
    emit('hello', { url: location.href, timeOrigin: performance.timeOrigin || Date.now() });
    _add.call(document, 'DOMContentLoaded', function () { emit('domReady', { url: location.href, title: document.title }); });
    _add.call(window, 'load', function () {
      _setTimeout(function () {
        try {
          const nav = performance.getEntriesByType('navigation')[0];
          emit('load', {
            url: location.href, title: document.title,
            nav: nav ? { wall: performance.timeOrigin + nav.startTime, duration: nav.responseEnd - nav.startTime, transfer: nav.transferSize || 0, decoded: nav.decodedBodySize || 0, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, protocol: nav.nextHopProtocol || '' } : null
          });
        } catch (e) { emit('load', { url: location.href, title: document.title }); }
      }, 0);
    });
  }
  _add.call(window, 'pagehide', flush);
})();
//# sourceURL=ios-devtools-agent.js
