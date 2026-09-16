import assert from "node:assert/strict";
import type { JjTokenRole } from "../shared/contracts";
import { languageForPath, tokenize, tokenizeLines } from "./tokenize";

/**
 * The invariant that matters: a line's tokens concatenate back to that line,
 * byte for byte. Colouring may be imperfect; altering source never is.
 */

const CORPUS: Array<[string, string]> = [
 [
  "src/app.ts",
  [
   "// fetch the thing",
   "import { readFile } from 'node:fs/promises';",
   "",
   "export async function load(path: string, retries = 3): Promise<string> {",
   '  const label = `try ${retries} of ${path}`;',
   '  /* block comment',
   '     spanning lines */',
   '  if (retries > 0) return await readFile(path, "utf8");',
   '  throw new Error("nope");',
   "}",
  ].join("\n"),
 ],
 [
  "lib/main.py",
  [
   "# a comment",
   "from pathlib import Path",
   "",
   "class Loader:",
   '    """Docstring with # inside."""',
   "",
   "    def load(self, path: str, retries: int = 3) -> str:",
   "        total = 0x1F + 1e-3 + 0b1010",
   "        return f'{path}:{retries}' if total > 0 else ''",
  ].join("\n"),
 ],
 [
  "src/lib.rs",
  [
   "//! module docs",
   "use std::collections::HashMap;",
   "",
   "pub fn count(items: &[String]) -> HashMap<String, usize> {",
   "    let mut out = HashMap::new();",
   "    for item in items {",
   "        *out.entry(item.clone()).or_insert(0) += 1;",
   "    }",
   "    out",
   "}",
  ].join("\n"),
 ],
 [
  "cmd/run.go",
  [
   "package main",
   "",
   "func main() {",
   '    raw := `backtick string with "quotes" and // slashes`',
   "    println(raw)",
   "}",
  ].join("\n"),
 ],
 [
  "scripts/build.sh",
  [
   "#!/usr/bin/env bash",
   "set -euo pipefail",
   "",
   "# build everything",
   'echo "a # not a comment"',
   'target=${1:-"release"}',
   "npm run build -- --mode \"$target\"",
  ].join("\n"),
 ],
 [
  "config/app.yaml",
  [
   "name: demo",
   "url: http://example.com/a#b",
   "count: 12",
   "# trailing comment",
   "flag: true",
  ].join("\n"),
 ],
 [
  "data/payload.json",
  ['{', '  "name": "demo",', '  "count": 12,', '  "nested": { "ok": true }', "}"].join("\n"),
 ],
 [
  "queries/report.sql",
  [
   "-- monthly totals",
   "SELECT count(*) AS total, sum(amount)",
   "FROM payments",
   "WHERE created_at >= '2026-01-01' /* window */",
   "GROUP BY customer_id;",
  ].join("\n"),
 ],
 [
  "web/index.html",
  ['<!DOCTYPE html>', '<div class="row">', "  <!-- a comment -->", "  <span>hi</span>", "</div>"].join(
   "\n",
  ),
 ],
 [
  "src/engine.cpp",
  [
   "#include <vector>",
   "",
   "template <typename T>",
   "std::vector<T> twice(const std::vector<T>& in) {",
   "  // copy",
   "  auto out = in;",
   "  out.insert(out.end(), in.begin(), in.end());",
   "  return out;",
   "}",
  ].join("\n"),
 ],
 ["styles/site.css", ["/* theme */", ".row {", "  display: flex;", '  color: "#fff";', "}"].join("\n")],
];

// --- round trip: the whole point ------------------------------------------
for (const [path, source] of CORPUS) {
 const language = languageForPath(path);
 assert.ok(language, `${path} should map to a language`);

 const tokens = tokenize(source, language);
 const rebuilt = tokens.map((token) => token.t).join("");
 assert.equal(rebuilt, source, `${path}: tokenizing must not alter the text`);

 // And through the per-line splitter, which is what the diff actually uses.
 const lines = source.split("\n");
 const byLine = tokenizeLines(lines, language);
 assert.equal(byLine.length, lines.length, `${path}: one token array per line`);
 byLine.forEach((lineTokens, index) => {
  assert.equal(
   lineTokens.map((token) => token.t).join(""),
   lines[index],
   `${path}: line ${index + 1} must round-trip`,
  );
 });
}

