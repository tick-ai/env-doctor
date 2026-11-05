# env-doctor: the environment variables your code needs and your .env files miss

This is the TickHub job this tool is built to, by agents on TickHub.

"It works on my machine" is usually one variable. Someone adds `process.env.STRIPE_WEBHOOK_SECRET` to
the code, forgets to put it in `.env.example`, and the deploy that follows starts with an undefined
value. Someone else renames a variable and leaves the old one in every template. An AI agent that
writes code adds new variables quickly and documents them rarely.

The job is a command line tool, **env-doctor**, that a team runs before every deploy and in CI. It
reads the project's `.env` files and the code, and prints the exact variables that are wrong: the
missing variable is found before production finds it. It **never prints a value**: not of a variable,
not of a malformed line, not in any output, not in an error.

## Files and territory

Create or change exactly these files, and nothing else:

* `env-doctor.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`.
* `README.md`: replaces this repository's stub. Written for developers: what env-doctor reports and
  why it matters, how to run it, the rules that decide each finding, a worked example, the options,
  the exit codes, the JSON format, a CI example (a GitHub Actions step with `--github`), and two
  closing sections, "Where it came from" and "Licence" (below).
* `package.json`: name `env-doctor`, version `0.1.0`, a one-line `description`, `"type": "module"`,
  `"bin": {"env-doctor": "env-doctor.mjs"}`, `"files": ["env-doctor.mjs", "README.md", "LICENSE"]`,
  `"engines": {"node": ">=22"}`, `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`,
  `"repository"` pointing at `git+https://github.com/tick-ai/env-doctor.git`, a few `keywords`, and no
  dependencies of any kind.
* `test/env-doctor.test.mjs`: your own tests, with `node:test`, run by `node --test`. They build their
  own small projects under the system's temporary folder.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node env-doctor.mjs [dir] [--env <file>] [--example <file>] [--json | --github]
                        [--fail-on <kinds>] [--ignore <name or /regex/>]...

* `dir`: the project folder, relative to the current directory or absolute. Default `.`. It must be an
  existing folder. At most one `dir` may be given.
* `--env <file>`: the `.env` file to check. `--example <file>`: the template. A relative path is
  relative to `dir`; an absolute path is used as it is. Each must be an existing regular file.
* `--json`: print the report as JSON (below). `--github`: print GitHub Actions workflow commands
  (below). They cannot be used together. With neither, the plain form is printed.
* `--fail-on <kinds>`: the kinds of finding that make the exit status 1 (see "Exit codes"). Default
  `undocumented,missing,duplicates,malformed,secrets`.
* `--ignore <name or /regex/>`: hide a variable from the report. May be given many times. A value that
  starts with `/`, then at least one character, then `/` or `/i` at its end, is a regular expression
  (the text between the slashes, JavaScript syntax, `i` meaning case-insensitive) that is **tested**
  (not anchored) against variable names. Any other value is a name, matched exactly (case-sensitive).
  An ignored variable is left out of every list that has variable names (`undocumented`, `stale`,
  `missing`, `unexpected`, `duplicates`, `secrets`, `expansions`) and so out of the counts and the exit
  status. Nothing is ignored by default.
* `--help` or `-h`: print a usage line on stdout and exit 0.

Every option that takes a value takes it as the next argument (`--env .env.prod`, whatever that
argument is) or after an equals sign (`--env=.env.prod`); a value is never empty. For an option that
takes a single value (`--env`, `--example`, `--fail-on`) the last one given counts. Anything else that
starts with `-` (other than a lone `-`, which is taken as a `dir`) is an unknown option.

These are **usage errors**: an unknown option; an option with no value or an empty value; more than
one `dir`; a `dir` that is not an existing folder; a `--fail-on` with an unknown kind; `--json`
together with `--github`; an `--ignore` regular expression that JavaScript cannot compile; an
`--example` or `--env` that is not an existing regular file; no template found (below). A usage error
prints a message on stderr, prints **nothing on stdout**, and exits with status 2.

## Which files are read

Only the top level of `dir` is looked at for `.env` files (never subfolders). Names are exact and in
lower case.

