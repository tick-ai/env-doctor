#!/usr/bin/env node
// env-doctor: the environment variables your code needs and your .env files miss.
// One file, Node 22, built-in modules only. It never prints a value from a .env file.

import fs from 'node:fs';
import path from 'node:path';

const TOOL = 'env-doctor';
const VERSION = '0.1.0';

const KINDS = ['undocumented', 'stale', 'missing', 'unexpected', 'duplicates', 'malformed', 'secrets'];
const LISTS = ['undocumented', 'stale', 'missing', 'unexpected', 'duplicates', 'malformed', 'secrets', 'dynamic', 'expansions'];
const DEFAULT_FAIL_ON = ['undocumented', 'missing', 'duplicates', 'malformed', 'secrets'];

const USAGE =
  'usage: env-doctor [dir] [--env <file>] [--example <file>] [--json | --github] [--fail-on <kinds>] [--ignore <name or /regex/>]...';

class UsageError extends Error {}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = {
    dir: null,
    env: null,
    example: null,
    json: false,
    github: false,
    failOn: null,
    ignore: [],
    help: false,
  };
  const valueOptions = new Set(['--env', '--example', '--fail-on', '--ignore']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      o.help = true;
      return o;
    }
    if (a === '--json') {
      o.json = true;
      continue;
    }
    if (a === '--github') {
      o.github = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (valueOptions.has(name)) {
        let value;
        if (eq !== -1) value = a.slice(eq + 1);
        else if (i + 1 < argv.length) value = argv[++i];
        else throw new UsageError(`option ${name} needs a value`);
        if (value === '') throw new UsageError(`option ${name} needs a value that is not empty`);
        if (name === '--env') o.env = value;
        else if (name === '--example') o.example = value;
        else if (name === '--fail-on') o.failOn = value;
        else o.ignore.push(value);
        continue;
      }
      throw new UsageError(`unknown option ${name}`);
    }
    if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`unknown option ${a}`);
    }
    if (o.dir !== null) throw new UsageError('more than one dir given');
    o.dir = a;
  }
  return o;
}

function parseFailOn(value) {
  if (value === null) return DEFAULT_FAIL_ON.slice();
  const parts = value.split(',').map((s) => s.trim());
  if (parts.includes('all') || parts.includes('none')) {
    if (parts.length !== 1) throw new UsageError("--fail-on: 'all' and 'none' stand alone");
    return parts[0] === 'all' ? KINDS.slice() : [];
  }
  for (const p of parts) {
    if (!KINDS.includes(p)) {
      throw new UsageError(`--fail-on: unknown kind '${p}' (kinds: ${KINDS.join(', ')}, all, none)`);
    }
  }
  return KINDS.filter((k) => parts.includes(k));
}

function parseIgnores(values) {
  const names = new Set();
  const regexes = [];
  for (const v of values) {
    const m = /^\/([^]+)\/(i?)$/.exec(v);
    if (m) {
      try {
        regexes.push(new RegExp(m[1], m[2]));
      } catch (e) {
        throw new UsageError(`--ignore: cannot compile the regular expression ${v}: ${e.message}`);
      }
    } else {
      names.add(v);
    }
  }
  return (name) => names.has(name) || regexes.some((r) => r.test(name));
}

// ---------------------------------------------------------------- files

function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

