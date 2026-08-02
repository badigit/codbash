// FORK-LOCAL (badigit/codbash, ветка dim). Апстриму не принадлежит.
//
// Вид «Работа»: слева сессии, сгруппированные по проекту, справа — чат выбранной.
// Сверху — две автоматические группы по состоянию агента (как на Agent Board):
// «Требует ответа» и «Работает». Данные о живых сессиях берём у своего
// эндпоинта /api/work/live — апстримный /api/active на Windows всегда пуст.
//
// Стандартные виды не трогаем: файл прячет #content и показывает свой #workView.
(function () {
  'use strict';

  var VIEW_KEY = 'work';
  var OPEN_PROJECTS = 3;    // сколько верхних проектов развёрнуто на старте
  var PAGE = 12;            // сессий в проекте до кнопки «ещё»
  var LIVE_POLL_MS = 15000; // как часто обновляем состояние живых сессий
  var PERIODS = [
    { key: 7, label: '7 дней' },
    { key: 30, label: '30 дней' },
    { key: 0, label: 'всё' },
  ];

  var state = {
    sessions: [],
    live: {},            // id -> { state: 'working'|'waiting', ... }
    byProject: [],
    collapsed: {},       // path -> true
    touched: {},         // path -> пользователь сам менял сворачивание
    shown: {},           // path -> сколько сессий показано
    selectedId: null,
    filter: '',
    period: 7,           // дней; 0 — без ограничения
    loaded: false,
    pollTimer: null,
  };

  try {
    var savedPeriod = parseInt(localStorage.getItem('codbash-work-period'), 10);
    if (!isNaN(savedPeriod)) state.period = savedPeriod;
  } catch (e) { /* остаёмся на дефолте */ }

  // ---------- утилиты ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Имя проекта = имя папки: весь путь в заголовке нечитаем.
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

  function tsOf(s) { return Number(s.last_ts || s.first_ts || 0) || 0; }
  function toMs(ts) { return ts < 1e12 ? ts * 1000 : ts; }

  function relTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - toMs(ts);
    if (diff < 0) diff = 0;
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' ч';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' дн';
    return new Date(toMs(ts)).toLocaleDateString();
  }

  function fullTime(ts) { return ts ? new Date(toMs(ts)).toLocaleString() : ''; }

  // Минимальный markdown: fenced-блоки и `inline`. Апстрим отдаёт содержимое
  // экранированным в <pre>, поэтому разметка в чате не работает. Без библиотек —
  // у проекта zero-dependency ядро.
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

  function fetchJson(url, fallback) {
    return fetch(url).then(function (r) { return r.json(); }).catch(function () { return fallback; });
  }

  // Один запрос за списком: сервер держит разобранные сессии в кэше и отдаёт их
  // за ~0.2 c. Дорог только первый вызов после старта сервиса (прогрев).
  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    return Promise.all([
      fetchJson('/api/sessions', []),
      fetchJson('/api/work/live', []),
    ]).then(function (res) {
      state.sessions = Array.isArray(res[0]) ? res[0] : (res[0].sessions || []);
      applyLive(res[1]);
      group();
      state.loaded = true;
    });
  }

  function applyLive(list) {
    state.live = {};
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (s && s.id) state.live[s.id] = s;
    });
  }

  // Тихое обновление: список сессий не перезапрашиваем, только состояние живых.
  function pollLive() {
    var host = document.getElementById('workView');
    if (!host || host.style.display === 'none') return Promise.resolve();
    return fetchJson('/api/work/live', []).then(function (list) {
      applyLive(list);
      var listEl = document.getElementById('workList');
      if (listEl) { listEl.innerHTML = renderList(); bindList(); }
    });
  }

  // Сессии из .claude/worktrees/<ветка> принадлежат своему репо, а не отдельному
  // «проекту»: иначе каждая фича-ветка — новая строка в списке.
  function repoRoot(p) {
    if (!p) return '';
    var m = String(p).match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/);
    return m ? m[1] : p;
  }

  function withinPeriod(s) {
    if (!state.period) return true;
    var ts = tsOf(s);
    if (!ts) return false;
    return Date.now() - toMs(ts) <= state.period * 86400000;
  }

  function group() {
    var map = {};
    state.sessions.forEach(function (s) {
      if (!withinPeriod(s)) return;
      var key = repoRoot(s.git_root || s.project || '');
      if (!map[key]) map[key] = { path: key, name: folderName(key), sessions: [], lastTs: 0 };
      map[key].sessions.push(s);
      var t = tsOf(s);
      if (t > map[key].lastTs) map[key].lastTs = t;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.forEach(function (p) { p.sessions.sort(function (a, b) { return tsOf(b) - tsOf(a); }); });
    arr.sort(function (a, b) { return b.lastTs - a.lastTs; });
    state.byProject = arr;
    // Дефолт сворачивания пересчитываем каждый раз (иначе проекты, появившиеся
    // после первого рендера, остаются развёрнутыми), но ручной выбор не трогаем.
    arr.forEach(function (p, i) {
      if (!state.touched[p.path]) state.collapsed[p.path] = i >= OPEN_PROJECTS;
    });
  }

  // Живые сессии показываем всегда, даже если они старше выбранного периода.
  function liveGroup(kind) {
    var ids = Object.keys(state.live).filter(function (id) { return state.live[id].state === kind; });
    if (!ids.length) return [];
    var byId = {};
    state.sessions.forEach(function (s) { byId[s.id] = s; });
    return ids.map(function (id) {
      var meta = state.live[id];
      return byId[id] || {
        id: id,
        session_name: meta.name || id.slice(0, 8),
        project: meta.cwd,
        git_root: meta.cwd,
        last_ts: meta.lastTs || meta.startedAt || 0,
      };
    }).sort(function (a, b) { return tsOf(b) - tsOf(a); });
  }

  // ---------- рендер ----------

  function render() {
    var host = document.getElementById('workView');
    if (!host) return;
    host.innerHTML =
      '<div class="work-wrap">' +
        '<aside class="work-side">' +
          '<div class="work-side-head">' +
            '<input id="workFilter" class="work-filter" type="search" placeholder="Фильтр…" value="' + esc(state.filter) + '">' +
            '<select id="workPeriod" class="work-period" title="Период">' +
              PERIODS.map(function (p) {
                return '<option value="' + p.key + '"' + (p.key === state.period ? ' selected' : '') + '>' + p.label + '</option>';
              }).join('') +
            '</select>' +
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

  function matches(s, q, projName) {
    if (!q) return true;
    if (projName && projName.toLowerCase().indexOf(q) !== -1) return true;
    return sessionTitle(s).toLowerCase().indexOf(q) !== -1;
  }

  // Строка сессии. Внутри проектной группы имя проекта не дублируем — оно уже
  // в заголовке группы; в группах по состоянию сессии из разных проектов,
  // поэтому там метка нужна.
  function renderItem(s, withLabel) {
    var live = state.live[s.id];
    var dot = '';
    if (live && live.state === 'waiting') dot = '<span class="work-dot work-dot-wait" title="ждёт ответа"></span>';
    else if (live && live.state === 'working') dot = '<span class="work-dot work-dot-run" title="агент работает"></span>';
    return '<div class="work-item' + (s.id === state.selectedId ? ' selected' : '') + '"' +
        ' data-id="' + esc(s.id) + '" title="' + esc(fullTime(tsOf(s))) + '">' +
      (withLabel ? '<span class="work-label">' + esc(folderName(repoRoot(s.git_root || s.project))) + '</span>' : '') +
      '<span class="work-title">' + esc(sessionTitle(s)) + '</span>' +
      dot +
      '<span class="work-time">' + esc(relTime(tsOf(s))) + '</span>' +
    '</div>';
  }

  function renderStateGroup(kind, title, cls) {
    var items = liveGroup(kind);
    var q = state.filter.trim().toLowerCase();
    if (q) items = items.filter(function (s) { return matches(s, q, folderName(repoRoot(s.git_root || s.project))); });
    if (!items.length) return '';
    var key = '@' + kind;
    var isCollapsed = !!state.collapsed[key] && !q;
    var html = '<div class="work-proj work-state ' + cls + (isCollapsed ? ' collapsed' : '') + '">' +
      '<div class="work-proj-head" data-proj="' + key + '">' +
        '<span class="work-caret">' + (isCollapsed ? '▸' : '▾') + '</span>' +
        '<span class="work-proj-name">' + esc(title) + '</span>' +
        '<span class="work-proj-count">' + items.length + '</span>' +
      '</div>';
    if (!isCollapsed) {
      html += '<div class="work-proj-body">';
      items.forEach(function (s) { html += renderItem(s, true); });
      html += '</div>';
    }
    return html + '</div>';
  }

  function renderList() {
    var q = state.filter.trim().toLowerCase();
    // Сверху — состояние агентов, как на Agent Board.
    var html = renderStateGroup('waiting', 'Требует ответа', 'work-need') +
               renderStateGroup('working', 'Работает', 'work-run');
    var projects = 0;

    state.byProject.forEach(function (p) {
      var sessions = p.sessions;
      if (q) sessions = sessions.filter(function (s) { return matches(s, q, p.name); });
      if (!sessions.length) return;
      projects++;
      var isCollapsed = !!state.collapsed[p.path] && !q;
      html += '<div class="work-proj' + (isCollapsed ? ' collapsed' : '') + '">' +
        '<div class="work-proj-head" data-proj="' + esc(p.path) + '" title="' + esc(p.path) + '">' +
          '<span class="work-caret">' + (isCollapsed ? '▸' : '▾') + '</span>' +
          '<span class="work-proj-name">' + esc(p.name) + '</span>' +
          '<span class="work-proj-count">' + sessions.length + '</span>' +
          '<span class="work-proj-time">' + esc(relTime(p.lastTs)) + '</span>' +
        '</div>';
      if (!isCollapsed) {
        html += '<div class="work-proj-body">';
        var limit = state.shown[p.path] || PAGE;
        sessions.slice(0, limit).forEach(function (s) { html += renderItem(s, false); });
        if (sessions.length > limit) {
          html += '<div class="work-more" data-more="' + esc(p.path) + '">ещё ' + (sessions.length - limit) + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    });

    return html || '<div class="work-empty">Ничего не найдено</div>';
  }

  function openSession(id) {
    state.selectedId = id;
    var list = document.getElementById('workList');
    if (list) { list.innerHTML = renderList(); bindList(); }
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
        var live = state.live[id];
        var badge = live
          ? '<span class="work-badge ' + (live.state === 'waiting' ? 'work-need' : 'work-run') + '">' +
              (live.state === 'waiting' ? 'ждёт ответа' : 'работает') + '</span>'
          : '';
        var head = '<div class="work-chat-head">' +
            '<div class="work-chat-title">' + esc(meta ? sessionTitle(meta) : id) + badge + '</div>' +
            '<div class="work-chat-sub">' +
              (meta ? esc(folderName(repoRoot(meta.git_root || meta.project))) + ' · ' + esc(fullTime(tsOf(meta))) + ' · ' : '') +
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
    var per = document.getElementById('workPeriod');
    if (per) {
      per.addEventListener('change', function () {
        state.period = parseInt(per.value, 10) || 0;
        try { localStorage.setItem('codbash-work-period', String(state.period)); } catch (e) { /* ignore */ }
        group();
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

  // ---------- показ/скрытие ----------

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(pollLive, LIVE_POLL_MS);
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function show() {
    var content = document.getElementById('content');
    var host = document.getElementById('workView');
    if (!host) return;
    if (content) content.style.display = 'none';
    host.style.display = 'block';
    document.querySelectorAll('.sidebar-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === VIEW_KEY);
    });
    startPolling();
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
    stopPolling();
  }

  // Стили держим здесь, а не в styles.css: правка апстримных файлов ограничена
  // двумя вставками в index.html и строкой в html.js. Цвета — только токенами
  // темы, чтобы вид жил и в тёмной, и в светлой, и в monokai.
  var CSS = [
    '#workView { display: none; height: 100%; }',
    '.work-wrap { display: grid; grid-template-columns: minmax(300px, 27%) 1fr; height: calc(100vh - 8px); overflow: hidden; }',
    '.work-side { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-width: 0; background: var(--bg-secondary); }',
    '.work-side-head { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }',
    '.work-filter { flex: 1; min-width: 0; padding: 5px 8px; font: inherit; font-size: 12px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border); border-radius: 5px; }',
    '.work-period { padding: 4px 6px; font: inherit; font-size: 11px; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 5px; }',
    '.work-btn { padding: 4px 9px; font-size: 13px; cursor: pointer; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 5px; }',
    '.work-btn:hover { color: var(--text-primary); }',
    '.work-list { flex: 1; overflow-y: auto; padding: 4px 0; }',
    '.work-proj-head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--text-primary); }',
    '.work-proj-head:hover { background: var(--bg-card-hover); }',
    '.work-caret { width: 10px; color: var(--text-muted); }',
    '.work-proj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.work-proj-count { font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; }',
    '.work-proj-time { font-size: 10px; color: var(--text-muted); min-width: 46px; text-align: right; }',
    '.work-state .work-proj-head { text-transform: uppercase; letter-spacing: .04em; font-size: 10.5px; }',
    '.work-state.work-need .work-proj-name { color: var(--accent-orange); }',
    '.work-state.work-run .work-proj-name { color: var(--accent-green); }',
    '.work-item { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 4px 22px; cursor: pointer; font-size: 12px; line-height: 1.4; }',
    '.work-item:hover { background: var(--bg-card-hover); }',
    '.work-item.selected { background: var(--bg-card-hover); box-shadow: inset 2px 0 0 var(--accent-blue); }',
    '.work-label { flex: 0 0 auto; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 10px; }',
    '.work-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }',
    '.work-time { flex: 0 0 auto; font-size: 10px; color: var(--text-muted); }',
    '.work-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; }',
    '.work-dot-wait { background: var(--accent-orange); box-shadow: 0 0 0 2px rgb(251 146 60 / .2); }',
    '.work-dot-run { background: var(--accent-green); box-shadow: 0 0 0 2px rgb(0 255 136 / .18); }',
    '.work-more { padding: 3px 8px 5px 22px; font-size: 11px; color: var(--text-muted); cursor: pointer; }',
    '.work-more:hover { color: var(--text-primary); text-decoration: underline; }',
    '.work-main { overflow-y: auto; min-width: 0; background: var(--bg-primary); }',
    '.work-chat-head { position: sticky; top: 0; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-primary); }',
    '.work-chat-title { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }',
    '.work-badge { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); }',
    '.work-badge.work-need { color: var(--accent-orange); }',
    '.work-badge.work-run { color: var(--accent-green); }',
    '.work-chat-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }',
    '.work-chat { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }',
    '.work-msg { display: grid; grid-template-columns: 46px 1fr; gap: 10px; align-items: start; }',
    '.work-msg-role { font-size: 10px; color: var(--text-muted); padding-top: 2px; }',
    '.work-msg-body { font-size: 12.5px; line-height: 1.5; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; min-width: 0; }',
    '.work-user .work-msg-body { color: var(--accent-blue); }',
    '.work-code { white-space: pre; overflow-x: auto; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 6px 0; font-size: 11.5px; color: var(--text-primary); }',
    '.work-inline { background: var(--bg-card); border-radius: 3px; padding: 0 4px; font-size: 11.5px; }',
    '.work-empty { padding: 24px; color: var(--text-muted); font-size: 12px; }',
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

  window.WorkView = {
    show: show,
    hide: hide,
    reload: function () { return load(true).then(render); },
    _state: state,
  };
})();
