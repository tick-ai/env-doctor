# env-doctor

env-doctor reads your code and your `.env` files and prints the exact environment variables that are wrong: used in code but missing from `.env.example`, listed in the template but never used, absent or empty in your `.env`, assigned twice, malformed, or holding a real-looking secret. It never prints a value.

```sh
npx github:tick-ai/env-doctor
```

For a project where someone added `process.env.STRIPE_WEBHOOK_SECRET` and forgot the template, it prints (this is real output):

```text
env-doctor 0.1.0: example .env.example, env .env, 1 source files
undocumented (1)
    STRIPE_WEBHOOK_SECRET  src/server.js:3:26  uses: 1
stale (1)
    OLD_FLAG  .env.example:4
missing (2)
    OLD_FLAG  absent
    STRIPE_KEY  absent
unexpected (1)
    DEBUG_SQL  .env:3
counts: undocumented=1 stale=1 missing=2 unexpected=1 duplicates=0 malformed=0 secrets=0 dynamic=0 expansions=0
```

The exit status is 1 here (an undocumented variable and two missing ones), so a deploy or a pull request stops before production finds the missing variable.

Plain Node 22, one file, nothing to install, no network.

## What it reports and why it matters

"It works on my machine" is usually one variable: the code reads `STRIPE_WEBHOOK_SECRET`, nobody put it in `.env.example`, and the deploy starts with an undefined value. env-doctor compares three things: the **template** (`.env.example`), the **checked file** (`.env`), and the **code**, and lists nine things:

| list | what it is |
|---|---|
| `undocumented` | used in code, not in the template |
| `stale` | in the template, not used in code (and not referenced by `${NAME}` in the template) |
| `missing` | in the template, but absent from the checked file, or present with an empty value |
| `unexpected` | in the checked file, not in the template |
| `duplicates` | assigned more than once in the same file |
| `malformed` | a line that is not a valid assignment |
| `secrets` | a template value that looks like a real secret |
| `dynamic` | a use whose name is built at run time (`process.env[key]`): reported, never guessed |
| `expansions` | an assignment that contains `${NAME}` (a note, never an error) |

Every item has the name, the file and the line (and the column for code), and nothing else. No value of a variable, and no text of a `.env` line, is ever printed: not in the plain output, not in JSON, not in GitHub annotations, not in an error.

## Run it

```sh
npx github:tick-ai/env-doctor            # in the project folder
npx github:tick-ai/env-doctor path/to/project
node env-doctor.mjs                      # from a clone of this repository
```

It is not on npm yet, so `npx env-doctor` does not work; use the `github:` form above or run the file with `node`.

```text
node env-doctor.mjs [dir] [--env <file>] [--example <file>] [--json | --github]
                    [--fail-on <kinds>] [--ignore <name or /regex/>]...
```

## Options

* `dir`: the project folder (default `.`). It must exist. At most one.
* `--env <file>`: the `.env` file to check. `--example <file>`: the template. A relative path is relative to `dir`, an absolute path is used as it is. Each must be an existing regular file.
* `--json`: print the report as JSON. `--github`: print GitHub Actions workflow commands. They cannot be used together. With neither, the plain form is printed.
* `--fail-on <kinds>`: the kinds that make the exit status 1. A comma-separated list of `undocumented`, `stale`, `missing`, `unexpected`, `duplicates`, `malformed`, `secrets`, or `all`, or `none` (these two stand alone). Default: `undocumented,missing,duplicates,malformed,secrets`. `dynamic` and `expansions` are not kinds.
* `--ignore <name or /regex/>`: hide a variable from the report; give it as often as you like. A value that starts with `/`, has at least one character, and ends with `/` or `/i` is a regular expression (JavaScript syntax, `i` for case-insensitive) that is *tested*, not anchored, against variable names. Anything else is a name, matched exactly (case-sensitive). An ignored variable is left out of `undocumented`, `stale`, `missing`, `unexpected`, `duplicates`, `secrets` and `expansions`, and so out of the counts and the exit status. Nothing is ignored by default.
* `--help`, `-h`: print a usage line and exit 0.

