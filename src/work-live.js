// FORK-LOCAL (badigit/codbash). Детект живых агентских сессий на Windows.
//
// Апстримный getActiveSessions() в data.js на win32 выходит сразу:
//     if (process.platform === 'win32') return active;
// потому что построен на ps/lsof. В результате /api/active на Windows всегда
// пуст, и «идёт работа / ждёт ответа» показать нечем.
//
// Claude Code при этом сам ведёт реестр живых сессий:
//     ~/.claude/sessions/<pid>.json
//     { pid, sessionId, cwd, startedAt, version, kind, entrypoint, name }
// Живость проверяем сигналом 0 (на Windows Node проверяет существование
// процесса, не отправляя ничего).
//
// Состояние сессии определяем по хвосту транскрипта:
//   working — последним говорил пользователь (агент работает), либо запись
//             совсем свежая (агент только что писал и продолжает);
//   waiting — последним говорил агент и с тех пор тихо => ждёт тебя.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Сколько секунд после реплики агента считаем, что он ещё пишет, а не ждёт.
const WORKING_WINDOW_MS = 90 * 1000;
// Читаем только хвост транскрипта: файлы бывают в сотни мегабайт.
const TAIL_BYTES = 96 * 1024;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // чужой процесс существует, но не наш
  }
}

// C:\Users\Dee\GitHub\b24_vibecode → C--Users-Dee-GitHub-b24-vibecode
function encodeCwd(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Путь транскрипта дорог только в первый раз: прямое попадание — один stat,
// а фолбэк обходит все папки ~/.claude/projects (их 159). Опрос идёт каждые
// несколько секунд, поэтому результат — включая «не нашли» — кэшируем.
const pathCache = new Map();

function transcriptPath(sessionId, cwd) {
  if (pathCache.has(sessionId)) return pathCache.get(sessionId);
  let found = '';
  const direct = path.join(PROJECTS_DIR, encodeCwd(cwd), sessionId + '.jsonl');
  if (fs.existsSync(direct)) {
    found = direct;
  } else {
    // Фолбэк: сессию могли перепривязать к другой папке (/cd) — ищем по имени.
    try {
      for (const dir of fs.readdirSync(PROJECTS_DIR)) {
        const p = path.join(PROJECTS_DIR, dir, sessionId + '.jsonl');
        if (fs.existsSync(p)) { found = p; break; }
      }
    } catch { /* нет каталога — останется пусто */ }
  }
  pathCache.set(sessionId, found);
  return found;
}

function readTail(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (!len) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Последняя содержательная реплика: роль и время.
function lastTurn(file) {
  const tail = readTail(file);
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const role = rec.type === 'user' || (rec.message && rec.message.role === 'user') ? 'user'
      : rec.type === 'assistant' || (rec.message && rec.message.role === 'assistant') ? 'assistant'
      : '';
    if (!role) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    return { role, ts: Number.isFinite(ts) ? ts : 0 };
  }
  return null;
}

function getLiveSessions() {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
    if (!meta || !meta.pid || !meta.sessionId) continue;
    if (!isAlive(meta.pid)) continue;

    const file = transcriptPath(meta.sessionId, meta.cwd);
    const turn = file ? lastTurn(file) : null;
    let state = 'working';
    if (turn && turn.role === 'assistant') {
      state = (turn.ts && now - turn.ts < WORKING_WINDOW_MS) ? 'working' : 'waiting';
    }
    out.push({
      id: meta.sessionId,
      pid: meta.pid,
      cwd: meta.cwd || '',
      name: meta.name || '',
      entrypoint: meta.entrypoint || '',
      startedAt: meta.startedAt || 0,
      lastTs: turn ? turn.ts : 0,
      lastRole: turn ? turn.role : '',
      state,
    });
  }
  out.sort((a, b) => (b.lastTs || b.startedAt) - (a.lastTs || a.startedAt));
  return out;
}

module.exports = { getLiveSessions, isAlive, encodeCwd };