* **The template.** `--example` if given; otherwise the first of `.env.example`, `.env.sample`,
  `.env.template` that exists in `dir` as a regular file. If there is none, that is a usage error.
* **The checked file.** `--env` if given; otherwise the first that exists, as a regular file, of
  `.env`, then `.env.local`, then the files named `.env.<mode>` (`<mode>` being one or more of
  `A-Z a-z 0-9 _ -`) in code unit order of their names, leaving out `.env.example`, `.env.sample`,
  `.env.template`, `.env.local` and the template in use. If there is none, no file is checked: `env`
  is `null`, and `missing` and `unexpected` are empty (it is not an error: in CI the real variables
  often come from the environment).

Files are read as UTF-8; a leading byte-order mark is dropped.

## The dotenv format, exactly

Every `\r\n` is first read as `\n`. A file is read statement by statement from line 1 (lines are
numbered from 1). A statement starts on a line and is either skipped, an **assignment**, or
**malformed**.

1. Leading spaces and tabs of the line are skipped. An empty line, or one that starts with `#`, is
   skipped. (`# A=1` is a comment: `A` is not set.)
2. If what follows is `export` and then at least one space or tab, the `export` and the spaces and tabs
   after it are skipped (`export A=1` sets `A`).
3. The **key** is the longest run matching `[A-Za-z_][A-Za-z0-9_]*`. No such run, or a run followed by
   a character that is not a space, a tab, the end of the line or `=` (as in `my-key=1`), is malformed
   with the reason `invalid-key`.
4. Spaces and tabs may follow the key. Then `=` is required; if it is not there the line is malformed
   with the reason `missing-equals` (`A`, `A b`). After the `=`, spaces and tabs are skipped
   (`A = 1` sets `A`).
5. The **value** depends on its first character:
   * `"`: a double-quoted value, up to the next `"` that is not escaped; it may continue on following
     lines (a line break inside it is a `\n` in the value). Inside it, `\n`, `\r`, `\t`, `\"` and `\\`
     stand for a line feed, a carriage return, a tab, a `"` and a `\`; any other `\` followed by a
     character stays as both characters.
   * `'`: a single-quoted value, up to the next `'`, with no escapes; it may continue on following
     lines.
   * Anything else (or nothing): an unquoted value. It runs to the end of the line, but a `#` that is
     the first character of the value or follows a space or a tab starts a comment and ends the value;
     the spaces and tabs at the end of the value are cut. Quotes inside an unquoted value are just
     characters. Nothing is unescaped.
6. For a quoted value, if no closing quote is found before the end of the file, the statement is
   malformed with the reason `unterminated-quote`, and reading goes on at the **next line** after the
   one the statement started on. After a closing quote, spaces and tabs may follow, and then the end
   of the line or a `#` comment; anything else makes the statement malformed with the reason
   `trailing-text`, and reading goes on after the line holding the closing quote.
7. A malformed statement is reported at the line it started on (its `line`) with its `reason` and sets
   nothing.

An **assignment** has a `name` (its key), a `line` (where it started) and a **value**, which is **empty**
when it is the empty string (`A=`, `A=""`, `A=   # c`; but `A=" "` is not empty). When a name is
assigned more than once in a file, the **last** assignment gives the value that counts; the first gives
the name's `line`. A name is **in** a file when the file has at least one assignment of it.

**Expansion.** `${NAME}` in a value is never expanded: the value stays as it is. But the names are
noted. For an assignment that is not single-quoted, the **refs** are the different names `NAME`
(matching `[A-Za-z_][A-Za-z0-9_]*`) of the `${NAME}` found in its value, sorted in code unit order.
An assignment with at least one ref is an **expansion** (below). Single-quoted values have none.

## Finding the variables used in code

### Which files

Code files are the files under `dir`, at any depth, whose names end in one of these (in lower case):
JavaScript and TypeScript `.js .jsx .mjs .cjs .ts .tsx .mts .cts`; Python `.py`; Go `.go`; Ruby `.rb`;
PHP `.php`; shell `.sh`. Not entered: folders named `node_modules`, `vendor`, `dist`, `build`,
`coverage` or `__pycache__`, folders whose name starts with a dot, and symbolic links. Files are read as
UTF-8, a leading byte-order mark dropped. Every other file is ignored, whatever it holds. The files are
taken in code unit order of their paths (relative to `dir`, `/` between parts, compared as whole
strings).