An option that takes a value takes the next argument (`--env .env.prod`) or the text after `=` (`--env=.env.prod`); the value is never empty. For `--env`, `--example` and `--fail-on` the last one given counts. Anything else that starts with `-` (other than a lone `-`, taken as a `dir`) is an unknown option.

## Exit codes

* `0`: none of the selected kinds has an item (after `--ignore`); or `--help`.
* `1`: at least one of the selected kinds has an item.
* `2`: a usage error: an unknown option; an option without a value or with an empty one; more than one `dir`; a `dir` that is not a folder; an unknown kind in `--fail-on`; `--json` with `--github`; an `--ignore` regular expression JavaScript cannot compile; an `--env` or `--example` that is not an existing file; no template found. The reason is printed on stderr and nothing is printed on stdout.

## Which files are read

Only the top level of `dir` is looked at for `.env` files. Names are exact and lower case.

* **The template:** `--example`, else the first of `.env.example`, `.env.sample`, `.env.template` that is a regular file in `dir`. No template is a usage error.
* **The checked file:** `--env`, else the first regular file of `.env`, then `.env.local`, then the files named `.env.<mode>` (`<mode>` made of `A-Z a-z 0-9 _ -`) in code unit order of their names, leaving out `.env.example`, `.env.sample`, `.env.template`, `.env.local` and the template in use. If there is none, nothing is checked: `env` is `null`, `missing` and `unexpected` are empty, and that is not an error (in CI the real variables often come from the environment).

Files are read as UTF-8; a leading byte-order mark is dropped.

## The dotenv format

Every `\r\n` is read as `\n`. Lines are numbered from 1.

1. Leading spaces and tabs are skipped. An empty line or a line starting with `#` is skipped (`# A=1` sets nothing).
2. `export` followed by spaces or tabs is skipped (`export A=1` sets `A`).
3. The key is the longest `[A-Za-z_][A-Za-z0-9_]*`. No key, or a key followed by something other than a space, a tab, the end of the line or `=` (`my-key=1`), is malformed: `invalid-key`.
4. Spaces and tabs may follow the key; then `=` is required (`A`, `A b` are `missing-equals`). Spaces and tabs after `=` are skipped (`A = 1` sets `A`).
5. The value depends on its first character:
   * `"`: double-quoted, up to the next `"` that is not escaped, and it may continue on following lines. `\n`, `\r`, `\t`, `\"` and `\\` are a line feed, a carriage return, a tab, a quote and a backslash; any other `\x` stays as both characters.
   * `'`: single-quoted, up to the next `'`, no escapes, may continue on following lines.
   * anything else: unquoted, to the end of the line, except that a `#` that starts the value or follows a space or a tab starts a comment. Spaces and tabs at the end are cut. Quotes inside are just characters.
6. A quoted value with no closing quote before the end of the file is malformed (`unterminated-quote`) and reading goes on at the next line after the one the statement started on. After the closing quote only spaces, tabs and a `#` comment may follow; anything else is `trailing-text`, and reading goes on after the line holding the closing quote.
7. A malformed statement is reported at the line it started on and sets nothing.

A value is **empty** when it is the empty string (`A=`, `A=""`, `A=   # c`; but `A=" "` is not). When a name is assigned more than once, the last assignment gives the value and the first gives the line.

**Expansion.** `${NAME}` is never expanded. For an assignment that is not single-quoted, the names found in `${NAME}` in its value (sorted, without repeats) are its `refs`. A template name that is a ref of some template assignment is not `stale`.

## How uses are found in code

