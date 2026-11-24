// mend (MIT): apply unified, SEARCH/REPLACE, V4A or JSON edits following SPEC.md.
// Node 22, standard library only: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function parseFault(line: number): never {
  throw new Exit2(`error: parse ${line + 1}`);
}

function lineBreak(text: string): '\n' | '\r\n' {
  const lf = text.indexOf('\n');
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string) {
  const br = lineBreak(text);
  const final = text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { br, final, lines };
}

function renderFile(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

function replaceLines(lines: string[], at: number, count: number, next: string[]): void {
  const end = at + count;
  const size = lines.length;
  const delta = next.length - count;
  if (delta > 0) lines.length = size + delta;
  if (delta !== 0) lines.copyWithin(end + delta, end, size);
  if (delta < 0) lines.length = size + delta;
  for (let i = 0; i < next.length; i++) lines[at + i] = next[i]!;
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function nodeAt(p: string) {
  try {
    return lstatSync(p, { throwIfNoEntry: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
    return undefined;
  }
}

function removeEmptyDirs(p: string): void {
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(`${p}/${entry.name}`);
  }
  rmdirSync(p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];

  assertSafe(...paths: string[]): void {
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
      let prefix = '';
      for (const part of p.split('/')) {
        prefix = prefix === '' ? part : `${prefix}/${part}`;
        const node = nodeAt(prefix);
        if (node === undefined) break;
        if (!node.isFile() && !node.isDirectory()) throw new Fail('unsafe', p);
      }
    }
  }

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (nodeAt(p)?.isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  require(p: string): string {
    const text = this.get(p);
    if (text === null) throw new Fail('missing', p);
    return text;
  }

  requireAbsent(p: string, movingFrom?: string): void {
    if (this.get(p) !== null) throw new Fail('exists', p);
    // Directories are implicit in the staged file tree, as on disk after writing.
    for (let parent = dirname(p); parent !== '.'; parent = dirname(parent)) {
      if (parent !== movingFrom && (this.now.has(parent) ? this.now.get(parent) !== null : nodeAt(parent)?.isFile())) {
        throw new Fail('exists', p);
      }
    }
    for (const [path, text] of this.now) {
      if (text !== null && path !== movingFrom && path.startsWith(`${p}/`)) throw new Fail('exists', p);
    }
    if (nodeAt(p)?.isDirectory() && this.hasDiskChildren(p, movingFrom)) throw new Fail('exists', p);
  }

  private hasDiskChildren(dir: string, movingFrom?: string): boolean {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? this.hasDiskChildren(path, movingFrom) : path !== movingFrom && this.now.get(path) !== null;
    });
  }

  move(from: string, to: string, text: string): void {
    this.now.set(from, null);
    this.now.set(to, text);
    this.moves.push({ from, to });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

const lineKeys = [
  (s: string) => s,
  (s: string) => s.replace(/[ \t]+$/, ''),
  (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
];

type Match = { at: number; tier: number };

function matchLines(
  file: string[], old: string[], path: string, strict: boolean,
  choice: 'first' | 'unique' | number, start = 0, eof = false,
): Match {
  const last = file.length - old.length;
  if (last < start) throw new Fail('no-match', path);
  if (eof) start = last;
  const target = typeof choice === 'number' ? Math.max(start, Math.min(last, choice)) : 0;
  for (let tier = 0; tier < (strict ? 1 : lineKeys.length); tier++) {
    const key = lineKeys[tier]!;
    const pattern = tier === 0 ? old : old.map(key);
    // A prefix table makes repeated and overlapping matches a single scan at each tier.
    const prefix = new Uint32Array(pattern.length);
    for (let i = 1, length = 0; i < pattern.length; i++) {
      while (length > 0 && pattern[length] !== pattern[i]) length = prefix[length - 1]!;
      if (pattern[length] === pattern[i]) length++;
      prefix[i] = length;
    }
    let at = -1;
    for (let i = start, length = 0; i < file.length; i++) {
      const value = key(file[i]!);
      while (length > 0 && pattern[length] !== value) length = prefix[length - 1]!;
      if (pattern[length] !== value) continue;
      if (++length !== pattern.length) continue;
      const here = i + 1 - length;
      if (choice === 'first') return { at: here, tier };
      if (choice === 'unique' && at >= 0) throw new Fail('ambiguous', path);
      if (at < 0 || Math.abs(target - here) < Math.abs(target - at)) at = here;
      if (typeof choice === 'number' && here >= target) break;
      length = prefix[length - 1]!;
    }
    if (at >= 0) return { at, tier };
  }
  throw new Fail('no-match', path);
}

function reindent(file: string[], old: string[], match: Match) {
  const from = match.tier === 2 ? /^[ \t]*/.exec(old[0]!)![0] : '';
  const to = match.tier === 2 ? /^[ \t]*/.exec(file[match.at]!)![0] : '';
  return (text: string): string =>
    from !== to && !blank(text) && text.startsWith(from) ? to + text.slice(from.length) : text;
}

type BodyLine = { kind: ' ' | '-' | '+'; text: string; noFinal?: boolean };

function applyBody(file: string[], body: BodyLine[], old: string[], match: Match): number {
  const indent = reindent(file, old, match);
  const next: string[] = [];
  let source = match.at;
  for (const row of body) {
    if (row.kind === '+') next.push(indent(row.text));
    else {
      if (row.kind === ' ') next.push(file[source]!);
      source++;
    }
  }
  replaceLines(file, match.at, old.length, next);
  return next.length;
}

type UnifiedSection = {
  from: string | null; to: string | null; hasFileHeaders: boolean;
  create: boolean; delete: boolean; hunks: { start: number; body: BodyLine[] }[];
};

function unifiedPath(header: string): string | null {
  const path = header.slice(4).split('\t', 1)[0]!.trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const begin = (from: string | null, to: string | null, hasFileHeaders: boolean) => {
    section = { from, to, hasFileHeaders, create: false, delete: false, hunks: [] };
    sections.push(section);
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i++]!;
    if (line === 'diff --git' || line.startsWith('diff --git ') || line.startsWith('diff --git\t')) {
      const paths = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (paths === null) parseFault(i - 1);
      begin(paths[1]!, paths[2]!, false);
    } else if (line.startsWith('--- ') && (lines[i] ?? '').startsWith('+++ ')) {
      const from = unifiedPath(line);
      const to = unifiedPath(lines[i++]!);
      if (section !== undefined && !section.hasFileHeaders && section.hunks.length === 0) {
        section.from = from;
        section.to = to;
        section.hasFileHeaders = true;
      } else begin(from, to, true);
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (section === undefined || header === null) parseFault(i - 1);
      const start = i;
      while (i < lines.length) {
        const row = lines[i]!;
        if (row !== '' && !' -+\\'.includes(row[0]!)) break;
        if (row.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        i++;
      }
      let end = i;
      while (end > start && lines[end - 1] === '') end--;
      const body: BodyLine[] = [];
      let previous: BodyLine | undefined;
      for (let j = start; j < end; j++) {
        const row = lines[j]!;
        if (row.startsWith('\\')) {
          if (previous !== undefined) previous.noFinal = true;
          previous = undefined;
        } else {
          previous = { kind: (row[0] ?? ' ') as BodyLine['kind'], text: row.slice(1) };
          body.push(previous);
        }
      }
      section.hunks.push({ start: Number(header[1]), body });
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseFault(i);
      if (line.startsWith('new file mode')) section.create = true;
      else if (line.startsWith('deleted file mode')) section.delete = true;
      else if (!section.hasFileHeaders && line.startsWith('rename from ')) section.from = line.slice(12);
      else if (!section.hasFileHeaders && line.startsWith('rename to ')) section.to = line.slice(10);
    }
  }
  return sections.map(({ from, to, create, delete: remove, hunks }) => (tree) => {
    if (from !== null) tree.assertSafe(from);
    if (to !== null && to !== from) tree.assertSafe(to);
    if (from === null || create) {
      if (to === null) throw new Fail('unsafe', '/dev/null');
      tree.requireAbsent(to);
      const added: string[] = [];
      let final = true;
      for (const { body } of hunks) {
        for (const row of body) {
          if (row.kind !== '+') continue;
          added.push(row.text);
          final = !row.noFinal;
        }
      }
      tree.now.set(to, renderFile(added, '\n', final));
      return;
    }
    const before = tree.require(from);
    if (to === null || remove) {
      tree.now.set(from, null);
      return;
    }
    if (from !== to) tree.requireAbsent(to, from);
    const file = splitFile(before);
    let offset = 0;
    for (const { start, body } of hunks) {
      const old = body.flatMap((row) => row.kind === '+' ? [] : [row.text]);
      const match = old.length === 0
        ? { at: Math.max(0, Math.min(file.lines.length, start + offset)), tier: 0 }
        : matchLines(file.lines, old, from, strict, start - 1 + offset);
      if (match.at + old.length === file.lines.length) {
        file.final = !body.findLast((row) => row.kind !== '-')?.noFinal;
      }
      offset += applyBody(file.lines, body, old, match) - old.length;
    }
    const text = renderFile(file.lines, file.br, file.final);
    if (from === to) tree.now.set(from, text);
    else tree.move(from, to, text);
  });
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previous: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < lines.length;) {
    const line = lines[i++]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      const path = line.trim();
      if (path !== '' && !path.startsWith('```')) candidate = path;
      continue;
    }
    const marker = i - 1;
    const path = candidate ?? previous;
    if (path === undefined) parseFault(marker);
    const oldStart = i;
    while (i < lines.length) {
      const row = lines[i]!.trimEnd();
      if (row === '=======') break;
      if (row === '>>>>>>> REPLACE') parseFault(marker);
      i++;
    }
    if (i >= lines.length) parseFault(marker);
    const old = lines.slice(oldStart, i++);
    const newStart = i;
    while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') i++;
    if (i >= lines.length) parseFault(marker);
    const next = lines.slice(newStart, i++);
    edits.push((tree) => {
      tree.assertSafe(path);
      if (old.length === 0) {
        tree.requireAbsent(path);
        tree.now.set(path, renderFile(next));
      } else {
        const { lines, br, final } = splitFile(tree.require(path));
        const match = matchLines(lines, old, path, strict, 'unique');
        replaceLines(lines, match.at, old.length, match.tier === 2 ? next.map(reindent(lines, old, match)) : next);
        tree.now.set(path, renderFile(lines, br, final));
      }
    });
    previous = path;
    candidate = undefined;
  }
  return edits;
}

type V4aChunk = { anchor: string; body: BodyLine[]; eof: boolean };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseFault(Math.max(0, first));
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseFault(lines.length);
  const section = /^\*\*\* (Add|Delete|Update) File: /;
  const movePrefix = '*** Move to: ';
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const header = section.exec(lines[i]!);
    if (header === null) parseFault(i);
    const path = lines[i++]!.slice(header[0].length).trim();
    let after = i;
    while (after < last && !section.test(lines[after]!)) after++;
    let end = after;
    while (end > i && blank(lines[end - 1]!)) end--;
    if (header[1] === 'Add') {
      const added: string[] = [];
      for (; i < end; i++) {
        const row = lines[i]!;
        if (row !== '' && !row.startsWith('+')) parseFault(i);
        added.push(row.slice(1));
      }
      edits.push((tree) => {
        tree.assertSafe(path);
        tree.requireAbsent(path);
        tree.now.set(path, renderFile(added));
      });
    } else if (header[1] === 'Delete') {
      if (i < end) parseFault(i);
      edits.push((tree) => {
        tree.assertSafe(path);
        tree.require(path);
        tree.now.set(path, null);
      });
    } else {
      const to = i < end && lines[i]!.startsWith(movePrefix) ? lines[i++]!.slice(movePrefix.length).trim() : undefined;
      const chunks: V4aChunk[] = [];
      let current: V4aChunk | undefined;
      for (; i < end; i++) {
        const row = lines[i]!;
        if (row.startsWith('@@')) {
          current = { anchor: row.slice(2).trim(), body: [], eof: false };
          chunks.push(current);
        } else if (row === '*** End of File') {
          if (current === undefined) parseFault(i);
          current.eof = true;
          current = undefined;
        } else {
          const kind = row[0] ?? ' ';
          if (kind !== ' ' && kind !== '-' && kind !== '+') parseFault(i);
          if (current === undefined) {
            if (chunks.length > 0) parseFault(i);
            current = { anchor: '', body: [], eof: false };
            chunks.push(current);
          }
          current.body.push({ kind, text: row.slice(1) });
        }
      }
      if (chunks.length === 0 && to === undefined) parseFault(start);
      edits.push((tree) => {
        if (to === undefined) tree.assertSafe(path);
        else tree.assertSafe(path, to);
        const { lines, br, final } = splitFile(tree.require(path));
        if (to !== undefined) tree.requireAbsent(to, path);
        let cursor = 0;
        for (const { anchor, body, eof } of chunks) {
          if (anchor !== '') cursor = matchLines(lines, [anchor], path, strict, 'first', cursor).at + 1;
          const old = body.flatMap((row) => row.kind === '+' ? [] : [row.text]);
          const match = old.length === 0
            ? { at: eof ? lines.length : cursor, tier: 0 }
            : matchLines(lines, old, path, strict, 'first', cursor, eof);
          cursor = match.at + applyBody(lines, body, old, match);
        }
        const text = renderFile(lines, br, final);
        if (to === undefined) tree.now.set(path, text);
        else tree.move(path, to, text);
      });
    }
    i = after;
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    tree.assertSafe(p);
    return tree.require(p);
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      tree.assertSafe(p);
      tree.requireAbsent(p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const crlf = lineBreak(before) === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      const at = t.indexOf(old);
      if (at < 0) throw new Fail('no-match', p);
      if (t.indexOf(old, at + 1) >= 0) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const { lines, br, final } = splitFile(exists(tree));
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      replaceLines(lines, line, 0, add);
      tree.now.set(p, renderFile(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: edits = jsonEdits(text, lines);
    }
    if (edits.length === 0) parseFault(0);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  // Each edit prepares its result locally and stages it only after all its checks pass.
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes = [...tree.now].filter(([p, text]) => tree.original(p) !== text);
  const byPath = new Map<string, string>();
  for (const [p, text] of changes) {
    byPath.set(p, `${text === null ? 'D' : tree.original(p) === null ? 'A' : 'M'} ${p}`);
  }
  for (const { from, to } of tree.moves) {
    if (byPath.get(from) !== `D ${from}` || byPath.get(to) !== `A ${to}`) continue;
    byPath.delete(from);
    byPath.set(to, `R ${from} -> ${to}`);
  }
  if (!check) {
    for (const [p, text] of changes) {
      if (text === null) rmSync(p, { force: true });
    }
    for (const [p, text] of changes) {
      if (text === null) continue;
      if (nodeAt(p)?.isDirectory()) removeEmptyDirs(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  const rows = [...byPath.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((p) => byPath.get(p)!);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
