// Tests for env-doctor. Every test builds its own small project under the system's temporary
// folder at run time and runs the tool as a child process. No .env file and no secret-shaped
// string is kept in the repository: they are written, or built from pieces, here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../env-doctor.mjs', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'env-doctor-test-'));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(dir, args = [], options = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, encoding: 'utf8', ...options });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function report(dir, args = []) {
  const r = run(dir, ['--json', ...args]);
  assert.ok(r.status === 0 || r.status === 1, `unexpected status ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// line and column (code points) of the first occurrence of marker in source
function at(source, marker) {
  const idx = source.indexOf(marker);
  assert.ok(idx >= 0, `marker not found: ${marker}`);
  const before = source.slice(0, idx);
  const line = before.split('\n').length;
  const col = Array.from(before.slice(before.lastIndexOf('\n') + 1)).length + 1;
  return { line, column: col };
}

const names = (list) => list.map((x) => x.name);

// ------------------------------------------------------------------ the package

test('package.json and the first line of the tool', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'));
  assert.equal(pkg.name, 'env-doctor');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { 'env-doctor': 'env-doctor.mjs' });
  assert.deepEqual(pkg.files, ['env-doctor.mjs', 'README.md', 'LICENSE']);
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.repository.url, 'git+https://github.com/tick-ai/env-doctor.git');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 2);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const first = readFileSync(TOOL, 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node');
});

// ------------------------------------------------------------------ the dotenv format

test('dotenv: assignments, comments, export, quotes, multi-line and empty values', () => {
  const template = [
    'A=1', // 1
    '# B=2', // 2
    '  export C = "x y"   # c', // 3
    "D='a", // 4
    "b'", // 5
    'E="l1', // 6
    'l2"', // 7
    'F=', // 8
    'G=""', // 9
    'H=   # c', // 10
    'I=" "', // 11
    'J=v #c', // 12
    'K=v#c', // 13
    'export L=1', // 14
    'M="a\\\\"', // 15  "a\\"
    'N="a\\"b" # q', // 16
    'O=1',
  ].join('\n');
  const dir = project({ '.env.example': template, '.env': 'ZZZ=1\n' });
  const r = report(dir);
  assert.deepEqual(r.malformed, []);
  assert.deepEqual(
    r.missing.map((x) => [x.name, x.line]),
    [['A', 1], ['C', 3], ['D', 4], ['E', 6], ['F', 8], ['G', 9], ['H', 10], ['I', 11], ['J', 12], ['K', 13], ['L', 14], ['M', 15], ['N', 16], ['O', 17]],
  );
  assert.deepEqual(names(r.unexpected), ['ZZZ']);

  // the same file as the checked file: only the empty values are missing
  const same = project({ '.env.example': template, '.env': template });
  const s = report(same);
  assert.deepEqual(
    s.missing.map((x) => [x.name, x.line, x.reason]),
    [['F', 8, 'empty'], ['G', 9, 'empty'], ['H', 10, 'empty']],
  );
});

test('dotenv: the last assignment gives the value, the first gives the line', () => {
  const dir = project({
    '.env.example': 'A=1\nB=2\nA=3\n',
    '.env': 'A=1\nA=\nB=2\nB=\nB=5\n',
  });
  const r = report(dir);
  assert.deepEqual(r.missing, [{ name: 'A', line: 1, reason: 'empty' }]);
  assert.deepEqual(r.duplicates, [
    { name: 'A', file: '.env', lines: [1, 2] },
    { name: 'B', file: '.env', lines: [3, 4, 5] },
    { name: 'A', file: '.env.example', lines: [1, 3] },
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.lines[0] - b.lines[0])));
});

test('dotenv: malformed statements and where reading goes on', () => {
  const dir = project({
    '.env.example': [
      'my-key=1', // 1 invalid-key
      '=1', // 2 invalid-key
      'A', // 3 missing-equals
      'A b', // 4 missing-equals
      '1A=2', // 5 invalid-key
      'B = 2', // 6 ok
      'C="x" y', // 7 trailing-text
      'D="m', // 8 trailing-text: closes on line 9, reading goes on after it
      'n" z', // 9
      'E=3', // 10
      'F="oops', // 11 unterminated-quote
      'G=4', // 12 read again: the next line
    ].join('\n'),
  });
  const r = report(dir);
  assert.deepEqual(r.malformed, [
    { file: '.env.example', line: 1, reason: 'invalid-key' },
    { file: '.env.example', line: 2, reason: 'invalid-key' },
    { file: '.env.example', line: 3, reason: 'missing-equals' },
    { file: '.env.example', line: 4, reason: 'missing-equals' },
    { file: '.env.example', line: 5, reason: 'invalid-key' },
    { file: '.env.example', line: 7, reason: 'trailing-text' },
    { file: '.env.example', line: 8, reason: 'trailing-text' },
    { file: '.env.example', line: 11, reason: 'unterminated-quote' },
  ]);
  assert.equal(r.env, null);
  assert.equal(r.counts.malformed, 8);
  // a template whose only assignments are B, E and G: use them as "stale"-free names via a code file
  const dir2 = project({
    '.env.example': readFileSync(join(dir, '.env.example'), 'utf8'),
    'a.js': 'process.env.B; process.env.E; process.env.G; process.env.C; process.env.D; process.env.F;',
  });
  const r2 = report(dir2);
  assert.deepEqual(names(r2.undocumented), ['C', 'D', 'F']);
});

test('dotenv: an unterminated single quote, and a quote left open to the end of the file', () => {
  const dir = project({ '.env.example': "A=1\nB='open\nC=2\n" });
  const r = report(dir);
  assert.deepEqual(r.malformed, [{ file: '.env.example', line: 2, reason: 'unterminated-quote' }]);
});

test('dotenv: CRLF line ends and a byte-order mark', () => {
  const dir = project({
    '.env.example': '﻿A=1\r\nB="x\r\ny"\r\nC=\r\n# D=1\r\nE=v  \r\n',
    '.env': '﻿A=1\r\nB=2\r\nC=\r\nE=3\r\n',
  });
  const r = report(dir);
  assert.deepEqual(r.malformed, []);
  assert.deepEqual(r.missing, [{ name: 'C', line: 4, reason: 'empty' }]);
  assert.deepEqual(r.unexpected, []);
});

test('dotenv: expansions are noted, never expanded', () => {
  const dir = project({
    '.env.example': [
      'HOST=h', // 1
      'PORT=1', // 2
      'URL=${HOST}:${PORT} ${HOST}', // 3
      "S='${X}'", // 4
      'D="${Y} $Z ${9}"', // 5
      'REF2=${GONE}', // 6
      'LONE=1', // 7
    ].join('\n'),
    'a.js': 'process.env.URL; process.env.S; process.env.D; process.env.REF2;',
    '.env': 'URL=${HOST}\n',
  });
  const r = report(dir);
  assert.deepEqual(r.expansions, [
    { name: 'URL', file: '.env', line: 1, refs: ['HOST'] },
    { name: 'URL', file: '.env.example', line: 3, refs: ['HOST', 'PORT'] },
    { name: 'D', file: '.env.example', line: 5, refs: ['Y'] },
    { name: 'REF2', file: '.env.example', line: 6, refs: ['GONE'] },
  ]);
  // HOST and PORT are refs of the template, so they are not stale; LONE is
  assert.deepEqual(r.stale, [{ name: 'LONE', line: 7 }]);
  assert.equal(r.counts.expansions, 4);
  const plain = run(dir).stdout;
  assert.match(plain, /expansions \(4\)\n {4}URL {2}\.env:1 {2}refs: HOST\n {4}URL {2}\.env\.example:3 {2}refs: HOST, PORT\n/);
});

// ------------------------------------------------------------------ which files are read

test('the template: --example, then .env.example, .env.sample, .env.template; none is a usage error', () => {
  let dir = project({ '.env.template': 'T=1\n', '.env.sample': 'S=1\n', '.env.example': 'E=1\n' });
  assert.equal(report(dir).example, '.env.example');
  dir = project({ '.env.template': 'T=1\n', '.env.sample': 'S=1\n' });
  assert.equal(report(dir).example, '.env.sample');
  dir = project({ '.env.template': 'T=1\n' });
  assert.equal(report(dir).example, '.env.template');
  dir = project({ '.env.template': 'T=1\n', 'conf/my.env': 'C=1\n' });
  const r = report(dir, ['--example', 'conf/my.env']);
  assert.equal(r.example, 'conf/my.env');
  assert.equal(r.missing.length, 0);
  dir = project({ '.env': 'A=1\n' });
  const e = run(dir);
  assert.equal(e.status, 2);
  assert.equal(e.stdout, '');
  assert.ok(e.stderr.length > 0);
  // a folder with that name is not a template
  dir = project({ '.env.example/x': '', '.env.sample': 'S=1\n' });
  assert.equal(report(dir).example, '.env.sample');
});

test('the checked file: .env, .env.local, then modes in order; none is not an error', () => {
  let dir = project({ '.env.example': 'A=1\n', '.env.local': 'A=1\n', '.env': 'A=1\n', '.env.production': 'A=1\n' });
  assert.equal(report(dir).env, '.env');
  dir = project({ '.env.example': 'A=1\n', '.env.local': 'A=1\n', '.env.production': 'A=1\n' });
  assert.equal(report(dir).env, '.env.local');
  dir = project({ '.env.example': 'A=1\n', '.env.test': 'A=1\n', '.env.production': 'A=1\n', '.env.Dev_2-x': 'A=1\n' });
  assert.equal(report(dir).env, '.env.Dev_2-x');
  dir = project({ '.env.example': 'A=1\n', '.env.sample': 'A=1\n', '.env.template': 'A=1\n', '.env.bad.name': 'A=1\n', '.env.': 'A=1\n' });
  let r = report(dir);
  assert.equal(r.env, null);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unexpected, []);
  assert.equal(run(dir).status, 0);
  // the template in use is left out of the modes
  dir = project({ '.env.alpha': 'A=1\n', '.env.beta': 'B=1\n' });
  r = report(dir, ['--example', '.env.alpha']);
  assert.equal(r.example, '.env.alpha');
  assert.equal(r.env, '.env.beta');
  // a folder named .env is not a file; subfolders are never looked at
  dir = project({ '.env.example': 'A=1\n', '.env/x': '', 'sub/.env': 'A=1\n' });
  assert.equal(report(dir).env, null);
});

test('--env and --example: relative to dir, absolute as they are, files outside dir as given', () => {
  const dir = project({ '.env.example': 'A=1\n', 'conf/prod.env': 'A=1\nB=2\n', '-dash.env': 'A=\n' });
  let r = report(dir, ['--env', 'conf/prod.env']);
  assert.equal(r.env, 'conf/prod.env');
  assert.deepEqual(names(r.unexpected), ['B']);
  r = report(dir, ['--env=conf/prod.env']);
  assert.equal(r.env, 'conf/prod.env');
  r = report(dir, ['--env', '-dash.env']);
  assert.equal(r.env, '-dash.env');
  assert.deepEqual(r.missing, [{ name: 'A', line: 1, reason: 'empty' }]);
  r = report(dir, ['--env', join(dir, 'conf', 'prod.env')]);
  assert.equal(r.env, 'conf/prod.env');
  // last one wins
  r = report(dir, ['--env', 'nothing-here', '--env', 'conf/prod.env']);
  assert.equal(r.env, 'conf/prod.env');

  const other = project({ 'elsewhere.env': 'A=1\n' });
  const abs = join(other, 'elsewhere.env');
  r = report(dir, ['--env', abs]);
  assert.equal(r.env, abs);
  // dir given as an argument, relative to the current directory
  const parent = dirname(dir);
  const base = dir.slice(parent.length + 1);
  const viaRelative = run(parent, [base, '--json']);
  assert.equal(JSON.parse(viaRelative.stdout).example, '.env.example');
  const viaAbsolute = run(other, [dir, '--json']);
  assert.equal(JSON.parse(viaAbsolute.stdout).example, '.env.example');
  assert.equal(JSON.parse(viaAbsolute.stdout).env, null);
});

// ------------------------------------------------------------------ finding the uses

function usesOf(files, extra = []) {
  const dir = project({ '.env.example': '', ...files });
  const r = report(dir, extra);
  return r;
}

test('uses in JavaScript and TypeScript', () => {
  const src = [
    'const a = process.env.JS_DOT;', // 1
    "const b = process.env['JS_SUB'] + globalThis.process.env.JS_GLOBAL;", // 2
    "const c = import.meta.env.JS_META + Bun.env.JS_BUN + Deno.env.get('JS_DENO');", // 3
    "const { JS_D1, JS_D2: renamed, JS_D3 = 'x', 'JS_D4': q, ...rest } = process.env;", // 4
    'const e = `t ${process.env.JS_TPL} u`;', // 5
    '// process.env.JS_COMMENT', // 6
    '/* process.env.JS_BLOCK', // 7
    '   process.env.JS_BLOCK2 */', // 8
    'const s = "process.env.JS_STR" + \'process.env.JS_STR2\' + `process.env.JS_STR3`;', // 9
    "process.env.JS_WRITE = 'x';", // 10
    "const f = process.env['a-b'] + process.env.$x;", // 11
    'Object.keys(process.env); const h = { ...process.env };', // 12
    'const k = process.env[key];', // 13
    'const l = process.env[`a${b}`];', // 14
    "const m = process.env['a' + b];", // 15
    'const n = process.env[];', // 16
    'const { JS_NOPE } = import.meta.env;', // 17
    'const { JS_NESTED: { INNER }, JS_AFTER } = process.env;', // 18
    "const { JS_NOT } = process.env.X_OBJ ? 1 : 2;", // 19
    "const u = 'unterminated process.env.JS_UNT", // 20
    'const v = process.env.JS_LAST;', // 21
  ].join('\n');
  for (const file of ['src/a.js', 'src/a.ts', 'a.tsx', 'a.mjs', 'a.cjs', 'a.jsx', 'a.mts', 'a.cts']) {
    const r = usesOf({ [file]: src });
    const expected = [
      'JS_DOT', 'JS_SUB', 'JS_GLOBAL', 'JS_META', 'JS_BUN', 'JS_DENO', 'JS_D1', 'JS_D2', 'JS_D3', 'JS_D4',
      'JS_TPL', 'JS_WRITE', 'JS_NESTED', 'JS_AFTER', 'X_OBJ', 'JS_LAST',
    ].sort();
    assert.deepEqual(names(r.undocumented), expected, file);
    assert.equal(r.sources.files, 1);
    assert.equal(r.sources.uses, expected.length);
    const byName = Object.fromEntries(r.undocumented.map((x) => [x.name, x]));
    for (const n of ['JS_DOT', 'JS_SUB', 'JS_GLOBAL', 'JS_META', 'JS_BUN', 'JS_DENO', 'JS_D1', 'JS_D2', 'JS_D3', 'JS_D4', 'JS_TPL', 'JS_WRITE', 'JS_LAST']) {
      const marker = n === 'JS_D4' ? "'JS_D4'" : n === 'JS_SUB' ? "'JS_SUB'" : n === 'JS_DENO' ? "'JS_DENO'" : n;
      const pos = at(src, marker);
      assert.deepEqual([byName[n].line, byName[n].column], [pos.line, pos.column], `${file} ${n}`);
      assert.equal(byName[n].file, file);
    }
    assert.deepEqual(
      r.dynamic.map((d) => [d.file, d.line, d.column]),
      [
        [file, 13, at(src, 'key]').column],
        [file, 14, at(src, '`a${b}`').column],
        [file, 15, at(src, "'a' + b").column],
      ],
    );
  }
  const r = usesOf({ 'a.js': src });
  assert.equal(r.counts.dynamic, 3);
});

test('uses in Python', () => {
  const src = [
    'import os', // 1
    "a = os.environ['PY_SUB']", // 2
    "b = os.environ.get('PY_GET', 'd')", // 3
    'c = os.getenv("PY_GETENV")', // 4
    "os.environ['PY_WRITE'] = 'x'", // 5
    'd = os.environ.get(name)', // 6
    "e = '''", // 7
    "os.environ['PY_TRIPLE']", // 8
    "'''", // 9
    "# os.environ['PY_COMMENT']", // 10
    "f = \"os.environ['PY_STR']\"", // 11
    "g = os.environ['PY_X' + y]", // 12
    'h = os.getenv()', // 13
    "i = os.environ['a-b']", // 14
    'j = os.environ.get("PY_LAST")', // 15
  ].join('\n');
  const r = usesOf({ 'app/main.py': src });
  assert.deepEqual(names(r.undocumented), ['PY_GET', 'PY_GETENV', 'PY_LAST', 'PY_SUB', 'PY_WRITE']);
  assert.deepEqual(r.undocumented.find((x) => x.name === 'PY_GETENV'), { name: 'PY_GETENV', file: 'app/main.py', line: 4, column: at(src, '"PY_GETENV"').column, uses: 1 });
  assert.deepEqual(
    r.dynamic.map((d) => [d.line, d.column]),
    [[6, at(src, 'name)').column], [12, at(src, "'PY_X'").column]],
  );
});

test('uses in Go', () => {
  const src = [
    'package main', // 1
    'var a = os.Getenv("GO_GETENV")', // 2
    'var b, ok = os.LookupEnv("GO_LOOKUP")', // 3
    '// os.Getenv("GO_COMMENT")', // 4
    'var c = `os.Getenv("GO_RAW")`', // 5
    'var d = os.Getenv(name)', // 6
    'var e = os.Getenv("GO_A", x)', // 7
    "var f = 'x' + os.Getenv(\"GO_LAST\")", // 8
  ].join('\n');
  const r = usesOf({ 'main.go': src });
  assert.deepEqual(names(r.undocumented), ['GO_A', 'GO_GETENV', 'GO_LAST', 'GO_LOOKUP']);
  assert.deepEqual(r.dynamic.map((d) => [d.line, d.column]), [[6, at(src, 'name)').column]]);
  assert.equal(r.undocumented.find((x) => x.name === 'GO_GETENV').column, at(src, '"GO_GETENV"').column);
});

test('uses in Ruby', () => {
  const src = [
    "a = ENV['RB_SUB']", // 1
    "b = ENV.fetch('RB_FETCH')", // 2
    "c = ENV.fetch 'RB_NOPAREN'", // 3
    "d = \"x #{ENV['RB_INTERP']} y\"", // 4
    "# ENV['RB_COMMENT']", // 5
    'e = ENV[name]', // 6
    "f = 'ENV[\"RB_STR\"]'", // 7
    'g = ENV.fetch("RB_LAST", nil)', // 8
    "h = \"a\nENV['RB_IN_STRING']\"", // 9-10
    'i = ENV[nil]', // 11
  ].join('\n');
  const r = usesOf({ 'lib/x.rb': src });
  assert.deepEqual(names(r.undocumented), ['RB_FETCH', 'RB_INTERP', 'RB_LAST', 'RB_SUB']);
  assert.equal(r.undocumented.find((x) => x.name === 'RB_INTERP').column, at(src, "'RB_INTERP'").column);
  assert.deepEqual(r.dynamic.map((d) => d.line), [6, 11]);
});

test('uses in PHP', () => {
  const src = [
    '<?php', // 1
    "$a = $_ENV['PHP_ENV'];", // 2
    "$b = getenv('PHP_GETENV');", // 3
    "$c = $this->getenv('PHP_METHOD');", // 4
    "$d = Foo::getenv('PHP_STATIC');", // 5
    'function getenv($x) {}', // 6
    "// getenv('PHP_COMMENT')", // 7
    "# getenv('PHP_HASH')", // 8
    '/* getenv("PHP_BLOCK") */', // 9
    '$e = getenv($x);', // 10
    '$f = "getenv(\'PHP_STR\') $y";', // 11
    "$g = \\getenv('PHP_NS');", // 12
    "$h = $_ENV[$k];", // 13
  ].join('\n');
  const r = usesOf({ 'index.php': src });
  assert.deepEqual(names(r.undocumented), ['PHP_ENV', 'PHP_GETENV', 'PHP_NS']);
  assert.deepEqual(r.dynamic.map((d) => [d.line, d.column]), [[10, at(src, '$x);\n$f').column], [13, at(src, '$k]').column]]);
});

test('uses in shell scripts', () => {
  const src = [
    '#!/bin/sh', // 1
    '# $SH_COMMENT', // 2
    'echo "$SH_ONE ${SH_TWO:-x} $lower $1 ${#SH_LEN} $HOME $PATH"', // 3
    "echo '$SH_SINGLE'", // 4
    'echo \\$SH_ESC', // 5
    'SH_OWN=1', // 6
    'echo $SH_OWN', // 7
    'export SH_EXP=2', // 8
    'echo "$SH_EXP"', // 9
    'echo $SH_THREE#notcomment', // 10
    'x=$(echo $SH_FOUR)', // 11
    'echo $SH_FIVE # $SH_TRAILING_COMMENT', // 12
    'cd /tmp && SH_SIX=1 run; echo $SH_SIX $SH_SEVEN', // 13
  ].join('\n');
  const r = usesOf({ 'bin/run.sh': src });
  assert.deepEqual(names(r.undocumented), ['SH_FIVE', 'SH_FOUR', 'SH_ONE', 'SH_SEVEN', 'SH_THREE', 'SH_TWO']);
  assert.deepEqual(
    [r.undocumented.find((x) => x.name === 'SH_ONE').line, r.undocumented.find((x) => x.name === 'SH_ONE').column],
    [3, 7],
  );
  assert.equal(r.undocumented.find((x) => x.name === 'SH_TWO').column, at(src, '${SH_TWO').column);
  assert.equal(r.undocumented.find((x) => x.name === 'SH_FOUR').column, at(src, '$SH_FOUR').column);
  assert.deepEqual(r.dynamic, []);
});

test('positions count code points, and a used name is counted per use', () => {
  const src = 'const s = "\u{1F600}"; process.env.U_COL; process.env.U_COL;\nprocess.env.U_COL;\n';
  const r = usesOf({ 'u.js': src });
  assert.deepEqual(r.undocumented, [{ name: 'U_COL', file: 'u.js', line: 1, column: 28, uses: 3 }]);
});

test('which folders and files are scanned, and in which order', () => {
  const files = {
    '.env.example': '',
    'z.js': 'process.env.FIRST;\n',
    'a.js': '\n\nprocess.env.FIRST;\nprocess.env.ONLY_A;\n',
    'a/z.js': 'process.env.FIRST;\n',
    'b.js': 'process.env.FIRST;\n',
    'lib/types.d.ts': 'process.env.IN_DTS;\n',
    'node_modules/p/i.js': 'process.env.NO_NM;',
    'sub/node_modules/n.js': 'process.env.NO_SUBNM;',
    'vendor/v.js': 'process.env.NO_VENDOR;',
    'dist/d.js': 'process.env.NO_DIST;',
    'build/b.js': 'process.env.NO_BUILD;',
    'coverage/c.js': 'process.env.NO_COVERAGE;',
    '__pycache__/p.py': 'import os\nos.getenv("NO_PYCACHE")',
    '.hidden/h.js': 'process.env.NO_HIDDEN;',
    'sub/.git/g.js': 'process.env.NO_DOTSUB;',
    'README.md': 'process.env.NO_MD',
    'notes.txt': 'process.env.NO_TXT',
    'data.json': '{"process.env.NO_JSON": 1}',
    'conf/app.env': 'NO_ENV=1',
    '.eslintrc.js': 'process.env.IN_DOTFILE;',
  };
  const dir = project(files);
  let linked = false;
  try {
    const other = project({ 'l.js': 'process.env.NO_LINKED_DIR;' });
    symlinkSync(other, join(dir, 'linkdir'), 'junction');
    symlinkSync(join(other, 'l.js'), join(dir, 'linkfile.js'));
    linked = true;
  } catch {
    // symbolic links cannot be made here: the rest of the test still holds
  }
  const r = report(dir);
  assert.deepEqual(names(r.undocumented), ['FIRST', 'IN_DOTFILE', 'IN_DTS', 'ONLY_A']);
  const first = r.undocumented.find((x) => x.name === 'FIRST');
  assert.deepEqual(first, { name: 'FIRST', file: 'a.js', line: 3, column: 13, uses: 4 });
  assert.equal(r.sources.files, 6, linked ? 'symbolic links are not followed' : 'no links');
  assert.equal(r.sources.uses, 7);
});

test('extensions are matched in lower case only, and exactly', () => {
  const files = {
    'ok.js': 'process.env.E_JS;',
    'ok.jsx': 'process.env.E_JSX;',
    'ok.mjs': 'process.env.E_MJS;',
    'ok.cjs': 'process.env.E_CJS;',
    'ok.ts': 'process.env.E_TS;',
    'ok.tsx': 'process.env.E_TSX;',
    'ok.mts': 'process.env.E_MTS;',
    'ok.cts': 'process.env.E_CTS;',
    'ok.py': 'import os\nos.getenv("E_PY")',
    'ok.go': 'package main\nvar a = os.Getenv("E_GO")',
    'ok.rb': "a = ENV['E_RB']",
    'ok.php': '<?php\n$a = getenv("E_PHP");',
    'ok.sh': 'echo "$E_SH"',
    'A.JS': 'process.env.NO_UPPER_JS;',
    'b.Py': 'import os\nos.getenv("NO_MIXED_PY")',
    'c.Ts': 'process.env.NO_MIXED_TS;',
    'd.SH': 'echo "$NO_UPPER_SH"',
    'e.PHP': '<?php getenv("NO_UPPER_PHP");',
    'f.Mjs': 'process.env.NO_MIXED_MJS;',
    'data.json': 'process.env.NO_JSON;',
    'x.mjsx': 'process.env.NO_MJSX;',
    'x.ts.bak': 'process.env.NO_TSBAK;',
    'x.js.map': 'process.env.NO_JSMAP;',
    'x.jsonc': 'process.env.NO_JSONC;',
    'x.pyc': 'process.env.NO_PYC;',
    'x.gox': 'process.env.NO_GOX;',
    'js': 'process.env.NO_JUST_JS;',
    'py': 'import os\nos.getenv("NO_JUST_PY")',
    'sh': 'echo "$NO_JUST_SH"',
    'dir.js/inner.txt': 'process.env.NO_IN_JS_NAMED_DIR;',
  };
  const r = usesOf(files);
  const got = names(r.undocumented);
  assert.deepEqual(
    got,
    ['E_CJS', 'E_CTS', 'E_GO', 'E_JS', 'E_JSX', 'E_MJS', 'E_MTS', 'E_PHP', 'E_PY', 'E_RB', 'E_SH', 'E_TS', 'E_TSX'],
  );
  assert.equal(r.sources.files, 13);
});

test('skipped folders and dot-folders are not entered at any depth', () => {
  const files = {
    'ok.js': 'process.env.D_TOP;',
    'a/b/ok.js': 'process.env.D_DEEP;',
    'a/node_modules/x.js': 'process.env.NO_1;',
    'a/b/vendor/x.js': 'process.env.NO_2;',
    'a/b/c/dist/x.js': 'process.env.NO_3;',
    'a/build/x.js': 'process.env.NO_4;',
    'a/b/coverage/x.js': 'process.env.NO_5;',
    'a/__pycache__/x.py': 'import os\nos.getenv("NO_6")',
    'a/.cache/x.js': 'process.env.NO_7;',
    'a/b/.git/x.js': 'process.env.NO_8;',
    'a/b/c/.hidden/deep/x.js': 'process.env.NO_9;',
    '.top/x.js': 'process.env.NO_10;',
    'node_modules/y/z/x.js': 'process.env.NO_11;',
    // similar names that are not skipped
    'a/node_modules2/x.js': 'process.env.D_NM2;',
    'a/Vendor/x.js': 'process.env.D_CASE;',
    'a/builds/x.js': 'process.env.D_BUILDS;',
    'a/my.dist/x.js': 'process.env.D_MYDIST;',
  };
  const r = usesOf(files);
  assert.deepEqual(names(r.undocumented), ['D_BUILDS', 'D_CASE', 'D_DEEP', 'D_MYDIST', 'D_NM2', 'D_TOP']);
  assert.equal(r.sources.files, 6);
});

test('symbolic links give no names: to a file, to a folder, inside or outside, or to nothing', (t) => {
  const dir = project({ '.env.example': '', 'real.js': 'process.env.L_REAL;', 'sub/inner.js': 'process.env.L_INNER;' });
  const other = project({ 'out.js': 'process.env.NO_OUT_FILE;', 'od/o.js': 'process.env.NO_OUT_DIR;' });
  try {
    symlinkSync(join(other, 'out.js'), join(dir, 'link-out.js'));
    symlinkSync(join(dir, 'real.js'), join(dir, 'link-in.js'));
    symlinkSync(join(other, 'od'), join(dir, 'link-outdir'), 'junction');
    symlinkSync(join(dir, 'sub'), join(dir, 'link-indir'), 'junction');
    symlinkSync(join(dir, 'sub'), join(dir, 'sub', 'loop'), 'junction');
    symlinkSync(join(dir, 'nothing-here.js'), join(dir, 'dangling.js'));
    symlinkSync(join(dir, 'nothing-dir'), join(dir, 'dangling-dir'), 'junction');
    symlinkSync(join(other, 'od', 'o.js'), join(dir, 'sub', 'deep-link.js'));
  } catch {
    t.skip('symbolic links cannot be made on this platform');
    return;
  }
  const r = report(dir);
  assert.deepEqual(names(r.undocumented), ['L_INNER', 'L_REAL']);
  assert.equal(r.sources.files, 2);
  assert.equal(r.sources.uses, 2);
});

test('files are taken in code unit order of their relative paths', () => {
  // first use of a name belongs to the first file in the order
  const files = {
    'b.js': 'process.env.O_X;',
    'a/z.js': 'process.env.O_X;',
    'a.js': 'process.env.O_X;',
    'a-b.js': 'process.env.O_X;',
    'C.js': 'process.env.O_X;',
    'Z/y.js': 'process.env.O_X;',
    'é.js': 'process.env.O_X;',
  };
  const r = usesOf(files);
  assert.deepEqual(r.undocumented, [{ name: 'O_X', file: 'C.js', line: 1, column: 13, uses: 7 }]);
  // each file in turn is the first one when the ones before it are gone
  const order = ['C.js', 'Z/y.js', 'a-b.js', 'a.js', 'a/z.js', 'b.js', 'é.js'];
  const pairs = order.map((f) => [f, `process.env.${'P' + order.indexOf(f)};`]);
  const r2 = usesOf(Object.fromEntries(pairs.map(([f, c]) => [f, c + '\nprocess.env.SAME;'])));
  assert.equal(r2.undocumented.find((x) => x.name === 'SAME').file, 'C.js');
});

test('first use inside a file is the one that starts first, even a destructuring key', () => {
  const src = 'const { Y } = process.env;\nprocess.env.Y;\n';
  const r = usesOf({ 'a.js': src });
  assert.deepEqual(r.undocumented, [{ name: 'Y', file: 'a.js', line: 1, column: 9, uses: 2 }]);
});

test('dynamic uses are sorted by file, line, column', () => {
  const r = usesOf({
    'b.js': 'process.env[x];\n',
    'a.js': 'process.env[y]; process.env[z];\nprocess.env[w];\n',
    'c.py': 'import os\nos.getenv(q)\n',
  });
  assert.deepEqual(r.dynamic, [
    { file: 'a.js', line: 1, column: 13 },
    { file: 'a.js', line: 1, column: 29 },
    { file: 'a.js', line: 2, column: 13 },
    { file: 'b.js', line: 1, column: 13 },
    { file: 'c.py', line: 2, column: 11 },
  ]);
  assert.deepEqual(r.undocumented, []);
});

test('a byte-order mark in a code file does not move the columns', () => {
  const r = usesOf({ 'a.js': '﻿process.env.BOM_VAR;\n' });
  assert.deepEqual(r.undocumented, [{ name: 'BOM_VAR', file: 'a.js', line: 1, column: 13, uses: 1 }]);
});

// ------------------------------------------------------------------ the findings

const TOKEN = 'ghp_' + 'a'.repeat(36);

function scenario() {
  return project({
    '.env.example': ['DB_URL=x', 'PORT=1', 'PORT=2', 'OLD_VAR=1', `TOKEN=${TOKEN}`, 'bad'].join('\n') + '\n',
    '.env': 'PORT=1\nLOCAL_ONLY=1\n',
    'src/a.js': [
      'const p = process.env.PORT;',
      'const n = process.env.NEW_VAR + process.env.NEW_VAR;',
      'const t = process.env.TOKEN, d = process.env.DB_URL;',
    ].join('\n'),
  });
}

test('the plain output, line by line', () => {
  const r = run(scenario());
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    [
      'env-doctor 0.1.0: example .env.example, env .env, 1 source files',
      'undocumented (1)',
      '    NEW_VAR  src/a.js:2:23  uses: 2',
      'stale (1)',
      '    OLD_VAR  .env.example:4',
      'missing (3)',
      '    DB_URL  absent',
      '    OLD_VAR  absent',
      '    TOKEN  absent',
      'unexpected (1)',
      '    LOCAL_ONLY  .env:2',
      'duplicates (1)',
      '    PORT  .env.example  lines: 2, 3',
      'malformed (1)',
      '    .env.example:6  missing-equals',
      'secrets (1)',
      '    TOKEN  .env.example:5  github-token',
      'counts: undocumented=1 stale=1 missing=3 unexpected=1 duplicates=1 malformed=1 secrets=1 dynamic=0 expansions=0',
      '',
    ].join('\n'),
  );
});

test('the plain output when all is well, with no env and with dynamic uses', () => {
  const dir = project({ '.env.example': 'A=1\n', 'a.js': 'process.env.A; process.env[k];\n' });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    [
      'env-doctor 0.1.0: example .env.example, env (none), 1 source files',
      'dynamic (1)',
      '    a.js:1:28',
      'counts: undocumented=0 stale=0 missing=0 unexpected=0 duplicates=0 malformed=0 secrets=0 dynamic=1 expansions=0',
      '',
    ].join('\n'),
  );
});

test('the JSON output, whole', () => {
  const r = run(scenario(), ['--json']);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.endsWith('}\n'));
  assert.ok(r.stdout.startsWith('{\n  "tool": "env-doctor"'));
  assert.deepEqual(JSON.parse(r.stdout), {
    tool: 'env-doctor',
    version: '0.1.0',
    example: '.env.example',
    env: '.env',
    failOn: ['undocumented', 'missing', 'duplicates', 'malformed', 'secrets'],
    ok: false,
    sources: { files: 1, uses: 5 },
    undocumented: [{ name: 'NEW_VAR', file: 'src/a.js', line: 2, column: 23, uses: 2 }],
    stale: [{ name: 'OLD_VAR', line: 4 }],
    missing: [
      { name: 'DB_URL', line: 1, reason: 'absent' },
      { name: 'OLD_VAR', line: 4, reason: 'absent' },
      { name: 'TOKEN', line: 5, reason: 'absent' },
    ],
    unexpected: [{ name: 'LOCAL_ONLY', line: 2 }],
    duplicates: [{ name: 'PORT', file: '.env.example', lines: [2, 3] }],
    malformed: [{ file: '.env.example', line: 6, reason: 'missing-equals' }],
    secrets: [{ name: 'TOKEN', line: 5, pattern: 'github-token' }],
    dynamic: [],
    expansions: [],
    counts: { undocumented: 1, stale: 1, missing: 3, unexpected: 1, duplicates: 1, malformed: 1, secrets: 1, dynamic: 0, expansions: 0 },
  });
});

test('the JSON output when nothing is wrong: all nine lists are present', () => {
  const dir = project({ '.env.example': 'A=1\n', '.env': 'A=2\n', 'a.js': 'process.env.A' });
  const r = run(dir, ['--json']);
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.ok, true);
  for (const l of ['undocumented', 'stale', 'missing', 'unexpected', 'duplicates', 'malformed', 'secrets', 'dynamic', 'expansions']) {
    assert.deepEqual(o[l], [], l);
    assert.equal(o.counts[l], 0);
  }
  const none = project({ '.env.example': 'A=1\n' });
  assert.equal(JSON.parse(run(none, ['--json']).stdout).env, null);
});

test('sorting of every list', () => {
  const dir = project({
    '.env.example': ['Z=1', 'B=2', '_C=3', 'a=4', 'B=5', 'Z=6', 'ZZ="' + 'x' + '" y'].join('\n') + '\n',
    '.env': ['zz=1', 'YY=2', 'aa=3', 'YY=4', 'q'].join('\n') + '\n',
    'x.js': 'process.env.u2; process.env.U1; process.env._u; process.env.a; process.env.A_;\n',
  });
  const r = report(dir);
  assert.deepEqual(names(r.undocumented), ['A_', 'U1', '_u', 'u2']);
  assert.deepEqual(names(r.stale), ['B', 'Z', '_C']);
  assert.deepEqual(names(r.missing), ['B', 'Z', '_C', 'a']);
  assert.deepEqual(names(r.unexpected), ['YY', 'aa', 'zz']);
  assert.deepEqual(r.duplicates.map((d) => [d.file, d.name, d.lines]), [
    ['.env', 'YY', [2, 4]],
    ['.env.example', 'Z', [1, 6]],
    ['.env.example', 'B', [2, 5]],
  ]);
  assert.deepEqual(r.malformed.map((m) => [m.file, m.line]), [['.env', 5], ['.env.example', 7]]);
});

test('stale is empty when there is no code file', () => {
  const dir = project({ '.env.example': 'A=1\n', 'README.md': 'process.env.A' });
  const r = report(dir);
  assert.deepEqual(r.stale, []);
  assert.equal(r.sources.files, 0);
});

test('secrets: seven patterns, by name, line and pattern, in the template only', () => {
  const pk = '-----BEGIN ' + 'RSA ' + 'PRIVATE' + ' KEY' + '-----';
  const values = {
    AWS: 'AKIA' + 'A'.repeat(16),
    AWS2: 'ASIA' + '1'.repeat(16),
    GH: 'ghp_' + 'a'.repeat(36),
    GH2: 'github_pat_' + 'b'.repeat(22),
    SLACK: 'xoxb-' + '1234567890',
    STRIPE: 'sk_' + 'live_' + 'a'.repeat(16),
    STRIPE_R: 'rk_' + 'live_' + 'a'.repeat(16),
    GOOGLE: 'AIza' + 'a'.repeat(35),
    JWT: 'eyJ' + 'a'.repeat(8) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(8),
    SHORT_AWS: 'AKIA' + 'A'.repeat(15),
    SHORT_GH: 'ghp_' + 'a'.repeat(35),
    PLAIN: 'changeme',
  };
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  lines.push(`PEM="${pk}\nabc\n"`);
  lines.push(`GH=${values.AWS}`);
  const template = lines.join('\n') + '\n';
  const dir = project({ '.env.example': template, '.env': lines.join('\n') + '\n' });
  const r = report(dir);
  assert.deepEqual(r.secrets, [
    { name: 'AWS', line: 1, pattern: 'aws-access-key' },
    { name: 'AWS2', line: 2, pattern: 'aws-access-key' },
    { name: 'GH', line: 3, pattern: 'github-token' },
    { name: 'GH2', line: 4, pattern: 'github-token' },
    { name: 'SLACK', line: 5, pattern: 'slack-token' },
    { name: 'STRIPE', line: 6, pattern: 'stripe-live-key' },
    { name: 'STRIPE_R', line: 7, pattern: 'stripe-live-key' },
    { name: 'GOOGLE', line: 8, pattern: 'google-api-key' },
    { name: 'JWT', line: 9, pattern: 'jwt' },
    { name: 'PEM', line: 13, pattern: 'private-key' },
    { name: 'GH', line: 16, pattern: 'aws-access-key' },
  ]);
  for (const out of [run(dir).stdout, run(dir, ['--json']).stdout, run(dir, ['--github']).stdout]) {
    for (const v of Object.values(values)) assert.ok(!out.includes(v), 'a value was printed');
    assert.ok(!out.includes(pk));
  }
  // a secret only in the checked file is not reported
  const only = project({ '.env.example': 'A=1\n', '.env': `A=${values.GH}\n` });
  assert.deepEqual(report(only).secrets, []);
});

test('--ignore: names, /regex/ and /regex/i, in every list with names', () => {
  const dir = project({
    '.env.example': ['KEEP=1', 'SKIP_A=2', 'SKIP_A=3', 'Skip_b=4', `SKIP_TOKEN=${TOKEN}`, 'HOST=h', 'SKIP_URL=${HOST}', 'bad line'].join('\n') + '\n',
    '.env': 'SKIP_X=1\nKEEP=\n',
    'a.js': 'process.env.SKIP_NEW; process.env.OTHER_NEW;',
  });
  let r = report(dir);
  assert.equal(r.counts.undocumented, 2);
  assert.ok(r.counts.secrets === 1 && r.counts.duplicates === 1 && r.counts.expansions === 1 && r.counts.unexpected === 1);
  r = report(dir, ['--ignore', 'SKIP_NEW', '--ignore', '/^SKIP_/', '--ignore', '/^skip_b$/i']);
  assert.deepEqual(names(r.undocumented), ['OTHER_NEW']);
  assert.deepEqual(names(r.stale), ['KEEP']);
  assert.deepEqual(names(r.missing), ['HOST', 'KEEP']);
  assert.deepEqual(r.unexpected, []);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.secrets, []);
  assert.deepEqual(r.expansions, []);
  assert.equal(r.malformed.length, 1);
  assert.equal(r.counts.missing, 2);
  // exact and case-sensitive names; a regex is tested, not anchored
  r = report(dir, ['--ignore', 'skip_new']);
  assert.ok(names(r.undocumented).includes('SKIP_NEW'));
  r = report(dir, ['--ignore=/NEW/']);
  assert.deepEqual(names(r.undocumented), []);
  r = report(dir, ['--ignore', '/new/']);
  assert.equal(r.counts.undocumented, 2);
  r = report(dir, ['--ignore', '/new/i']);
  assert.equal(r.counts.undocumented, 0);
  // not a regex: no closing slash, or nothing between the slashes
  r = report(dir, ['--ignore', '/SKIP_NEW']);
  assert.equal(r.counts.undocumented, 2);
  r = report(dir, ['--ignore', '//']);
  assert.equal(r.counts.undocumented, 2);
  // ignored findings do not give exit code 1
  const only = project({ '.env.example': 'A=1\n', 'a.js': 'process.env.NEWONE;' });
  assert.equal(run(only).status, 1);
  assert.equal(run(only, ['--ignore', 'NEWONE']).status, 0);
});

test('--fail-on: default, kinds, all, none, spaces, last one counts', () => {
  const staleOnly = project({ '.env.example': 'A=1\nB=2\n', '.env': 'A=1\nB=2\n', 'a.js': 'process.env.A;' });
  assert.equal(run(staleOnly).status, 0);
  let r = run(staleOnly, ['--json', '--fail-on', 'stale']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.deepEqual(JSON.parse(r.stdout).failOn, ['stale']);
  assert.equal(run(staleOnly, ['--fail-on=all']).status, 1);
  assert.equal(run(staleOnly, ['--fail-on', 'none']).status, 0);
  assert.equal(run(staleOnly, ['--fail-on', ' undocumented , stale ']).status, 1);
  assert.equal(run(staleOnly, ['--fail-on', 'stale', '--fail-on', 'none']).status, 0);
  assert.equal(run(staleOnly, ['--fail-on', 'none', '--fail-on', 'stale']).status, 1);

  const bad = scenario();
  assert.equal(run(bad, ['--fail-on', 'none']).status, 0);
  assert.equal(run(bad, ['--fail-on', 'unexpected']).status, 1);
  assert.equal(run(bad, ['--fail-on', 'secrets']).status, 1);
  r = run(bad, ['--json', '--fail-on', 'secrets,undocumented']);
  assert.deepEqual(JSON.parse(r.stdout).failOn, ['undocumented', 'secrets']);
  r = run(bad, ['--json', '--fail-on', 'all']);
  assert.deepEqual(JSON.parse(r.stdout).failOn, ['undocumented', 'stale', 'missing', 'unexpected', 'duplicates', 'malformed', 'secrets']);
  r = run(bad, ['--json', '--fail-on', 'none']);
  assert.deepEqual(JSON.parse(r.stdout).failOn, []);
  assert.equal(JSON.parse(r.stdout).ok, true);
  // dynamic and expansions are not kinds
  const dyn = project({ '.env.example': 'A=1\nB=${A}\n', 'a.js': 'process.env.A; process.env.B; process.env[x];' });
  assert.equal(run(dyn, ['--fail-on', 'all']).status, 0);
  assert.equal(run(dyn, ['--fail-on', 'dynamic']).status, 2);
  // each default kind alone
  assert.equal(run(project({ '.env.example': 'A=1\n', '.env': 'A=\n' })).status, 1);
  assert.equal(run(project({ '.env.example': 'A=1\nA=2\n' })).status, 1);
  assert.equal(run(project({ '.env.example': 'A\n' })).status, 1);
  assert.equal(run(project({ '.env.example': 'A=1\n', 'a.js': 'process.env.A;process.env.NEW;' })).status, 1);
  assert.equal(run(project({ '.env.example': 'A=1\n', '.env': 'A=1\nB=2\n' })).status, 0);
});

test('--github: one workflow command per item, error or warning', () => {
  const dir = scenario();
  const r = run(dir, ['--github']);
  assert.equal(r.status, 1);
  const lines = r.stdout.split('\n');
  assert.equal(lines.pop(), '');
  const expected = [
    ['error', 'file=src/a.js,line=2,col=23', 'undocumented', 'NEW_VAR'],
    ['warning', 'file=.env.example,line=4', 'stale', 'OLD_VAR'],
    ['error', 'file=.env.example,line=1', 'missing', 'DB_URL'],
    ['error', 'file=.env.example,line=4', 'missing', 'OLD_VAR'],
    ['error', 'file=.env.example,line=5', 'missing', 'TOKEN'],
    ['warning', 'file=.env,line=2', 'unexpected', 'LOCAL_ONLY'],
    ['error', 'file=.env.example,line=2', 'duplicates', 'PORT'],
    ['error', 'file=.env.example,line=6', 'malformed', 'missing-equals'],
    ['error', 'file=.env.example,line=5', 'secrets', 'TOKEN'],
  ];
  assert.equal(lines.length, expected.length);
  expected.forEach(([level, where, kind, word], i) => {
    assert.ok(lines[i].startsWith(`::${level} ${where}::${kind}: `), lines[i]);
    assert.ok(lines[i].includes(word), lines[i]);
  });
  // with --fail-on all every line is an error; with none every line is a warning
  assert.ok(run(dir, ['--github', '--fail-on', 'all']).stdout.split('\n').filter(Boolean).every((l) => l.startsWith('::error ')));
  const w = run(dir, ['--github', '--fail-on', 'none']);
  assert.equal(w.status, 0);
  assert.ok(w.stdout.split('\n').filter(Boolean).every((l) => l.startsWith('::warning ')));
  // nothing at all when there are no items; dynamic and expansions give no line
  const quiet = project({ '.env.example': 'A=1\nB=${A}\n', 'a.js': 'process.env.A; process.env.B; process.env[k];' });
  const q = run(quiet, ['--github']);
  assert.equal(q.status, 0);
  assert.equal(q.stdout, '');
});

test('--github: %, comma and line breaks in the file are escaped', () => {
  const dir = project({ 'a,b%c.example': 'A=1\nA=2\n' });
  const r = run(dir, ['--github', '--example', 'a,b%c.example']);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.startsWith('::error file=a%2Cb%25c.example,line=1::duplicates: '), r.stdout);
  assert.equal(r.stdout.split('\n').length, 2);
});

// ------------------------------------------------------------------ usage errors

test('usage errors: exit 2, nothing on stdout, a reason on stderr', () => {
  const dir = project({ '.env.example': 'A=1\n', '.env': 'A=1\n', 'a-file': 'x' });
  const cases = [
    ['--bogus'],
    ['-x'],
    ['--json=1'],
    ['--env'],
    ['--example'],
    ['--fail-on'],
    ['--ignore'],
    ['--env='],
    ['--ignore='],
    ['--fail-on='],
    ['--env', ''],
    ['one', 'two'],
    ['.', '.'],
    ['no-such-folder'],
    ['a-file'],
    ['-'],
    ['--fail-on', 'bogus'],
    ['--fail-on', 'undocumented,bogus'],
    ['--fail-on', 'all,stale'],
    ['--fail-on', 'none,none'],
    ['--fail-on', ''],
    ['--json', '--github'],
    ['--ignore', '/(/'],
    ['--ignore', '/[/i'],
    ['--env', 'missing.env'],
    ['--env', '.'],
    ['--example', 'missing.example'],
    ['--example', 'a-file/..'],
  ];
  for (const args of cases) {
    const r = run(dir, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '', JSON.stringify(args));
    assert.ok(r.stderr.trim().length > 0, JSON.stringify(args));
  }
  // with a json or github request the stdout is still empty
  const g = run(dir, ['--github', '--fail-on', 'bogus']);
  assert.equal(g.status, 2);
  assert.equal(g.stdout, '');
  const j = run(project({}), ['--json']);
  assert.equal(j.status, 2);
  assert.equal(j.stdout, '');
});

test('--help and -h print a usage line and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = run(project({}), [flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage: env-doctor /);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.equal(r.stderr, '');
  }
});

test('an option value may start with a dash, and options may come before or after the dir', () => {
  const dir = project({ '.env.example': 'A=1\n', '-x.example': 'B=1\n' });
  const r = run(dir, ['--example', '-x.example', '--json']);
  assert.equal(JSON.parse(r.stdout).example, '-x.example');
  const parent = dirname(dir);
  const base = dir.slice(parent.length + 1);
  assert.equal(JSON.parse(run(parent, ['--json', base]).stdout).example, '.env.example');
  assert.equal(JSON.parse(run(parent, [base, '--json']).stdout).example, '.env.example');
});

// ------------------------------------------------------------------ never a value

test('no value and no line of a .env file is in any output', () => {
  const v1 = 'zq1' + 'VALUE'.toLowerCase() + 'one';
  const v2 = 'secret-looking-' + 'text-two';
  const v3 = 'leaky' + 'garbage' + 'three';
  const template = [
    `A=${v1}`, // 1
    `B="${v2}" ${v3}`, // 2 trailing-text
    `my-key=${v3}`, // 3 invalid-key
    `C ${v3}`, // 4 missing-equals
    `D="${v3}`, // 5 unterminated
    `E=\${A}${v2}`, // 6
  ].join('\n') + '\n';
  const env = [`A=${v1}`, `LOCAL=${v2}`, `A=${v3}`, `broken ${v1}`].join('\n') + '\n';
  const dir = project({ '.env.example': template, '.env': env, 'a.js': 'process.env.NEW_ONE; process.env[k];' });
  const outputs = [];
  for (const args of [[], ['--json'], ['--github'], ['--github', '--fail-on', 'all'], ['--fail-on', 'all'], ['--env', '.env.example']]) {
    const r = run(dir, args);
    outputs.push(r.stdout, r.stderr);
  }
  for (const out of outputs) {
    for (const v of [v1, v2, v3]) assert.ok(!out.includes(v), `value found in output: ${out}`);
  }
  // an error that names a file never carries its content
  const bad = run(dir, ['--env', 'nothing-' + v1]);
  assert.equal(bad.status, 2);
  assert.ok(!bad.stdout.includes(v2) && !bad.stderr.includes(v2));
});