function displayPath(dirAbs, fileAbs, given) {
  const rel = path.relative(dirAbs, fileAbs);
  if (rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return given;
}

const TEMPLATE_NAMES = ['.env.example', '.env.sample', '.env.template'];

function chooseTemplate(dirAbs, example) {
  if (example !== null) {
    const abs = path.resolve(dirAbs, example);
    if (!isRegularFile(abs)) throw new UsageError(`--example is not an existing file: ${example}`);
    return { abs, file: displayPath(dirAbs, abs, example), name: path.basename(abs) };
  }
  for (const n of TEMPLATE_NAMES) {
    const abs = path.join(dirAbs, n);
    if (isRegularFile(abs)) return { abs, file: n, name: n };
  }
  throw new UsageError('no template found: give --example, or add .env.example, .env.sample or .env.template');
}

function chooseEnv(dirAbs, env, template) {
  if (env !== null) {
    const abs = path.resolve(dirAbs, env);
    if (!isRegularFile(abs)) throw new UsageError(`--env is not an existing file: ${env}`);
    return { abs, file: displayPath(dirAbs, abs, env) };
  }
  for (const n of ['.env', '.env.local']) {
    const abs = path.join(dirAbs, n);
    if (isRegularFile(abs)) return { abs, file: n };
  }
  let names = [];
  try {
    names = fs.readdirSync(dirAbs);
  } catch {
    names = [];
  }
  const left = new Set([...TEMPLATE_NAMES, '.env.local']);
  const modes = names
    .filter((n) => /^\.env\.[A-Za-z0-9_-]+$/.test(n) && !left.has(n) && path.join(dirAbs, n) !== template.abs)
    .sort(cmp);
  for (const n of modes) {
    const abs = path.join(dirAbs, n);
    if (isRegularFile(abs)) return { abs, file: n };
  }
  return null;
}

// ---------------------------------------------------------------- dotenv

const isBlank = (c) => c === ' ' || c === '\t';

function parseDotenv(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const n = text.length;
  const assignments = [];
  const malformed = [];
  let pos = 0;
  let line = 1;
  const lineEnd = (p) => {
    const e = text.indexOf('\n', p);
    return e === -1 ? n : e;
  };

  while (pos < n) {
    const startLine = line;
    const le = lineEnd(pos);
    let i = pos;
    while (i < le && isBlank(text[i])) i++;
    if (i >= le || text[i] === '#') {
      pos = le + 1;
      line++;
      continue;
    }
    if (text.startsWith('export', i) && i + 6 < le && isBlank(text[i + 6])) {
      i += 6;
      while (i < le && isBlank(text[i])) i++;
    }
    const km = /[A-Za-z_][A-Za-z0-9_]*/y;
    km.lastIndex = i;
    const k = km.exec(text);
    const bad = (reason) => {
      malformed.push({ line: startLine, reason });
    };
    if (!k) {
      bad('invalid-key');
      pos = le + 1;
      line++;
      continue;
    }
    const name = k[0];
    i += name.length;
    if (i < le && !isBlank(text[i]) && text[i] !== '=') {
      bad('invalid-key');
      pos = le + 1;
      line++;
      continue;
    }
    while (i < le && isBlank(text[i])) i++;
    if (i >= le || text[i] !== '=') {
      bad('missing-equals');
      pos = le + 1;
      line++;
      continue;
    }
    i++;
    while (i < le && isBlank(text[i])) i++;
    const q = i < le ? text[i] : '';
    if (q === '"' || q === "'") {
      let close = -1;
      let k2 = i + 1;
      if (q === '"') {
        while (k2 < n) {
          const ch = text[k2];
          if (ch === '\\') k2 += 2;
          else if (ch === '"') {
            close = k2;
            break;
          } else k2++;
        }
      } else {
        close = text.indexOf("'", k2);
      }
      if (close === -1) {
        bad('unterminated-quote');
        pos = le + 1;
        line++;
        continue;
      }
      const rawValue = text.slice(i + 1, close);
      const closeLineEnd = lineEnd(close);
      let r = close + 1;
      while (r < closeLineEnd && isBlank(text[r])) r++;
      const trailing = !(r >= closeLineEnd || text[r] === '#');
      let value = rawValue;
      if (q === '"') {
        value = rawValue.replace(/\\([\s\S])/g, (m, c) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '"' ? '"' : c === '\\' ? '\\' : m,
        );
      }
      // lines consumed
      let lines = 0;
      for (let p = pos; p < closeLineEnd; p++) if (text.charCodeAt(p) === 10) lines++;
      if (trailing) {
        bad('trailing-text');
      } else {
        assignments.push(makeAssignment(name, startLine, value, q === "'"));
      }
      pos = closeLineEnd + 1;
      line = startLine + lines + 1;
      continue;
    }
    // unquoted
    let end = le;
    for (let p = i; p < le; p++) {
      if (text[p] === '#' && (p === i || isBlank(text[p - 1]))) {
        end = p;
        break;
      }
    }
    let value = text.slice(i, end);
    value = value.replace(/[ \t]+$/, '');
    assignments.push(makeAssignment(name, startLine, value, false));
    pos = le + 1;
    line++;
  }
  return { assignments, malformed };
}

function makeAssignment(name, line, value, single) {
  const refs = new Set();
  if (!single) {
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) refs.add(m[1]);
  }
  return { name, line, value, empty: value === '', refs: [...refs].sort(cmp) };
}

