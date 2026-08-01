// normalizePath must understand POSIX-style drive paths on Windows:
// Git Bash gives /c/Users/foo, WSL gives /mnt/c/Users/foo. Both used to become
// C:\c\Users\foo / C:\mnt\c\Users\foo and fail validation with a confusing
// "path does not exist".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const projects = require('../src/projects');

const onWindows = process.platform === 'win32';

test('Git Bash path maps to a drive on Windows, untouched elsewhere', () => {
  const out = projects.normalizePath('/c/Users/foo/my-repo');
  if (onWindows) {
    assert.equal(out, 'C:\\Users\\foo\\my-repo');
  } else {
    // POSIX: /c/... is an ordinary absolute path and must survive as-is.
    assert.equal(out, path.resolve('/c/Users/foo/my-repo'));
  }
});

test('WSL /mnt/<drive>/ path maps to a drive on Windows', () => {
  const out = projects.normalizePath('/mnt/d/work/repo');
  if (onWindows) {
    assert.equal(out, 'D:\\work\\repo');
  } else {
    assert.equal(out, path.resolve('/mnt/d/work/repo'));
  }
});

test('hyphens in folder names survive normalization', () => {
  // Regression guard: the failure mode looked like "the dash breaks it", so pin
  // the actual behaviour — dashes are ordinary characters in both formats.
  const posix = projects.normalizePath('/c/Users/foo/ai-tools');
  const native = projects.normalizePath('C:/Users/foo/ai-tools');
  if (onWindows) {
    assert.equal(posix, 'C:\\Users\\foo\\ai-tools');
    assert.equal(native, 'C:\\Users\\foo\\ai-tools');
    assert.equal(posix, native);
  } else {
    assert.ok(posix.endsWith('ai-tools'));
  }
});

test('bare drive root is accepted', () => {
  const out = projects.normalizePath('/c/');
  if (onWindows) assert.equal(out, 'C:\\');
  else assert.equal(out, path.resolve('/c/'));
});

test('native Windows paths still pass through unchanged', () => {
  const out = projects.normalizePath(onWindows ? 'C:\\Users\\foo\\repo' : '/tmp/repo');
  assert.equal(out, onWindows ? 'C:\\Users\\foo\\repo' : path.resolve('/tmp/repo'));
});

test('a single-letter first segment without a drive is not mangled', () => {
  // /c alone (no trailing slash or child) is ambiguous; treating it as C:\ is
  // the pragmatic reading on Windows, and it must stay a plain path elsewhere.
  const out = projects.normalizePath('/c');
  if (onWindows) assert.equal(out, 'C:\\');
  else assert.equal(out, path.resolve('/c'));
});