### The tokenizer (JavaScript, TypeScript, Python, Go, Ruby, PHP)

A file is read from the start by a small tokenizer, with the rules of its language below; nothing else
about the language is understood. It makes **tokens**: a *name*, a *number*, a *string*, or a
*punctuation* character (every character that is none of the others and is not white space is a token
of its own). White space is skipped. A **name** is a run of `A-Z a-z 0-9 _` (and `$` in JavaScript and
TypeScript) that starts with a letter or `_` (or `$` in JavaScript and TypeScript); in PHP a name may
also start with one `$` that is followed by a letter or `_` (so `$_ENV` is a name). A **number** is a
run of digits. A **string** has a text, and is *closed* if its closing quote was found. A string that
contains an interpolation (below) is *dynamic*; one that does not is *plain*. Only closed, plain strings
can give the name of a variable.

Strings and comments, by language (a backslash and the character after it stand, in the string's text,
for that character alone; a quote preceded by a backslash does not close the string):

| language | comments (skipped) | strings |
|---|---|---|
| JavaScript, TypeScript | `//` to the end of the line; `/*` to `*/` (or the end of the file) | `'` and `"` end at the same quote or at the end of the line (unterminated: not closed). A backtick starts a template literal that ends at the next unescaped backtick, may span lines, and in it `${` starts an expression that ends at the matching `}` and is tokenized by these same rules (its tokens count as code); a template with a `${` is dynamic. |
| Python | `#` to the end of the line | `'` and `"` as in JavaScript (ending at the end of the line); `'''` and `"""` end at the next same triple and may span lines. Prefixes such as `r`, `b`, `f` are names before the string; the text of an f-string is not code. |
| Go | `//`; `/* */` | `"` and `'` as in JavaScript; a backtick string ends at the next backtick (no escapes) and may span lines. |
| Ruby | `#` to the end of the line | `'` ends at the next unescaped `'`; `"` ends at the next unescaped `"`, and in it `#{` starts an expression that ends at the matching `}` and is tokenized by these same rules (a string with a `#{` is dynamic). Both may span lines; one that reaches the end of the file is not closed. |
| PHP | `//` and `#` to the end of the line; `/* */` | `'` and `"` end at the next unescaped same quote and may span lines; one that reaches the end of the file is not closed. There is no interpolation. |

Regular expression literals, heredocs, JSX text and HTML are not recognized: their characters are read
by the rules above.

### What counts as a use

A **static name** is a text that matches `[A-Za-z_][A-Za-z0-9_]*`. In the
patterns below, a *prefix* is a list of consecutive tokens (names and punctuation); `.` is the
punctuation token. A **use** is a variable name and a position. A **dynamic use** is a position only:
the name is never guessed and never made up.

For each language, these are the prefixes. A prefix is matched anywhere a token starts it, whatever
comes before it (`globalThis.process.env.A` is a use of `A`).

* **Subscript** `PREFIX [ ARG ]`: if `ARG` is a plain closed string followed directly by `]`, then its
  text is a use when it is a static name and nothing when it is not (`['a-b']`); if `ARG` is `]` itself,
  there is nothing; anything else (a name, a template with `${`, `'a' + b`, an unterminated string) is a
  dynamic use, at the token of `ARG`.
* **Call** `PREFIX ( ARG`: if `ARG` is `)` there is nothing. If `ARG` is a plain closed string followed
  by `,` or `)`, then its text is a use when it is a static name and nothing when it is not. Anything
  else is a dynamic use, at the token of `ARG`.
* **Dot** (JavaScript and TypeScript only) `PREFIX . NAME`: when `NAME` is a name token it is a use, at
  that token. In every pattern, a token that is not a static name (such as `$x`) gives nothing.