function summarize(assignments) {
  const by = new Map();
  for (const a of assignments) {
    let e = by.get(a.name);
    if (!e) {
      e = { name: a.name, line: a.line, lines: [], last: a };
      by.set(a.name, e);
    }
    e.lines.push(a.line);
    e.last = a;
  }
  return by;
}

const SECRET_PATTERNS = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE\x20KEY-----/],
];

function secretPattern(value) {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(value)) return name;
  return null;
}

// ---------------------------------------------------------------- code files

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__']);
const LANG_BY_EXT = [
  ['.js', 'js'], ['.jsx', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.ts', 'js'], ['.tsx', 'js'], ['.mts', 'js'], ['.cts', 'js'],
  ['.py', 'py'], ['.go', 'go'], ['.rb', 'rb'], ['.php', 'php'], ['.sh', 'sh'],
];

function langOf(name) {
  const lower = name.toLowerCase();
  for (const [ext, lang] of LANG_BY_EXT) if (lower.endsWith(ext)) return lang;
  return null;
}

function listCodeFiles(dirAbs) {
  const found = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel === '' ? e.name : rel + '/' + e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        const lang = langOf(e.name);
        if (lang) found.push({ rel: r, abs: path.join(abs, e.name), lang });
      }
    }
  };
  walk(dirAbs, '');
  found.sort((a, b) => cmp(a.rel, b.rel));
  return found;
}

const STATIC_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isWs(c) {
  const code = c.charCodeAt(0);
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return /\s/.test(c);
}

function tokenize(text, lang) {
  const toks = [];
  const n = text.length;
  const isJs = lang === 'js';
  const nameStart = isJs ? /[A-Za-z_$]/ : /[A-Za-z_]/;
  const nameChar = isJs ? /[A-Za-z0-9_$]/ : /[A-Za-z0-9_]/;
  const slashComments = lang === 'js' || lang === 'go' || lang === 'php';
  const hashComments = lang === 'py' || lang === 'rb' || lang === 'php';
  let i = 0;

  const skipToLineEnd = () => {
    const e = text.indexOf('\n', i);
    i = e === -1 ? n : e;
  };

  // A string that ends at the same quote or at the end of the line.
  const readLineString = (q) => {
    const tok = { t: 'str', pos: i, closed: false, dynamic: false, v: '' };
    toks.push(tok);
    let j = i + 1;
    let s = '';
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') {
        if (j + 1 < n) s += text[j + 1];
        j += 2;
        continue;
      }
      if (ch === q) {
        tok.closed = true;
        j++;
        break;
      }
      if (ch === '\n') break;
      s += ch;
      j++;
    }
    tok.v = s;
    i = Math.min(j, n);
  };

  // A string that may span lines, with backslash pairs, and an optional interpolation opener.
  const readMulti = (q, opener) => {
    const tok = { t: 'str', pos: i, closed: false, dynamic: false, v: '' };
    toks.push(tok);
    let j = i + 1;
    let s = '';
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') {
        if (j + 1 < n) s += text[j + 1];
        j += 2;
        continue;
      }
      if (ch === q) {
        tok.closed = true;
        j++;
        break;
      }
      if (opener && text.startsWith(opener, j)) {
        tok.dynamic = true;
        i = j + 2;
        lex(true);
        j = i;
        continue;
      }
      s += ch;
      j++;
    }
    tok.v = s;
    i = Math.min(j, n);
  };

  const readRaw = (q) => {
    const tok = { t: 'str', pos: i, closed: false, dynamic: false, v: '' };
    toks.push(tok);
    const e = text.indexOf(q, i + 1);
    if (e === -1) {
      tok.v = text.slice(i + 1);
      i = n;
    } else {
      tok.closed = true;
      tok.v = text.slice(i + 1, e);
      i = e + 1;
    }
  };

  const readTriple = (q) => {
    const tq = q.repeat(3);
    const tok = { t: 'str', pos: i, closed: false, dynamic: false, v: '' };
    toks.push(tok);
    let j = i + 3;
    let s = '';
    while (j < n) {
      if (text[j] === '\\') {
        if (j + 1 < n) s += text[j + 1];
        j += 2;
        continue;
      }
      if (text.startsWith(tq, j)) {
        tok.closed = true;
        j += 3;
        break;
      }
      s += text[j];
      j++;
    }
    tok.v = s;
    i = Math.min(j, n);
  };

  function lex(inner) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (isWs(c)) {
        i++;
        continue;
      }
      if (slashComments && c === '/' && text[i + 1] === '/') {
        skipToLineEnd();
        continue;
      }
      if (slashComments && c === '/' && text[i + 1] === '*') {
        const e = text.indexOf('*/', i + 2);
        i = e === -1 ? n : e + 2;
        continue;
      }
      if (hashComments && c === '#') {
        skipToLineEnd();
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        if (lang === 'js') {
          if (c === '`') readMulti('`', '${');
          else readLineString(c);
        } else if (lang === 'py') {
          if (c !== '`') {
            if (text.startsWith(c.repeat(3), i)) readTriple(c);
            else readLineString(c);
          } else {
            toks.push({ t: 'p', v: c, pos: i });
            i++;
          }
        } else if (lang === 'go') {
          if (c === '`') readRaw('`');
          else readLineString(c);
        } else if (lang === 'rb') {
          if (c === '"') readMulti('"', '#{');
          else if (c === "'") readMulti("'", null);
          else {
            toks.push({ t: 'p', v: c, pos: i });
            i++;
          }
        } else {
          // php
          if (c === '`') {
            toks.push({ t: 'p', v: c, pos: i });
            i++;
          } else readMulti(c, null);
        }
        continue;
      }
      if (lang === 'php' && c === '$' && i + 1 < n && /[A-Za-z_]/.test(text[i + 1])) {
        let j = i + 1;
        while (j < n && nameChar.test(text[j])) j++;
        toks.push({ t: 'name', v: text.slice(i, j), pos: i });
        i = j;
        continue;
      }
      if (nameStart.test(c)) {
        let j = i + 1;
        while (j < n && nameChar.test(text[j])) j++;
        toks.push({ t: 'name', v: text.slice(i, j), pos: i });
        i = j;
        continue;
      }
      if (c >= '0' && c <= '9') {
        let j = i + 1;
        while (j < n && text[j] >= '0' && text[j] <= '9') j++;
        toks.push({ t: 'num', v: text.slice(i, j), pos: i });
        i = j;
        continue;
      }
      if (inner) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      const cp = text.codePointAt(i);
      const len = cp > 0xffff ? 2 : 1;
      toks.push({ t: 'p', v: text.slice(i, i + len), pos: i });
      i += len;
    }
  }

  lex(false);
  return toks;
}

