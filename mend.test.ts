import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAIN, runCheck } from './runner.ts';

function check(stdin: string, files: Record<string, string>, argv: string[] = []) {
  return runCheck({ id: 'mend', argv, stdin, files });
}

test('unified hunks use the best tier, retain context bytes, and honor the final marker', () => {
  const patch = `--- a/in
+++ b/in
@@ -1,0 +1 @@
+start
@@ -2,2 +3,2 @@
 x
-old
+exact
@@ -90 +90 @@
 x
-old
+fuzzy
@@ -8 +8 @@
-tail
+last
\\ No newline at end of file
`;
  assert.deepEqual(check(patch, { in: 'head\r\n  x \t\r\n  old\r\nx\r\nold\r\ntail\r\n' }), {
    id: 'mend', exit: 0, stdout: 'M in\nok: 1 file\n',
    files: { in: 'head\r\nstart\r\n  x \t\r\n  fuzzy\r\nx\r\nexact\r\nlast' },
  });
});

test('V4A moves run anchor, cursor and EOF matching without adding a final break', () => {
  const patch = `*** Begin Patch
*** Update File: in
*** Move to: dir/out
@@ anchor
-old
+first
@@ anchor
-old
+second
@@
-end
+last
*** End of File
*** End Patch
`;
  const files = { in: 'anchor\nold\n  anchor\n  old \t\nend' };
  const stdout = 'R in -> dir/out\nok: 1 file\n';
  assert.deepEqual(check(patch, files), {
    id: 'mend', exit: 0, stdout,
    files: { 'dir/out': 'anchor\nfirst\n  anchor\n  second\nlast' },
  });
  assert.deepEqual(check(patch, files, ['--check']), { id: 'mend', exit: 0, stdout, files });
});

test('SEARCH blocks see earlier changes but overlapping matches leave the tree untouched', () => {
  const patch = `in
<<<<<<< SEARCH
=======
x
x
x
>>>>>>> REPLACE
\`\`\`
<<<<<<< SEARCH
x
x
=======
Y
>>>>>>> REPLACE
missing
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
`;
  assert.deepEqual(check(patch, {}), {
    id: 'mend', exit: 1, stdout: 'error: ambiguous in\nerror: missing missing\nfailed: 2 of 3 edits\n', files: {},
  });
});

test('unified parsing precedes reads and safety precedes missing', () => {
  const patch = 'diff --git a/in b/../out\n';
  assert.deepEqual(check(patch, {}), {
    id: 'mend', exit: 1, stdout: 'error: unsafe ../out\nfailed: 1 of 1 edits\n', files: {},
  });
  assert.deepEqual(check(`${patch}--- a/in\n`, {}), {
    id: 'mend', exit: 2, stdout: 'error: parse 3\n', files: {},
  });
});

test('SEARCH rejects an early REPLACE marker instead of editing matching text', () => {
  const early = '>>>>>>> REPLACE \t';
  const files = { note: `old\n${early}\n` };
  const patch = ['note', '<<<<<<< SEARCH', 'old', early, '=======', 'updated', '>>>>>>> REPLACE', ''].join('\n');
  assert.deepEqual(check(patch, files), {
    id: 'mend', exit: 2, stdout: 'error: parse 2\n', files,
  });
});

test('unified rename headers preserve leading and trailing path spaces', () => {
  const from = ' old.txt';
  const to = 'new.txt ';
  const patch = `diff --git a/${from} b/${to}\nrename from ${from}\nrename to ${to}\n`;
  assert.deepEqual(check(patch, { [from]: 'unchanged\n' }), {
    id: 'mend', exit: 0, stdout: `R ${from} -> ${to}\nok: 1 file\n`, files: { [to]: 'unchanged\n' },
  });
});

test('a move destination or an edit under a symlink is refused before reading either path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mend-symlinks-'));
  try {
    const cwd = join(root, 'tree');
    const outside = join(root, 'outside');
    mkdirSync(cwd);
    mkdirSync(outside);
    writeFileSync(join(outside, 'file'), 'outside\n');
    symlinkSync(outside, join(cwd, 'dir'), 'dir');
    symlinkSync(join(outside, 'file'), join(cwd, 'leaf'), 'file');
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const result = spawnSync(process.execPath, [MAIN], {
      cwd, env, encoding: 'utf8',
      input: 'diff --git a/missing b/leaf\ndiff --git a/dir/file b/dir/file\n@@ -1 +1 @@\n-outside\n+changed\n',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'error: unsafe leaf\nerror: unsafe dir/file\nfailed: 2 of 2 edits\n');
    assert.equal(readFileSync(join(outside, 'file'), 'utf8'), 'outside\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