Code files are the files under `dir`, at any depth, ending in `.js .jsx .mjs .cjs .ts .tsx .mts .cts` (JavaScript and TypeScript), `.py`, `.go`, `.rb`, `.php` or `.sh`. Not entered: folders named `node_modules`, `vendor`, `dist`, `build`, `coverage` or `__pycache__`, folders whose name starts with a dot, and symbolic links. Files are taken in code unit order of their paths.

JavaScript, TypeScript, Python, Go, Ruby and PHP files are read by a small tokenizer that knows each language's comments and strings (including template literals, Python triple quotes, Go raw strings, and `#{}` in Ruby), so names in comments and ordinary strings are not uses. Then these forms are uses:

| language | subscript | call | dot |
|---|---|---|---|
| JavaScript, TypeScript | `process.env['A']`, `import.meta.env['A']`, `Bun.env['A']` | `Deno.env.get('A')` | `process.env.A`, `import.meta.env.A`, `Bun.env.A` |
| Python | `os.environ['A']` | `os.environ.get('A')`, `os.getenv('A')` | |
| Go | | `os.Getenv("A")`, `os.LookupEnv("A")` | |
| Ruby | `ENV['A']` | `ENV.fetch('A')` | |
| PHP | `$_ENV['A']` | `getenv('A')` (not `$x->getenv(`, `X::getenv(`, `function getenv(`) | |

Also `const { A, B: b, C = 1 } = process.env` in JavaScript and TypeScript: every key is a use. A write (`process.env.A = 'x'`) is a use like a read.

When the name is not a plain string (`process.env[key]`, `` process.env[`X_${n}`] ``, `os.getenv(name)`), it is a **dynamic** use: its position is reported and the name is never guessed.

Shell scripts are scanned character by character: `$A`, `${A}` and `${A:-x}` are uses when the name matches `[A-Z][A-Z0-9_]*`, outside comments and single quotes, unless the script assigns that name itself (`A=1`, `export A=1`), and apart from `HOME PATH PWD OLDPWD USER SHELL IFS TERM TMPDIR HOSTNAME LANG UID EUID PPID RANDOM LINENO SECONDS BASH_SOURCE OPTIND OPTARG REPLY`.

The **position** of a use is its first character: `file` (relative to `dir`, with `/`), `line` from 1, and `column` as 1 plus the number of Unicode code points before it on the line. The **first use** of a name is the first in the first file in code unit order.

## Secrets in the template

Every assignment in the template whose value matches one of these is reported by name, line and pattern only (a `.env` value is never reported as a secret). The first pattern that matches is the one named.

| pattern | matches |
|---|---|
| `aws-access-key` | `\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b` |
| `github-token` | `\b(?:gh[pousr]_[A-Za-z0-9]{36,}\|github_pat_[A-Za-z0-9_]{22,})` |
| `slack-token` | `\bxox[abprs]-[A-Za-z0-9-]{10,}` |
| `stripe-live-key` | `\b[sr]k_live_[A-Za-z0-9]{16,}` |
| `google-api-key` | `\bAIza[0-9A-Za-z_-]{35}\b` |
| `jwt` | `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` |
| `private-key` | `-----BEGIN [A-Z ]*PRIVATE\x20KEY-----` (`\x20` is the space) |

A value that matches is reported even if it looks like a placeholder; `--ignore NAME` lets a name through.

## The findings, exactly

1. `undocumented`: each used name that is not in the template: its first use (`file`, `line`, `column`) and `uses`, the number of its uses. Sorted by name.
2. `stale`: each template name that is not used and not a ref in the template, with its template line. Empty when no code file was found. Sorted by name.
3. `missing`: each template name that is not in the checked file (`absent`) or is there with an empty value (`empty`), with its template line. Empty when no file is checked. Sorted by name.
4. `unexpected`: each name in the checked file that is not in the template, with the line of its first assignment. Sorted by name.
5. `duplicates`: each name assigned more than once in the same file (template or checked file): `name`, `file`, `lines`. Sorted by file, then first line.
6. `malformed`: `file`, `line`, `reason` (`invalid-key`, `missing-equals`, `unterminated-quote`, `trailing-text`) of both files. Sorted by file, then line.
7. `secrets`: as above. Sorted by line.
8. `dynamic`: `file`, `line`, `column`. Sorted by file, line, column.
9. `expansions`: `name`, `file`, `line`, `refs` for each assignment (template or checked file) with at least one ref. Sorted by file, then line.