const PREFIXES = {
  js: {
    subscript: [['process', '.', 'env'], ['import', '.', 'meta', '.', 'env'], ['Bun', '.', 'env']],
    call: [['Deno', '.', 'env', '.', 'get']],
    dot: [['process', '.', 'env'], ['import', '.', 'meta', '.', 'env'], ['Bun', '.', 'env']],
  },
  py: {
    subscript: [['os', '.', 'environ']],
    call: [['os', '.', 'environ', '.', 'get'], ['os', '.', 'getenv']],
    dot: [],
  },
  go: { subscript: [], call: [['os', '.', 'Getenv'], ['os', '.', 'LookupEnv']], dot: [] },
  rb: { subscript: [['ENV']], call: [['ENV', '.', 'fetch']], dot: [] },
  php: { subscript: [['$_ENV']], call: [['getenv']], dot: [] },
};

const isP = (t, v) => !!t && t.t === 'p' && t.v === v;
const isN = (t, v) => !!t && t.t === 'name' && t.v === v;
const isPlain = (t) => !!t && t.t === 'str' && t.closed && !t.dynamic;

function matchPrefix(toks, i, pat) {
  for (let k = 0; k < pat.length; k++) {
    const t = toks[i + k];
    if (pat[k] === '.' ? !isP(t, '.') : !isN(t, pat[k])) return false;
  }
  return true;
}