// --- unterminated constructs must not swallow the file --------------------
{
 const broken = ['const a = "unterminated', "const b = 2;"].join("\n");
 const tokens = tokenize(broken, "typescript");
 assert.equal(tokens.map((token) => token.t).join(""), broken);

 const openBlock = ["/* never closed", "const c = 3;"].join("\n");
 assert.equal(tokenize(openBlock, "typescript").map((token) => token.t).join(""), openBlock);

 const openTemplate = ["const t = `never closed", "const d = 4;"].join("\n");
 assert.equal(tokenize(openTemplate, "typescript").map((token) => token.t).join(""), openTemplate);
}

// --- roles are actually assigned ------------------------------------------
{
 const rolesFor = (code: string, path: string): Map<string, JjTokenRole> => {
  const roles = new Map<string, JjTokenRole>();
  for (const token of tokenize(code, languageForPath(path))) {
   if (token.c !== null && !roles.has(token.t)) roles.set(token.t, token.c);
  }
  return roles;
 };

 const ts = rolesFor(
  'const total = 42; function add(a, b) { return a + b; } // note\nconst s = "text";',
  "src/a.ts",
 );
 assert.equal(ts.get("const"), "keyword");
 assert.equal(ts.get("function"), "keyword");
 assert.equal(ts.get("add"), "function");
 assert.equal(ts.get("42"), "number");
 assert.equal(ts.get("// note"), "comment");
 assert.equal(ts.get('"text"'), "string");

 const py = rolesFor("def run(x):\n    return None  # done", "a.py");
 assert.equal(py.get("def"), "keyword");
 assert.equal(py.get("run"), "function");
 assert.equal(py.get("None"), "type");
 assert.equal(py.get("# done"), "comment");

 const sh = rolesFor("if [ -f x ]; then\n  echo hi # yes\nfi", "a.sh");
 assert.equal(sh.get("if"), "keyword");
 assert.equal(sh.get("echo"), "builtin");

 const json = rolesFor('{"on": true, "n": null}', "a.json");
 assert.equal(json.get('"on"'), "string");
 assert.equal(json.get("true"), "type");
 assert.equal(json.get("null"), "type");

 const sql = rolesFor("SELECT id FROM users -- note", "a.sql");
 assert.equal(sql.get("SELECT"), "keyword");
 assert.equal(sql.get("select"), undefined, "case-insensitive keywords use the source spelling");
 assert.equal(sql.get("-- note"), "comment");

 const xml = rolesFor('<div class="x">hi</div>', "a.html");
 assert.equal(xml.get("<div"), "tag");
 assert.equal(xml.get("</div"), "tag");
 assert.equal(xml.get('"x"'), "string");
}

// --- contexts that must not misfire ---------------------------------------
{
 const generic = tokenize("const a: Array<string> = [];", "typescript");
 assert.ok(
  generic.every((token) => token.c !== "tag"),
  "a TypeScript generic is not a markup tag",
 );

 const division = tokenize("const ratio = total / count / 2;", "typescript");
 assert.ok(
  division.every((token) => token.c !== "comment"),
  "a division sign is not a comment",
 );

 const yamlHash = tokenize("url: http://x/a#b", "yaml");
 assert.ok(
  yamlHash.every((token) => token.c !== "comment"),
  "a hash inside a word is not a comment",
 );

 const shellHash = tokenize("echo a#b", "shell");
 assert.ok(
  shellHash.every((token) => token.c !== "comment"),
  "a hash inside a shell word is not a comment",
 );

 const escaped = tokenize('const s = "a \\" quoted \\" b";', "typescript");
 assert.equal(escaped.map((token) => token.t).join(""), 'const s = "a \\" quoted \\" b";');
 assert.equal(escaped.filter((token) => token.c === "string").length, 1, "escapes do not end the string");
}

// --- numbers ---------------------------------------------------------------
{
 const roles = new Map<string, JjTokenRole>();
 for (const token of tokenize("0x1F 0b1010 0o17 1_000 1.5 1e-3 42n", "typescript")) {
  if (token.c !== null) roles.set(token.t, token.c);
 }
 for (const literal of ["0x1F", "0b1010", "0o17", "1_000", "1.5", "1e-3"]) {
  assert.equal(roles.get(literal), "number", `${literal} should be a number`);
 }
}

// --- degradation -----------------------------------------------------------
{
 assert.deepEqual(tokenize("", "typescript"), []);
 assert.deepEqual(tokenizeLines([], "typescript"), []);
 assert.equal(tokenize("plain text", null)[0].c, null);
 assert.equal(tokenize("plain text", "no-such-language")[0].c, null);
 assert.equal(languageForPath("no-extension"), null);
 assert.equal(languageForPath("a/b/Dockerfile"), null);
}

console.log("tokenize.test.ts: all assertions passed");
