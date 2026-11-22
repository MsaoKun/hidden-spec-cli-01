// mend, the CLI specified by SPEC.md (version 1). Node 22, standard library only.
// Original implementation written in this session; the command-line/JSON/atomicity
// scaffolding follows the kit's starter, the four readers and fuzzy matcher are new.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
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

// ---------------------------------------------------------------------------
// Files, lines and fuzzy matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileInfo {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function fileInfo(text: string): FileInfo {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function render(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

interface Tier {
  n: number;
  norm: (s: string) => string;
}
function tiers(): Tier[] {
  return [
    { n: 0, norm: (s) => s },
    { n: 1, norm: (s) => s.replace(/[ \t]+$/, '') },
    { n: 2, norm: (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') },
  ];
}

interface Occurrences {
  tier: number;
  positions: number[];
}
function findOccurrences(O: string[], F: string[], strict: boolean, start = 0, endOnly = false): Occurrences | null {
  const list = strict ? tiers().slice(0, 1) : tiers();
  for (const t of list) {
    const oo = O.map(t.norm);
    const positions: number[] = [];
    for (let i = start; i <= F.length - O.length; i += 1) {
      if (endOnly && i + O.length !== F.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (oo[j] !== t.norm(F[i + j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t.n, positions };
  }
  return null;
}

function reindent(line: string, F: string, P: string): string {
  if (line === '' || line.trim() === '') return line;
  if (P !== '' && !line.startsWith(P)) return line;
  return F + line.slice(P.length);
}

// A line of an O/N pair. `ctx` marks a context line (written from the file),
// `oi` is its index in O. A non-context line of N has oi = -1.
interface ML {
  text: string;
  ctx: boolean;
  oi: number;
  noEol: boolean;
}

function pairBody(body: { kind: string; text: string; noEol: boolean }[]): { O: ML[]; N: ML[] } {
  const O: ML[] = [];
  const N: ML[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === '\\') continue;
    if (e.kind === ' ' || e.kind === '-') O.push({ text: e.text, ctx: e.kind === ' ', oi, noEol: e.noEol });
    if (e.kind === ' ' || e.kind === '+') N.push({ text: e.text, ctx: e.kind === ' ', oi, noEol: e.noEol });
    if (e.kind === ' ' || e.kind === '-') oi += 1;
  }
  return { O, N };
}

function expandN(N: ML[], pos: number, fileLines: string[], tier: number, F: string, P: string): string[] {
  return N.map((e) => (e.ctx ? fileLines[pos + e.oi]! : tier === 2 ? reindent(e.text, F, P) : e.text));
}

let strictMode = false;

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UEntry {
  kind: string;
  text: string;
  raw: string;
  noEol: boolean;
}
interface Hunk {
  A: number;
  body: UEntry[];
}
interface USection {
  old: string | null;
  new: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitX: string | null;
  gitY: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function headerPath(line: string, n: number): string | null {
  let s = line.slice(n);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function gitPaths(line: string): { x: string; y: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep).trim();
  const y = rest.slice(sep + 3).trim();
  if (x === '' || y === '') return null;
  return { x, y };
}

function hunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : parseInt(m[1]!, 10);
}

function parseHunkBody(L: string[], start: number): { body: UEntry[]; end: number } {
  const body: UEntry[] = [];
  let i = start;
  while (i < L.length) {
    const line = L[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (L[i + 1] ?? '').startsWith('+++ ')) break;
    const kind = line === '' ? ' ' : line[0]!;
    if (kind === ' ' || kind === '-' || kind === '+' || kind === '\\') {
      body.push({ kind, text: line === '' ? '' : line.slice(1), raw: line, noEol: false });
      i += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  for (let j = 0; j < body.length; j += 1) {
    if (body[j]!.kind === '\\') {
      for (let k = j - 1; k >= 0; k -= 1) {
        if (body[k]!.kind !== '\\') {
          body[k]!.noEol = true;
          break;
        }
      }
    }
  }
  return { body, end: i };
}

function parseUHeader(L: string[], start: number, sec: USection): number {
  let i = start;
  while (i < L.length) {
    const line = L[i]!;
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((L[i + 1] ?? '').startsWith('+++ ')) {
        sec.old = headerPath(line, 4);
        sec.new = headerPath(L[i + 1]!, 4);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('rename from ')) {
      sec.renameFrom = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      sec.renameTo = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseUHunks(L: string[], start: number, sec: USection): number {
  let i = start;
  while (i < L.length && L[i]!.startsWith('@@')) {
    const A = hunkHeader(L[i]!);
    if (A === null) throw new Exit2(`error: parse ${i + 1}`);
    const { body, end } = parseHunkBody(L, i + 1);
    sec.hunks.push({ A, body });
    i = end;
  }
  return i;
}

function unifiedEdits(L: string[]): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < L.length) {
    const line = L[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    let sec: USection;
    if (line.startsWith('diff --git ')) {
      const gp = gitPaths(line);
      if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { old: null, new: null, renameFrom: null, renameTo: null, gitX: gp.x, gitY: gp.y, create: false, del: false, hunks: [] };
      i = parseUHeader(L, i + 1, sec);
    } else if (line.startsWith('--- ') && (L[i + 1] ?? '').startsWith('+++ ')) {
      sec = { old: headerPath(line, 4), new: headerPath(L[i + 1]!, 4), renameFrom: null, renameTo: null, gitX: null, gitY: null, create: false, del: false, hunks: [] };
      i = parseUHeader(L, i + 2, sec);
    } else {
      i += 1;
      continue;
    }
    i = parseUHunks(L, i, sec);
    sections.push(sec);
  }
  return sections.map(unifiedEdit);
}

function applyUHunks(lines0: string[], hunks: Hunk[], final0: boolean, path: string): { lines: string[]; final: boolean } {
  let lines = lines0.slice();
  let final = final0;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = pairBody(h.body);
    let pos: number;
    let tier = 0;
    if (O.length === 0) {
      pos = Math.min(h.A + d, lines.length);
    } else {
      const found = findOccurrences(O.map((e) => e.text), lines, strictMode);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.A - 1 + d;
      pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target) || (Math.abs(p - target) === Math.abs(pos - target) && p < pos)) pos = p;
      }
    }
    const F = O.length > 0 ? leadWs(lines[pos]!) : '';
    const P = O.length > 0 ? leadWs(O[0]!.text) : '';
    const repl = expandN(N, pos, lines, tier, F, P);
    const touchedEnd = O.length > 0 ? pos + O.length === lines.length : pos === lines.length;
    if (touchedEnd) {
      const last = N[N.length - 1];
      final = last === undefined ? true : !last.noEol;
    }
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
    d += N.length - O.length;
  }
  return { lines, final };
}

function unifiedEdit(sec: USection): Edit {
  const op = sec.old ?? sec.renameFrom ?? sec.gitX;
  const np = sec.new ?? sec.renameTo ?? sec.gitY;
  const isCreate = sec.create || op === null;
  const isDelete = sec.del || np === null;
  return (tree) => {
    if (op !== null && !safe(op)) throw new Fail('unsafe', op);
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    if (isCreate) {
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        const plus = h.body.filter((e) => e.kind === '+');
        for (const e of plus) out.push(e.text);
        const last = plus[plus.length - 1];
        if (last !== undefined) final = !last.noEol;
      }
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (op === null) throw new Fail('unsafe', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const oldP = op!;
    const newP = np === null ? oldP : np;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const fi = fileInfo(before);
    const res = applyUHunks(fi.lines, sec.hunks, fi.final, oldP);
    const text = render(res.lines, fi.br, res.final);
    if (oldP !== newP) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
    } else tree.now.set(oldP, text);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(p: string, oldL: string[], newL: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldL.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const fi = fileInfo(before);
    const found = findOccurrences(oldL, fi.lines, strictMode);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const F = leadWs(fi.lines[pos]!);
    const P = leadWs(oldL[0]!);
    const repl = newL.map((l) => (found.tier === 2 ? reindent(l, F, P) : l));
    const lines = [...fi.lines.slice(0, pos), ...repl, ...fi.lines.slice(pos + oldL.length)];
    tree.now.set(p, render(lines, fi.br, fi.final));
  };
}

function searchReplaceEdits(L: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  while (i < L.length) {
    if (L[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const line = L[j]!;
      if (blank(line) || line.trim().startsWith('```')) continue;
      path = line.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < L.length; j += 1) {
      if (eq < 0 && L[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && L[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, L.slice(i + 1, eq), L.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VBody {
  kind: string;
  text: string;
  raw: string;
}
interface VChunk {
  anchor: string | null;
  body: VBody[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  chunks: VChunk[];
  moveTo: string | null;
}

function isSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aEdits(L: string[]): Edit[] {
  const first = L.findIndex((l) => !blank(l));
  if (first < 0 || L[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = L.length - 1;
  while (last >= 0 && blank(L[last]!)) last -= 1;
  if (last < 0 || L[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${L.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = L[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const lineNo = i + 1;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raws: { raw: string; line: number }[] = [];
      i += 1;
      while (i < last && !isSectionStart(L[i]!)) {
        const b = L[i]!;
        if (b.startsWith('+') || blank(b)) {
          raws.push({ raw: b, line: i + 1 });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raws.length > 0 && blank(raws[raws.length - 1]!.raw)) raws.pop();
      for (const r of raws) if (r.raw !== '' && !r.raw.startsWith('+')) throw new Exit2(`error: parse ${r.line}`);
      sections.push({ kind: 'add', path, lines: raws.map((r) => (r.raw === '' ? '' : r.raw.slice(1))), chunks: [], moveTo: null });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSectionStart(L[i]!)) {
        if (!blank(L[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', path, lines: [], chunks: [], moveTo: null });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && L[i]!.startsWith('*** Move to: ')) {
        moveTo = L[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < last && !isSectionStart(L[i]!)) {
        const b = L[i]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: b.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: true };
          else cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (blank(b)) {
          if (cur !== null) cur.body.push({ kind: ' ', text: '', raw: b });
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push({ kind: b[0]!, text: b.slice(1), raw: b });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length > 0) {
        const c = chunks[chunks.length - 1]!;
        while (c.body.length > 0 && c.body[c.body.length - 1]!.raw.trim() === '') c.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind: 'update', path, lines: [], chunks, moveTo });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map(vEdit);
}

function vEdit(sec: VSection): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const lines = sec.lines;
      tree.now.set(sec.path, lines.length === 0 ? '' : lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fi = fileInfo(before);
    let lines = fi.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of strictMode ? tiers().slice(0, 1) : tiers()) {
          const a = t.norm(ch.anchor);
          for (let j = cursor; j < lines.length; j += 1) {
            if (t.norm(lines[j]!) === a) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const { O, N } = pairBody(ch.body);
      let pos: number;
      let tier = 0;
      if (O.length === 0) {
        pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      } else {
        const occ = findOccurrences(O.map((e) => e.text), lines, strictMode, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', sec.path);
        pos = occ.positions[0]!;
        tier = occ.tier;
      }
      const F = O.length > 0 ? leadWs(lines[pos]!) : '';
      const P = O.length > 0 ? leadWs(O[0]!.text) : '';
      const repl = expandN(N, pos, lines, tier, F, P);
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
      cursor = pos + N.length;
    }
    const text = render(lines, fi.br, fi.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else tree.now.set(sec.path, text);
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, render(lines, br, final));
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

// ---------------------------------------------------------------------------
// Invocation, output and atomicity (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  strictMode = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strictMode) strictMode = true;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const collapsed = new Set<string>();
  const renames: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null) {
      collapsed.add(`D ${m.old}`);
      collapsed.add(`A ${m.new}`);
      renames.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const line = `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`;
    if (!collapsed.has(line)) rows.push({ key: p, line });
  }
  for (const r of renames) rows.push(r);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.original(p) === tree.now.get(p)) continue;
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