function findUses(toks, lang) {
  const uses = []; // { name, pos }
  const dyn = []; // pos
  const pf = PREFIXES[lang];
  const use = (name, pos) => uses.push({ name, pos });

  const subscript = (k) => {
    if (!isP(toks[k], '[')) return;
    const a = toks[k + 1];
    if (!a || isP(a, ']')) return;
    if (isPlain(a) && isP(toks[k + 2], ']')) {
      if (STATIC_NAME.test(a.v)) use(a.v, a.pos);
      return;
    }
    dyn.push(a.pos);
  };
  const call = (k) => {
    if (!isP(toks[k], '(')) return;
    const a = toks[k + 1];
    if (!a || isP(a, ')')) return;
    if (isPlain(a) && (isP(toks[k + 2], ',') || isP(toks[k + 2], ')'))) {
      if (STATIC_NAME.test(a.v)) use(a.v, a.pos);
      return;
    }
    dyn.push(a.pos);
  };
  const dot = (k) => {
    if (!isP(toks[k], '.')) return;
    const a = toks[k + 1];
    if (a && a.t === 'name' && STATIC_NAME.test(a.v)) use(a.v, a.pos);
  };

  const destructure = (i) => {
    // toks[i..i+2] are process . env
    if (!isP(toks[i - 1], '=') || !isP(toks[i - 2], '}')) return;
    const after = toks[i + 3];
    if (isP(after, '.') || isP(after, '[')) return;
    const c = i - 2;
    let depth = 0;
    let o = -1;
    for (let j = c; j >= 0; j--) {
      const t = toks[j];
      if (t.t !== 'p') continue;
      if (t.v === '}' || t.v === ']' || t.v === ')') depth++;
      else if (t.v === '{' || t.v === '[' || t.v === '(') {
        depth--;
        if (depth === 0) {
          o = j;
          break;
        }
      }
    }
    if (o === -1 || !isP(toks[o], '{')) return;
    let d = 0;
    for (let j = o + 1; j < c; j++) {
      const t = toks[j];
      const prev = toks[j - 1];
      if (d === 0 && (j - 1 === o || isP(prev, ','))) {
        const nx = toks[j + 1];
        const keyOk =
          (t.t === 'name' && STATIC_NAME.test(t.v)) || (isPlain(t) && STATIC_NAME.test(t.v));
        if (keyOk && (isP(nx, ',') || isP(nx, '}') || isP(nx, ':') || isP(nx, '='))) use(t.v, t.pos);
      }
      if (t.t === 'p') {
        if (t.v === '{' || t.v === '[' || t.v === '(') d++;
        else if (t.v === '}' || t.v === ']' || t.v === ')') d--;
      }
    }
  };

  const first = new Set();
  for (const kind of ['subscript', 'call', 'dot']) for (const p of pf[kind]) first.add(p[0]);

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'name' || !first.has(t.v)) continue;
    for (const p of pf.subscript) if (matchPrefix(toks, i, p)) subscript(i + p.length);
    for (const p of pf.call) {
      if (!matchPrefix(toks, i, p)) continue;
      if (lang === 'php') {
        const prev = toks[i - 1];
        if (isP(prev, '>') || isP(prev, ':') || isN(prev, 'function')) continue;
      }
      call(i + p.length);
    }
    for (const p of pf.dot) if (matchPrefix(toks, i, p)) dot(i + p.length);
    if (lang === 'js' && matchPrefix(toks, i, ['process', '.', 'env'])) destructure(i);
  }
  return { uses, dyn };
}

const SHELL_NEVER = new Set(
  'HOME PATH PWD OLDPWD USER SHELL IFS TERM TMPDIR HOSTNAME LANG UID EUID PPID RANDOM LINENO SECONDS BASH_SOURCE OPTIND OPTARG REPLY'.split(' '),
);

function scanShell(text) {
  const n = text.length;
  const cands = [];
  const assigned = new Set();
  let inDq = false;
  const assignRe = /(?:(?:export|readonly|local)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)\+?=/y;
  const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (!inDq) {
      if (i === 0 || ' \t\n;&|('.includes(text[i - 1])) {
        assignRe.lastIndex = i;
        const m = assignRe.exec(text);
        if (m) assigned.add(m[1]);
      }
      if (c === '#' && (i === 0 || ' \t\n'.includes(text[i - 1]))) {
        const e = text.indexOf('\n', i);
        i = e === -1 ? n : e;
        continue;
      }
      if (c === "'") {
        const e = text.indexOf("'", i + 1);
        i = e === -1 ? n : e + 1;
        continue;
      }
      if (c === '"') {
        inDq = true;
        i++;
        continue;
      }
    } else if (c === '"') {
      inDq = false;
      i++;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      if (text[j] === '{') j++;
      const s = j;
      while (j < n && isNameChar(text[j])) j++;
      if (j > s) {
        const name = text.slice(s, j);
        if (/^[A-Z][A-Z0-9_]*$/.test(name) && !SHELL_NEVER.has(name)) cands.push({ name, pos: i });
        i = j;
        continue;
      }
    }
    i++;
  }
  return { uses: cands.filter((u) => !assigned.has(u.name)), dyn: [] };
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function locate(text, starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  let cols = 0;
  for (const _ of text.slice(starts[lo], pos)) cols++;
  return { line: lo + 1, column: cols + 1 };
}