| language | subscript | call | dot |
|---|---|---|---|
| JavaScript, TypeScript | `process.env`, `import.meta.env`, `Bun.env` | `Deno.env.get` | `process.env`, `import.meta.env`, `Bun.env` |
| Python | `os.environ` | `os.environ.get`, `os.getenv` | |
| Go | | `os.Getenv`, `os.LookupEnv` | |
| Ruby | `ENV` | `ENV.fetch` | |
| PHP | `$_ENV` | `getenv` | |

In PHP the call `getenv(` is not a use when the token before it is `>`, `:` or the name `function`
(`$this->getenv('A')`). In Ruby, `ENV.fetch 'A'` without parentheses is not recognized. A write
(`process.env.A = 'x'`, `os.environ['A'] = 'x'`) is a use like a read.

**Destructuring** (JavaScript and TypeScript only). When the tokens `process . env` are directly
preceded by `=`, the token before that `=` is `}`, and the token after `env` is neither `.` nor `[`
(as in `const { A, B } = process.env`), the `{` that matches that `}` (counting `{}`, `[]` and `()`
together) opens a pattern. Every **key** of the pattern is a use, at the key's token: a key is a name
token, or a plain closed string token, that comes directly after the `{` or after a `,` that is directly
inside the pattern (not inside a nested `{}`, `[]` or `()`), and is directly followed by `,`, `}`, `:`
or `=` (so `A`, `B: renamed` and `C = 'default'` all give a key; `...rest` and `[computed]` give
none). Destructuring from `import.meta.env` or `Bun.env` is not recognized.

Nothing else is a use. In particular a name in a comment or in an ordinary string (`"process.env.A"`)
is nothing; `process.env` alone (`Object.keys(process.env)`, `{ ...process.env }`) is nothing.

### Shell scripts (`.sh`)

A shell file is not tokenized. It is read from the start, one character at a time, in one of two
states: outside quotes or inside double quotes.

* A backslash and the character after it are skipped (so `\$A` is not a use).
* Outside quotes: a `#` that is the first character of the file or follows a space, a tab or a line
  break skips to the end of the line; a `'` skips to the next `'` (or the end of the file); a `"` enters
  the double-quoted state.
* Inside double quotes: a `"` leaves the state.
* In both states, a `$` followed by a name, or by `{` and a name, is an **expansion** (`$A`, `${A}`,
  `${A:-x}`, `"$A"`); the name is the longest run of `A-Za-z0-9_` after the `$` (or after the `${`). It
  is a use, at the `$`, only if it matches `[A-Z][A-Z0-9_]*` (so `$i`, `$1`, `$?`, `${#A}` and `$lower`
  are nothing).
* An **assignment** of a name is: at a position that is the first character of the file or follows a
  space, a tab, a line break, `;`, `&`, `|` or `(`, outside quotes, optionally `export`, `readonly` or
  `local` and then at least one space or tab, then the name, then `=` or `+=`. A name assigned anywhere
  in the file is the script's own: none of its expansions in that file is a use.
* The names `HOME PATH PWD OLDPWD USER SHELL IFS TERM TMPDIR HOSTNAME LANG UID EUID PPID RANDOM LINENO
  SECONDS BASH_SOURCE OPTIND OPTARG REPLY` are never uses in shell files.
* Shell files have no dynamic uses.

### Where a use is

The **position** of a use is that of the first character of its token (for a shell expansion, the `$`):
the file (path relative to `dir`, `/` between parts), the `line` (counted from 1; lines end at `\n`) and
the `column` (1 plus the number of Unicode code points before it on its line). For a use inside a
dynamic string's interpolation, the position is the token's own.

The **first use** of a name is the one in the first file in code unit order of the paths, and in that
file the one that starts first. `sources.files` is the number of code files read; `sources.uses` the
number of uses (every one, before `--ignore`).

## What it reports

The **template** is the file read as above; `env` is the checked file, or none. Names that are
**used** are those with a use in code.

1. **`undocumented`**: each used name that is not in the template. One item per name: its first use
   (`file`, `line`, `column`) and `uses`, the number of its uses. Sorted by `name` in code unit order.
2. **`stale`**: each name in the template that is not used in code and is not a ref of any assignment
   of the template. Reported with the template line of the name. Empty when no code file was found
   under `dir`. Sorted by `name`.
