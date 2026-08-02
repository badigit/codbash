// FORK-LOCAL (badigit/codbash, ветка dim). Апстриму не принадлежит.
//
// Вид «Работа»: слева сессии, сгруппированные по проекту, справа — чат выбранной.
// Стандартные виды не трогаем: этот файл прячет #content и показывает свой
// #workView, а на клик по любому другому пункту сайдбара возвращает как было.
// Точки подключения в апстримных файлах — минимальны (index.html, html.js,
// sidebar-config.js), чтобы rebase на upstream/main оставался дешёвым.
(function () {
  'use strict';

  var VIEW_KEY = 'work';
  var OPEN_PROJECTS = 3;   // сколько верхних проектов развёрнуто на старте
  var PAGE = 12;           // сессий в проекте до кнопки «ещё»
  var state = {
    sessions: [],
    active: {},          // id -> true, сессии с живым процессом
    byProject: [],       // [{ path, name, sessions: [], lastTs }]
    collapsed: {},       // path -> true
    shown: {},           // path -> сколько сессий показано
    touched: {},         // path -> пользователь сам менял сворачивание
    selectedId: null,
    filter: '',
    loaded: false,
  };

  // ---------- утилиты ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Имя проекта = имя папки, а не весь путь: путь в заголовке нечитаем.
  function folderName(p) {
    if (!p) return '(без проекта)';
    var parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function sessionTitle(s) {
    var t = s.session_name || s.recap || s.first_message || '';
    t = String(t).replace(/\s+/g, ' ').trim();
    if (!t) t = '(без названия)';
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }

  function tsOf(s) {
    return Number(s.last_ts || s.first_ts || 0) || 0;
  }

  function relTime(ts) {
    if (!ts) return '';
    var ms = ts < 1e12 ? ts * 1000 : ts;          // секунды или миллисекунды
    var diff = Date.now() - ms;
    if (diff < 0) diff = 0;
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' ч';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' дн';
    return new Date(ms).toLocaleDateString();
  }

  function fullTime(ts) {
    if (!ts) return '';
    var ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toLocaleString();
  }

  // Минимальный markdown: fenced-блоки и `inline`. Апстрим отдаёт всё через
  // escHtml в <pre>, поэтому ``` в чате не форматируется — чиним локально.
  // Специально без библиотек: у проекта zero-dependency ядро.
  function renderContent(text) {
    var src = String(text == null ? '' : text);
    var out = '';
    var re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
    var last = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      out += inlineCode(esc(src.slice(last, m.index)));
      var lang = m[1] ? ' data-lang="' + esc(m[1]) + '"' : '';
      out += '<pre class="work-code"' + lang + '><code>' + esc(m[2].replace(/\n$/, '')) + '</code></pre>';
      last = re.lastIndex;
    }
    out += inlineCode(esc(src.slice(last)));
    return out;
  }

  function inlineCode(escaped) {
    return escaped.replace(/`([^`\n]+)`/g, '<code class="work-inline">$1</code>');
  }

  // ---------- данные ----------

  function fetchSessions(limit) {
    var q = limit ? '?limit=' + limit : '';
    return fetch('/api/sessions' + q).then(function (r) { return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : (d.sessions || []); });
  }

  // Один запрос: сервер держит разобранные сессии в кэше и отдаёт полный список
  // за ~0.2 c. Дорог только первый вызов после старта сервиса (прогрев, 2–6 c) —
  // на это время показываем «Загружаю сессии…».
  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    var active = fetch('/api/active').then(function (r) { return r.json(); }).catch(function () { return []; });
    return Promise.all([fetchSessions(0), active]).then(function (res) {
      state.sessions = res[0];
      var act = Array.isArray(res[1]) ? res[1] : (res[1].sessions || res[1].active || []);
      state.active = {};
      act.forEach(function (a) {
        var id = a && (a.id || a.session_id || a.sessionId);
        if (id) state.active[id] = true;
      });
      group();
      state.loaded = true;
    });
  }

  // Сессии из .claude/worktrees/<ветка> принадлежат своему репо, а не отдельному
  // «проекту»: иначе одна фича-ветка = новая строка в списке, и он раздувается
  // (на этой машине 229 групп вместо ~70). git_root у части сессий пуст, поэтому
  // режем путь сами.
  function repoRoot(p) {
    if (!p) return '';
    var m = String(p).match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/);
    return m ? m[1] : p;
  }

  function group() {
    var map = {};
    state.sessions.forEach(function (s) {
      var key = repoRoot(s.git_root || s.project || '');
      if (!map[key]) map[key] = { path: key, name: folderName(key), sessions: [], lastTs: 0 };
      map[key].sessions.push(s);
      var t = tsOf(s);
      if (t > map[key].lastTs) map[key].lastTs = t;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.forEach(function (p) {
      p.sessions.sort(function (a, b) { return tsOf(b) - tsOf(a); });
    });
    // Наверх — недавние проекты, внутри — недавние сессии.
    arr.sort(function (a, b) { return b.lastTs - a.lastTs; });
    state.byProject = arr;
    // Развёрнуты только несколько верхних: иначе список — это тысячи строк
    // (на этой машине 2134). Дефолт пересчитываем при каждой загрузке — иначе
    // проекты, появившиеся после первого рендера, остаются развёрнутыми, — но
    // то, что пользователь свернул/развернул руками, не трогаем.
    arr.forEach(function (p, i) {
      if (!state.touched[p.path]) state.collapsed[p.path] = i >= OPEN_PROJECTS;
    });
  }

  // Сессия «требует действий»: процесс жив, а последним говорил агент —
  // значит ждёт тебя. Пока /api/active пуст, точка просто не появляется.
  function needsAttention(s) {
    if (!state.active[s.id]) return false;
    var role = s.last_role || (s.last_message && s.last_message.role) || '';
    return role !== 'user';
  }

  // ---------- рендер ----------

  function render() {
    var host = document.getElementById('workView');
    if (!host) return;
    host.innerHTML =
      '<div class="work-wrap">' +
        '<aside class="work-side">' +
          '<div class="work-side-head">' +
            '<input id="workFilter" class="work-filter" type="search" placeholder="Фильтр по проекту или сессии…" value="' + esc(state.filter) + '">' +
            '<button id="workReload" class="work-btn" title="Обновить">⟳</button>' +
          '</div>' +
          '<div class="work-list" id="workList">' + renderList() + '</div>' +
        '</aside>' +
        '<main class="work-main" id="workMain">' + renderPlaceholder() + '</main>' +
      '</div>';
    bind();
  }

  function renderPlaceholder() {
    return '<div class="work-empty">Выбери сессию слева</div>';
  }

  function renderList() {
    var q = state.filter.trim().toLowerCase();
    var html = '';
    var shown = 0;
    state.byProject.forEach(function (p) {
      var sessions = p.sessions;
      if (q) {
        var pn = p.name.toLowerCase();
        if (pn.indexOf(q) === -1) {
          sessions = sessions.filter(function (s) { return sessionTitle(s).toLowerCase().indexOf(q) !== -1; });
        }
      }
      if (!sessions.length) return;
      shown++;
      var isCollapsed = !!state.collapsed[p.path] && !q;
      var attention = sessions.some(needsAttention);
      html += '<div class="work-proj' + (isCollapsed ? ' collapsed' : '') + '">' +
        '<div class="work-proj-head" data-proj="' + esc(p.path) + '" title="' + esc(p.path) + '">' +
          '<span class="work-caret">' + (isCollapsed ? '▸' : '▾') + '</span>' +
          '<span class="work-proj-name">' + esc(p.name) + '</span>' +
          (attention ? '<span class="work-dot" title="есть сессии, ждущие ответа"></span>' : '') +
          '<span class="work-proj-count">' + sessions.length + '</span>' +
          '<span class="work-proj-time">' + esc(relTime(p.lastTs)) + '</span>' +
        '</div>';
      if (!isCollapsed) {
        html += '<div class="work-proj-body">';
        var limit = state.shown[p.path] || PAGE;
        sessions.slice(0, limit).forEach(function (s) {
          var sel = s.id === state.selectedId ? ' selected' : '';
          html += '<div class="work-item' + sel + '" data-id="' + esc(s.id) + '" title="' + esc(fullTime(tsOf(s))) + '">' +
            '<span class="work-label">' + esc(p.name) + '</span>' +
            '<span class="work-title">' + esc(sessionTitle(s)) + '</span>' +
            (needsAttention(s) ? '<span class="work-dot"></span>' : '') +
            '<span class="work-time">' + esc(relTime(tsOf(s))) + '</span>' +
          '</div>';
        });
        if (sessions.length > limit) {
          html += '<div class="work-more" data-more="' + esc(p.path) + '">' +
                    'ещё ' + (sessions.length - limit) + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    });
    if (!shown) html = '<div class="work-empty">Ничего не найдено</div>';
    return html;
  }

  function openSession(id) {
    state.selectedId = id;
    var list = document.getElementById('workList');
    if (list) list.innerHTML = renderList();
    bindList();
    var main = document.getElementById('workMain');
    if (!main) return;
    var meta = null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) { meta = state.sessions[i]; break; }
    }
    main.innerHTML = '<div class="work-empty">Загружаю…</div>';
    fetch('/api/session/' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var msgs = d.messages || d.detail_messages || [];
        var head = '<div class="work-chat-head">' +
            '<div class="work-chat-title">' + esc(meta ? sessionTitle(meta) : id) + '</div>' +
            '<div class="work-chat-sub">' +
              (meta ? esc(folderName(meta.git_root || meta.project)) + ' · ' + esc(fullTime(tsOf(meta))) + ' · ' : '') +
              msgs.length + ' сообщений' +
            '</div>' +
          '</div>';
        var body = '';
        msgs.forEach(function (m) {
          var role = m.role === 'user' ? 'user' : 'assistant';
          body += '<div class="work-msg work-' + role + '">' +
            '<div class="work-msg-role">' + (role === 'user' ? 'Ты' : 'Агент') + '</div>' +
            '<div class="work-msg-body">' + renderContent(m.content) + '</div>' +
          '</div>';
        });
        main.innerHTML = head + '<div class="work-chat">' + (body || '<div class="work-empty">Пусто</div>') + '</div>';
      })
      .catch(function (e) {
        main.innerHTML = '<div class="work-empty">Не удалось загрузить сессию: ' + esc(e && e.message) + '</div>';
      });
  }

  // ---------- события ----------

  function bindList() {
    var list = document.getElementById('workList');
    if (!list) return;
    list.querySelectorAll('.work-proj-head').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = el.getAttribute('data-proj');
        state.collapsed[p] = !state.collapsed[p];
        state.touched[p] = true;
        list.innerHTML = renderList();
        bindList();
      });
    });
    list.querySelectorAll('.work-item').forEach(function (el) {
      el.addEventListener('click', function () { openSession(el.getAttribute('data-id')); });
    });
    list.querySelectorAll('.work-more').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = el.getAttribute('data-more');
        state.shown[p] = (state.shown[p] || PAGE) + 40;
        list.innerHTML = renderList();
        bindList();
      });
    });
  }

  function bind() {
    bindList();
    var f = document.getElementById('workFilter');
    if (f) {
      f.addEventListener('input', function () {
        state.filter = f.value;
        var list = document.getElementById('workList');
        if (list) { list.innerHTML = renderList(); bindList(); }
      });
    }
    var r = document.getElementById('workReload');
    if (r) {
      r.addEventListener('click', function () {
        r.disabled = true;
        load(true).then(function () { render(); }).catch(function () { r.disabled = false; });
      });
    }
  }

  // ---------- показ/скрытие вида ----------

  function show() {
    var content = document.getElementById('content');
    var host = document.getElementById('workView');
    if (!host) return;
    if (content) content.style.display = 'none';
    host.style.display = 'block';
    document.querySelectorAll('.sidebar-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === VIEW_KEY);
    });
    if (!state.loaded) {
      host.innerHTML = '<div class="work-empty">Загружаю сессии…</div>';
      load().then(render).catch(function (e) {
        host.innerHTML = '<div class="work-empty">Ошибка загрузки: ' + esc(e && e.message) + '</div>';
      });
    } else {
      render();
    }
  }

  function hide() {
    var content = document.getElementById('content');
    var host = document.getElementById('workView');
    if (host) host.style.display = 'none';
    if (content) content.style.display = '';
  }

  // Стили держим здесь, а не в styles.css: так правка апстримных файлов
  // ограничена двумя вставками в index.html и одной строкой в html.js.
  var CSS = [
    '#workView { display: none; height: 100%; }',
    '.work-wrap { display: grid; grid-template-columns: minmax(280px, 26%) 1fr; height: calc(100vh - 8px); overflow: hidden; }',
    '.work-side { border-right: 1px solid var(--border, #2a2a2a); display: flex; flex-direction: column; min-width: 0; }',
    '.work-side-head { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border, #2a2a2a); }',
    '.work-filter { flex: 1; min-width: 0; padding: 5px 8px; font: inherit; font-size: 12px; background: var(--input-bg, #1a1a1a); color: var(--fg, #ddd); border: 1px solid var(--border, #2a2a2a); border-radius: 5px; }',
    '.work-btn { padding: 4px 9px; font-size: 13px; cursor: pointer; background: var(--input-bg, #1a1a1a); color: var(--fg, #ddd); border: 1px solid var(--border, #2a2a2a); border-radius: 5px; }',
    '.work-list { flex: 1; overflow-y: auto; padding: 4px 0; }',
    '.work-proj-head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--fg, #ddd); }',
    '.work-proj-head:hover { background: var(--input-bg, #1a1a1a); }',
    '.work-caret { width: 10px; color: var(--muted, #888); }',
    '.work-proj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.work-proj-count { font-size: 10px; color: var(--muted, #888); font-variant-numeric: tabular-nums; }',
    '.work-proj-time { font-size: 10px; color: var(--muted, #888); min-width: 46px; text-align: right; }',
    '.work-item { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 4px 22px; cursor: pointer; font-size: 12px; line-height: 1.35; }',
    '.work-item:hover { background: var(--input-bg, #1a1a1a); }',
    '.work-item.selected { background: var(--input-bg, #1a1a1a); box-shadow: inset 2px 0 0 var(--accent, #6aa6ff); }',
    '.work-label { flex: 0 0 auto; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted, #888); font-size: 10px; }',
    '.work-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #ddd); }',
    '.work-time { flex: 0 0 auto; font-size: 10px; color: var(--muted, #888); }',
    '.work-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: #e2b93b; box-shadow: 0 0 0 2px rgba(226,185,59,.18); }',
    '.work-main { overflow-y: auto; min-width: 0; }',
    '.work-chat-head { position: sticky; top: 0; padding: 10px 14px; border-bottom: 1px solid var(--border, #2a2a2a); background: var(--bg, #111); }',
    '.work-chat-title { font-size: 13px; font-weight: 600; color: var(--fg, #ddd); }',
    '.work-chat-sub { font-size: 11px; color: var(--muted, #888); margin-top: 2px; }',
    '.work-chat { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }',
    '.work-msg { display: grid; grid-template-columns: 52px 1fr; gap: 10px; align-items: start; }',
    '.work-msg-role { font-size: 10px; color: var(--muted, #888); padding-top: 2px; }',
    '.work-msg-body { font-size: 12.5px; line-height: 1.5; color: var(--fg, #ddd); white-space: pre-wrap; word-break: break-word; min-width: 0; }',
    '.work-user .work-msg-body { color: var(--accent, #6aa6ff); }',
    '.work-code { white-space: pre; overflow-x: auto; background: var(--input-bg, #1a1a1a); border: 1px solid var(--border, #2a2a2a); border-radius: 6px; padding: 8px 10px; margin: 6px 0; font-size: 11.5px; }',
    '.work-inline { background: var(--input-bg, #1a1a1a); border-radius: 3px; padding: 0 4px; font-size: 11.5px; }',
    '.work-more { padding: 3px 8px 5px 22px; font-size: 11px; color: var(--muted, #888); cursor: pointer; }',
    '.work-more:hover { color: var(--fg, #ddd); text-decoration: underline; }',
    '.work-empty { padding: 24px; color: var(--muted, #888); font-size: 12px; }',
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('work-view-styles')) return;
    var st = document.createElement('style');
    st.id = 'work-view-styles';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function init() {
    injectStyles();
    document.querySelectorAll('.sidebar-item').forEach(function (el) {
      var view = el.getAttribute('data-view');
      if (view === VIEW_KEY) {
        el.addEventListener('click', function (e) { e.stopPropagation(); show(); }, true);
      } else {
        el.addEventListener('click', function () { hide(); }, true);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.WorkView = { show: show, hide: hide, reload: function () { return load(true).then(render); } };
})();