function scanCode(dirAbs) {
  const files = listCodeFiles(dirAbs);
  const used = new Map(); // name -> { file, line, column, uses }
  const dynamic = [];
  let read = 0;
  let totalUses = 0;
  for (const f of files) {
    let text;
    try {
      text = readText(f.abs);
    } catch {
      continue;
    }
    read++;
    const found = f.lang === 'sh' ? scanShell(text) : findUses(tokenize(text, f.lang), f.lang);
    const starts = lineStartsOf(text);
    const uses = found.uses.slice().sort((a, b) => a.pos - b.pos);
    totalUses += uses.length;
    for (const u of uses) {
      const e = used.get(u.name);
      if (e) e.uses++;
      else {
        const loc = locate(text, starts, u.pos);
        used.set(u.name, { file: f.rel, line: loc.line, column: loc.column, uses: 1 });
      }
    }
    for (const pos of found.dyn) {
      const loc = locate(text, starts, pos);
      dynamic.push({ file: f.rel, line: loc.line, column: loc.column });
    }
  }
  return { used, dynamic, files: read, uses: totalUses };
}

// ---------------------------------------------------------------- report

function buildReport(opts, dirAbs) {
  const failOn = parseFailOn(opts.failOn);
  const ignored = parseIgnores(opts.ignore);
  if (opts.json && opts.github) throw new UsageError('--json and --github cannot be used together');

  const template = chooseTemplate(dirAbs, opts.example);
  const envSel = chooseEnv(dirAbs, opts.env, template);

  let tParsed;
  let eParsed = null;
  try {
    tParsed = parseDotenv(readText(template.abs));
    if (envSel) eParsed = parseDotenv(readText(envSel.abs));
  } catch (e) {
    throw new UsageError(`cannot read a .env file (${e.code || 'error'})`);
  }
  const tBy = summarize(tParsed.assignments);
  const eBy = eParsed ? summarize(eParsed.assignments) : null;
  const code = scanCode(dirAbs);

  const tRefs = new Set();
  for (const a of tParsed.assignments) for (const r of a.refs) tRefs.add(r);

  const undocumented = [];
  for (const [name, u] of code.used) {
    if (!tBy.has(name)) undocumented.push({ name, file: u.file, line: u.line, column: u.column, uses: u.uses });
  }
  undocumented.sort((a, b) => cmp(a.name, b.name));

  const stale = [];
  if (code.files > 0) {
    for (const [name, e] of tBy) if (!code.used.has(name) && !tRefs.has(name)) stale.push({ name, line: e.line });
  }
  stale.sort((a, b) => cmp(a.name, b.name));

  const missing = [];
  const unexpected = [];
  if (eBy) {
    for (const [name, e] of tBy) {
      const x = eBy.get(name);
      if (!x) missing.push({ name, line: e.line, reason: 'absent' });
      else if (x.last.empty) missing.push({ name, line: e.line, reason: 'empty' });
    }
    for (const [name, e] of eBy) if (!tBy.has(name)) unexpected.push({ name, line: e.line });
  }
  missing.sort((a, b) => cmp(a.name, b.name));
  unexpected.sort((a, b) => cmp(a.name, b.name));

  const duplicates = [];
  const malformed = [];
  const expansions = [];
  const sides = [[template.file, tParsed, tBy]];
  if (envSel) sides.push([envSel.file, eParsed, eBy]);
  for (const [file, parsed, by] of sides) {
    for (const [name, e] of by) if (e.lines.length > 1) duplicates.push({ name, file, lines: e.lines.slice() });
    for (const m of parsed.malformed) malformed.push({ file, line: m.line, reason: m.reason });
    for (const a of parsed.assignments) {
      if (a.refs.length) expansions.push({ name: a.name, file, line: a.line, refs: a.refs });
    }
  }
  duplicates.sort((a, b) => cmp(a.file, b.file) || a.lines[0] - b.lines[0]);
  malformed.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
  expansions.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);

  const secrets = [];
  for (const a of tParsed.assignments) {
    const pattern = secretPattern(a.value);
    if (pattern) secrets.push({ name: a.name, line: a.line, pattern });
  }
  secrets.sort((a, b) => a.line - b.line);

  const dynamic = code.dynamic
    .slice()
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || a.column - b.column);

  const keep = (x) => !ignored(x.name);
  const lists = {
    undocumented: undocumented.filter(keep),
    stale: stale.filter(keep),
    missing: missing.filter(keep),
    unexpected: unexpected.filter(keep),
    duplicates: duplicates.filter(keep),
    malformed,
    secrets: secrets.filter(keep),
    dynamic,
    expansions: expansions.filter(keep),
  };
  const counts = {};
  for (const l of LISTS) counts[l] = lists[l].length;
  const ok = !failOn.some((k) => lists[k].length > 0);

  return {
    tool: TOOL,
    version: VERSION,
    example: template.file,
    env: envSel ? envSel.file : null,
    failOn,
    ok,
    sources: { files: code.files, uses: code.uses },
    ...lists,
    counts,
  };
}