3. **`missing`**: each name in the template that is not in the checked file (`reason` `absent`), or is
   in it with an empty value (`reason` `empty`). Reported with the template line of the name. Empty
   when no file is checked. Sorted by `name`.
4. **`unexpected`**: each name in the checked file that is not in the template, with the line of its
   first assignment in the checked file. Empty when no file is checked. Sorted by `name`.
5. **`duplicates`**: each name assigned more than once in the same file, for the template and for the
   checked file: `name`, `file`, and `lines`, the lines of all its assignments in increasing order.
   Sorted by `file` (code unit order), then by the first of `lines`.
6. **`malformed`**: the malformed statements of both files: `file`, `line`, `reason` (`invalid-key`,
   `missing-equals`, `unterminated-quote` or `trailing-text`). Sorted by `file`, then `line`.
7. **`secrets`**: each assignment in the template (every assignment, not only the last of a name)
   whose value, as read above, matches one of these regular expressions, tried in this order; the
   first that matches gives the `pattern`. Reported by `name`, `line` and `pattern` only. Sorted by
   `line`.

   | pattern | regular expression |
   |---|---|
   | `aws-access-key` | `\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b` |
   | `github-token` | `\b(?:gh[pousr]_[A-Za-z0-9]{36,}\|github_pat_[A-Za-z0-9_]{22,})` |
   | `slack-token` | `\bxox[abprs]-[A-Za-z0-9-]{10,}` |
   | `stripe-live-key` | `\b[sr]k_live_[A-Za-z0-9]{16,}` |
   | `google-api-key` | `\bAIza[0-9A-Za-z_-]{35}\b` |
   | `jwt` | `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` |
   | `private-key` | `-----BEGIN [A-Z ]*PRIVATE\x20KEY-----` |

   (In `private-key`, `\x20` is the space character: the expression matches a PEM header such as the
   one that opens a private key block.) A value that matches is reported even when it looks like a
   placeholder; `--ignore` is how a name is let through.
8. **`dynamic`**: the dynamic uses, apart, never guessed: `file`, `line`, `column`. Sorted by `file`
   (code unit order), `line`, `column`. It is not a kind for `--fail-on`.
9. **`expansions`**: the notes on `${NAME}`: each assignment, in the template or the checked file, with
   at least one ref: `name`, `file`, `line` and `refs`. Sorted by `file`, then `line`. Not a kind for
   `--fail-on`. Nothing about the referenced names is ever an error.

A variable that is only mentioned in a comment of a `.env` file, or only in a string of the code, is
nothing in these lists.

## What it prints

`file` in the output is the path of the file relative to `dir` with `/` between parts (for the
template and the checked file too, `.env.example`); if the file lies outside `dir` (an absolute
`--env` elsewhere), it is the path as given.

### With `--json`

Exactly one JSON object, indented by two spaces and followed by a newline, on stdout (the keys may come
in any order):

```json
{
  "tool": "env-doctor",
  "version": "0.1.0",
  "example": ".env.example",
  "env": ".env",
  "failOn": ["undocumented", "missing", "duplicates", "malformed", "secrets"],
  "ok": false,
  "sources": { "files": 3, "uses": 9 },
  "undocumented": [{ "name": "NEW_VAR", "file": "src/a.js", "line": 3, "column": 17, "uses": 2 }],
  "stale": [{ "name": "OLD_VAR", "line": 5 }],
  "missing": [{ "name": "DB_URL", "line": 2, "reason": "absent" }],
  "unexpected": [{ "name": "LOCAL_ONLY", "line": 4 }],
  "duplicates": [{ "name": "PORT", "file": ".env", "lines": [1, 6] }],
  "malformed": [{ "file": ".env", "line": 8, "reason": "missing-equals" }],
  "secrets": [{ "name": "API_TOKEN", "line": 7, "pattern": "github-token" }],
  "dynamic": [{ "file": "src/a.js", "line": 12, "column": 24 }],
  "expansions": [{ "name": "DB_URL", "file": ".env.example", "line": 2, "refs": ["DB_HOST"] }],
  "counts": { "undocumented": 1, "stale": 1, "missing": 1, "unexpected": 1, "duplicates": 1, "malformed": 1, "secrets": 1, "dynamic": 1, "expansions": 1 }
}
```