Names are sorted in code unit order. A variable only mentioned in a comment of a `.env` file, or only in a string of the code, is nothing.

## Worked example

```text
.env.example          .env                            src/server.js
DATABASE_URL=         DATABASE_URL=postgres://...     line 1: process.env.DATABASE_URL
PORT=3000             PORT=3000                       line 2: process.env.PORT
STRIPE_KEY=           DEBUG_SQL=1                     line 3: process.env.STRIPE_WEBHOOK_SECRET
OLD_FLAG=1                                            line 4: process.env.STRIPE_KEY
```

* `STRIPE_WEBHOOK_SECRET` is used (`src/server.js:3:26`) but is not in `.env.example`: `undocumented`.
* `OLD_FLAG` is in the template but nothing uses it: `stale`; and it is not in `.env`: `missing`.
* `STRIPE_KEY` is in the template and used, but not in `.env`: `missing`.
* `DEBUG_SQL` is in `.env` but not in the template: `unexpected`.

That is the output at the top of this page. By default `stale` and `unexpected` are warnings: to fail on them too, use `--fail-on all`.

## JSON

`--json` prints one object, indented by two spaces, followed by a newline:

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

* `example` is the template's `file`; `env` is the checked file's `file`, or `null`. A `file` is the path relative to `dir` with `/` between parts; a file outside `dir` (an absolute `--env` elsewhere) is the path as given.
* `failOn` lists the selected kinds in the order `undocumented stale missing unexpected duplicates malformed secrets`; `ok` is `true` when the exit status is 0.
* All nine lists are always present (empty arrays when there is nothing). `counts` has the length of each list after `--ignore`. `sources.files` is the number of code files read and `sources.uses` the number of uses before `--ignore`.

## CI: GitHub Actions

`--github` prints one workflow command per finding, so each one shows on the pull request at its file and line:

```yaml
name: env-doctor
on: [push, pull_request]
jobs:
  env:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx github:tick-ai/env-doctor --github
```

The line format is `::<level> file=<file>,line=<line>[,col=<column>]::<kind>: <message>`, one per item of `undocumented stale missing unexpected duplicates malformed secrets` in that order (`dynamic` and `expansions` give none). `<level>` is `error` for a kind in `--fail-on` and `warning` otherwise. `undocumented` points at the first use (with `col`); `stale`, `missing` and `secrets` at the template line; `unexpected` at the checked file; `duplicates` at the first line; `malformed` at its line. The message holds the variable name (the reason, for `malformed`) and never a value. `%`, carriage returns and line feeds are written `%25`, `%0D`, `%0A`, and in `file=` also `:` as `%3A` and `,` as `%2C`. With nothing to report, nothing is printed.

## What it does not do

* It does not expand `${NAME}`: the value stays as written, and the names are only noted (`expansions`). Nothing about a referenced name is ever an error.
* It does not read the process environment: it checks files and code, not what is set where it runs.
* It understands code only as far as the tokenizer above does. Regular expression literals, heredocs, JSX text and HTML are not recognized, and names built at run time are reported as `dynamic` and never guessed.
* Its secret patterns are a short list of seven, not a secrets scanner.

## Where it came from

Built by agents on TickHub, as TickHub job `7e3b868d-2466-4a9e-9c22-6815eda4d284`: https://tick.company/hub/#/job/7e3b868d-2466-4a9e-9c22-6815eda4d284. The job, the hand-ins and the receipt are on TickHub's public log. `docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.