// ---------------------------------------------------------------- output

function plain(r) {
  const out = [];
  out.push(`${TOOL} ${VERSION}: example ${r.example}, env ${r.env === null ? '(none)' : r.env}, ${r.sources.files} source files`);
  const fmt = {
    undocumented: (x) => `${x.name}  ${x.file}:${x.line}:${x.column}  uses: ${x.uses}`,
    stale: (x) => `${x.name}  ${r.example}:${x.line}`,
    missing: (x) => `${x.name}  ${x.reason}`,
    unexpected: (x) => `${x.name}  ${r.env}:${x.line}`,
    duplicates: (x) => `${x.name}  ${x.file}  lines: ${x.lines.join(', ')}`,
    malformed: (x) => `${x.file}:${x.line}  ${x.reason}`,
    secrets: (x) => `${x.name}  ${r.example}:${x.line}  ${x.pattern}`,
    dynamic: (x) => `${x.file}:${x.line}:${x.column}`,
    expansions: (x) => `${x.name}  ${x.file}:${x.line}  refs: ${x.refs.join(', ')}`,
  };
  for (const l of LISTS) {
    if (!r[l].length) continue;
    out.push(`${l} (${r[l].length})`);
    for (const x of r[l]) out.push('    ' + fmt[l](x));
  }
  out.push('counts: ' + LISTS.map((l) => `${l}=${r.counts[l]}`).join(' '));
  return out.join('\n') + '\n';
}

const escMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escFile = (s) => escMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function github(r) {
  const out = [];
  const level = (k) => (r.failOn.includes(k) ? 'error' : 'warning');
  const add = (kind, file, line, col, msg) => {
    const where = `file=${escFile(file)},line=${line}` + (col === undefined ? '' : `,col=${col}`);
    out.push(`::${level(kind)} ${where}::${kind}: ${escMsg(msg)}`);
  };
  for (const x of r.undocumented) {
    add('undocumented', x.file, x.line, x.column, `${x.name} is used in code (${x.uses} ${x.uses === 1 ? "use" : "uses"}) but is not in the template`);
  }
  for (const x of r.stale) add('stale', r.example, x.line, undefined, `${x.name} is in the template but no code uses it`);
  for (const x of r.missing) {
    add('missing', r.example, x.line, undefined, `${x.name} is ${x.reason === 'absent' ? 'absent from' : 'empty in'} the checked file`);
  }
  for (const x of r.unexpected) add('unexpected', r.env, x.line, undefined, `${x.name} is in the checked file but not in the template`);
  for (const x of r.duplicates) {
    add('duplicates', x.file, x.lines[0], undefined, `${x.name} is assigned more than once (lines ${x.lines.join(', ')})`);
  }
  for (const x of r.malformed) add('malformed', x.file, x.line, undefined, `this line is malformed: ${x.reason}`);
  for (const x of r.secrets) add('secrets', r.example, x.line, undefined, `${x.name} holds a value that looks like a secret (${x.pattern})`);
  return out.length ? out.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------- main

function main(argv) {
  let opts;
  let report;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    const dirAbs = path.resolve(opts.dir === null ? '.' : opts.dir);
    if (!isFolder(dirAbs)) throw new UsageError(`dir is not an existing folder: ${opts.dir === null ? '.' : opts.dir}`);
    report = buildReport(opts, dirAbs);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${TOOL}: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`${TOOL}: unexpected error (${e && e.code ? e.code : 'internal'})\n`);
    return 2;
  }
  const text = opts.json ? JSON.stringify(report, null, 2) + '\n' : opts.github ? github(report) : plain(report);
  if (text) process.stdout.write(text);
  return report.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