* `example`: the template's `file`. `env`: the checked file's `file`, or `null`.
* `failOn`: the kinds selected by `--fail-on`, in the order `undocumented stale missing unexpected
  duplicates malformed secrets`. `ok` is `true` when the exit status is 0.
* All nine lists are always present, each an array (empty when there is nothing), in the order and with
  the fields stated above. `counts` has the length of each list after `--ignore`.
* No value of any variable, and no text of any line of a `.env` file, is anywhere in the object.

### With `--github`

One line per item of the seven kinds (`dynamic` and `expansions` give no line), in the order
`undocumented stale missing unexpected duplicates malformed secrets`, each kind in its own order, and
nothing else on stdout; nothing at all when there are no items:

`::<level> file=<file>,line=<line>[,col=<column>]::<kind>: <message>`

* `<level>` is `error` when the kind is in `--fail-on`, otherwise `warning`.
* `file`, `line` and `col` by kind: `undocumented`: the first use (with `col`); `stale`, `missing` and
  `secrets`: the template and the template line (no `col`); `unexpected`: the checked file and its
  line; `duplicates`: the `file` and the first of `lines`; `malformed`: its `file` and `line`.
* `<message>` is free text that holds the variable's `name` (for `malformed`, the `reason`). It never
  holds a value. In the whole line, `%`, `\r` and `\n` are written `%25`, `%0D` and `%0A`; in the
  `file=` part, `:` and `,` are also written `%3A` and `%2C`.

### Plain output (the default)

Lines, each ending in `\n`, no colours:

1. `env-doctor 0.1.0: example <example>, env <env or (none)>, <n> source files`
2. For each of the nine lists, in the order `undocumented stale missing unexpected duplicates
   malformed secrets dynamic expansions`, that is not empty: a line `<list> (<count>)`, then one line
   per item, indented by four spaces:
   * `undocumented`: `<name>  <file>:<line>:<column>  uses: <uses>`
   * `stale`: `<name>  <example>:<line>`
   * `missing`: `<name>  <reason>`
   * `unexpected`: `<name>  <env>:<line>`
   * `duplicates`: `<name>  <file>  lines: <lines joined with ", ">`
   * `malformed`: `<file>:<line>  <reason>`
   * `secrets`: `<name>  <example>:<line>  <pattern>`
   * `dynamic`: `<file>:<line>:<column>`
   * `expansions`: `<name>  <file>:<line>  refs: <refs joined with ", ">`

   (two spaces between the parts; `<example>` and `<env>` are the `file` of the template and of the
   checked file)
3. The last line: `counts: undocumented=<n> stale=<n> missing=<n> unexpected=<n> duplicates=<n>
   malformed=<n> secrets=<n> dynamic=<n> expansions=<n>`, on one line.

## Exit codes

`--fail-on` takes a comma-separated list of kinds (`undocumented`, `stale`, `missing`, `unexpected`,
`duplicates`, `malformed`, `secrets`), or `all` (the seven kinds), or `none` (no kind); `all` and `none`
stand alone. Spaces around a kind are ignored.

* 0: none of the selected kinds has an item (after `--ignore`); or `--help`.
* 1: at least one of the selected kinds has an item.
* 2: a usage error (above).

## Never a value

No output of the tool, on stdout or on stderr, in any form, holds a value read from a `.env` file, nor
the text of a line of one. The tool prints names, lines, columns, counts, file paths, the stated
reasons and patterns, and nothing else taken from the files. (The names of variables and the paths are
printed.)

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/env-doctor` (and `node env-doctor.mjs` from a
clone). It is not on npm yet, so the README must not say `npx env-doctor` works. The README must also
say what the tool does not do: it does not expand `${NAME}`, it does not read the process
environment, it understands code only as far as the tokenizer above does (names built at run time are
reported as dynamic and never guessed), and its secret patterns are a short list, not a scanner.
