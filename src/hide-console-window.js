// КОПИЯ канона _my_llm-skills-agents/scripts/hide-console-window.mjs, переложенная
// в CommonJS (codbash — CJS). Правки вносить там, сюда переносить копией
// (задача _my_llm-skills-agents-ppm).
//
// Гасим консольные окна, которые Windows рисует потомкам фонового
// процесса. Пара к scripts/_win.py (там то же самое для Python).
//
// Зачем. Консольный потомок процесса, у которого консоли НЕТ (PM2-стак, хук из
// GUI-родителя, задача планировщика), получает от Windows СВОЁ окно. С Windows
// Terminal в роли терминала по умолчанию это полноценное окно WT поверх работы
// человека. `windowsHide: true` у самого стака потомкам НЕ наследуется — флаг
// обязан ставить тот, кто спавнит.
//
// Почему патч, а не аккуратные опции на каждом вызове. Спавним не только мы:
// @openai/codex-sdk зовёт `spawn(bin, args, { env, signal })` без windowsHide и
// рычага наружу не даёт; у Claude Agent SDK та же история со своим CLI. Аудит
// 10.08.2026 показал, чем кончается подход «прикрыть известные бинари списком»:
// шесть независимых реализаций, в каждой закрыт свой участок, а соседний открыт.
// Поэтому здесь ИНВЕРСИЯ: фоновому процессу окно не нужно никогда, гасим всё, а
// исключения заводятся явным списком keep.
//
// Почему ChildProcess.prototype.spawn, а не child_process.spawn: ESM-модуль,
// сделавший `import { spawn } from 'child_process'`, держит снимок, и подмена
// cp.spawn постфактум до него НЕ долетает (проверено на node v24). А cp.spawn()
// внутри создаёт `new ChildProcess()` и зовёт метод по прототипу — туда прилетают
// уже нормализованные опции, и правка видна всем, кто бы как ни импортировал.
//
// Как подключать: `require('../src/hide-console-window')` ПЕРВОЙ строкой точки
// входа фонового процесса, до require модулей, которые спавнят. Копия, а не
// импорт из мастерской: пакет ставится через npm на чужие машины.
//
// Чего НЕ лечит (не считай молчание успехом):
//   - stdio с inherit: libuv ставит CREATE_NO_WINDOW, только если НИ ОДИН stdio
//     не унаследован (src/win/process.c). Так вылезало окно esbuild.exe;
//   - ConPTY (node-pty, winpty): идёт мимо ChildProcess вовсе. Так запускается agy.
//
// Потребители: dimcoder (server/lib/hideConsoleWindow.ts), см. задачу
// _my_llm-skills-agents-ppm. Правило — agent-rules/common/10-windows-shell.md.

const childProcess = require('node:child_process')

/** Basename пути: работает и с `/`, и с `\` (path.basename на posix не режет `\`). */
function baseName(file) {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut === -1 ? file : file.slice(cut + 1)
}

let uninstall = null

/**
 * Ставит патч (идемпотентно, только на win32).
 * @param {{keep?: string[]}} [options] keep — basename бинарей, которым окно
 *   оставляем намеренно (без учёта регистра). Обычно пусто.
 * @returns {(() => void) | null} функция снятия, либо null если патч не нужен/уже стоит.
 */
function installHiddenConsoleWindowPatch(options = {}) {
  if (process.platform !== 'win32') return null
  if (uninstall) return null

  const keep = new Set((options.keep ?? []).map((n) => n.toLowerCase()))
  const proto = childProcess.ChildProcess.prototype
  const original = proto.spawn
  if (typeof original !== 'function') {
    // Internal API Node поменялся — молча живём с окном, но не ломаем спавн.
    console.warn('[hide-console-window] ChildProcess.prototype.spawn не найден, патч пропущен')
    return null
  }

  proto.spawn = function patchedSpawn(opts) {
    const file = opts && typeof opts.file === 'string' ? opts.file : ''
    if (opts && !(file && keep.has(baseName(file).toLowerCase()))) opts.windowsHide = true
    return original.call(this, opts)
  }
  uninstall = () => {
    proto.spawn = original
    uninstall = null
  }
  return uninstall
}

installHiddenConsoleWindowPatch()

module.exports = { installHiddenConsoleWindowPatch }
