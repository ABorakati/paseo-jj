/**
 * A small, dependency-free tokenizer for diff syntax colouring.
 *
 * Why not highlight.js or shiki: the Paseo plugin build traces type
 * dependencies, and highlight.js's root type entry imports the unexported
 * `highlight.js/private`, so installing the plugin fails before any code runs.
 * A self-contained scanner keeps the plugin installable, removes a megabyte
 * from the daemon bundle, and is fully deterministic.
 *
 * Invariant: the concatenated token text of a line is that line, byte for byte.
 * Colouring may be imperfect; altering source never is.
 */

import type { JjToken, JjTokenRole } from "../shared/contracts";

interface Profile {
 lineComments: string[];
 blockComment?: [string, string];
 /** Delimiters that close on the same character, honouring backslash escapes. */
 strings: string[];
 /** Delimiters that may span lines, such as template literals and triple quotes. */
 multilineStrings: string[];
 keywords: ReadonlySet<string>;
 types: ReadonlySet<string>;
 builtins: ReadonlySet<string>;
 /** `#` only opens a comment where a token can start, as in shell and YAML. */
 hashCommentNeedsBoundary: boolean;
 caseInsensitive: boolean;
 /** Scan `<name` as a tag. Off unless set, since `<` is comparison or a
  *  generic in code. */
 markupTags?: boolean;
}

const words = (source: string): ReadonlySet<string> => new Set(source.trim().split(/\s+/));
const NONE: ReadonlySet<string> = new Set();

const C_LIKE = {
 lineComments: ["//"],
 blockComment: ["/*", "*/"] as [string, string],
 strings: ['"', "'"],
 multilineStrings: [],
 types: NONE,
 builtins: NONE,
 hashCommentNeedsBoundary: false,
 caseInsensitive: false,
 markupTags: false,
};

const PROFILES: Record<string, Profile> = {
 typescript: {
  ...C_LIKE,
  multilineStrings: ["`"],
  keywords: words(`const let var function return if else for while do switch case break continue new
      class extends implements interface type enum import export from default async await yield try catch
      finally throw typeof instanceof in of delete void this super static public private protected readonly
      abstract declare namespace module as satisfies keyof infer is asserts override get set`),
  types: words(`string number boolean object symbol bigint unknown any never void undefined null true false`),
  builtins: words(`console JSON Math Object Array Promise Map Set Date RegExp Error Symbol BigInt process
      require module exports globalThis window document`),
 },
 javascript: {
  ...C_LIKE,
  multilineStrings: ["`"],
  keywords: words(`const let var function return if else for while do switch case break continue new class
      extends import export from default async await yield try catch finally throw typeof instanceof in of
      delete void this super static get set`),
  types: words(`undefined null true false NaN Infinity`),
  builtins: words(`console JSON Math Object Array Promise Map Set Date RegExp Error Symbol BigInt
      parseInt parseFloat isNaN process require module exports globalThis`),
 },
 python: {
  lineComments: ["#"],
  strings: ['"', "'"],
  multilineStrings: ['"""', "'''"],
  keywords: words(`def class return if elif else for while import from as pass break continue with try
      except finally raise lambda yield global nonlocal assert del in is not and or async await match case`),
  types: words(`None True False self cls`),
  builtins: words(`print len range str int float dict list set tuple bool bytes open enumerate zip map filter
      sum min max abs sorted isinstance super type`),
  hashCommentNeedsBoundary: false,
  caseInsensitive: false,
 },
 rust: {
  ...C_LIKE,
  keywords: words(`fn let mut const static struct enum impl trait for while loop if else match return use mod
      pub crate self super where async await move ref dyn box unsafe as in break continue type extern union
      macro_rules`),
  types: words(`i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 usize isize bool char str String Vec Option
      Result Box Rc Arc HashMap HashSet Self true false`),
  builtins: words(`println print format vec panic assert todo unreachable Some None Ok Err`),
 },
 go: {
  ...C_LIKE,
  multilineStrings: ["`"],
  keywords: words(`func package import var const type struct interface map chan go defer if else for range
      return switch case default break continue select fallthrough goto`),
  types: words(`int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 complex64
      complex128 string bool byte rune error any nil true false make new len cap append copy delete panic`),
  builtins: words(`make new len cap append copy delete panic recover print println`),
 },
 java: {
  ...C_LIKE,
  keywords: words(`public private protected class interface extends implements static final void new return
      if else for while do switch case break continue try catch finally throw throws import package this super
      abstract synchronized volatile transient native instanceof enum record sealed permits var yield assert`),
  types: words(`int long double float boolean char byte short String Integer Long Double Float Boolean
      Character Object List Map Set null true false`),
  builtins: words(`System String Math Integer Long Double Float Boolean Object List Map Set Optional Stream`),
 },
 c: {
  ...C_LIKE,
  keywords: words(`int char float double void long short unsigned signed struct union enum typedef static
      extern const volatile register auto if else for while do switch case break continue return goto sizeof`),
  types: words(`size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE NULL true false`),
  builtins: words(`printf fprintf sprintf snprintf malloc calloc realloc free memcpy memset strlen strcmp`),
 },
 cpp: {
  ...C_LIKE,
  keywords: words(`int char float double void long short unsigned signed struct union enum typedef static
      extern const volatile register auto if else for while do switch case break continue return goto sizeof
      class public private protected virtual override template typename namespace using new delete this
      nullptr constexpr inline noexcept friend operator explicit mutable static_cast dynamic_cast const_cast
      reinterpret_cast try catch throw`),
  types: words(`size_t string vector map set unordered_map unordered_set shared_ptr unique_ptr weak_ptr
      optional variant tuple pair bool true false nullptr`),
  builtins: words(`std cout cin endl printf malloc free memcpy strlen`),
 },
 csharp: {
  ...C_LIKE,
  keywords: words(`using namespace class struct interface public private protected internal static void new
      return if else for foreach while do switch case break continue try catch finally throw async await
      override virtual abstract sealed readonly const record in out ref params is as typeof nameof base this
      null true false var`),
  types: words(`int long double float bool char byte short string decimal object List Dictionary Task
      IEnumerable null true false`),
  builtins: words(`Console String Math Task List Dictionary IEnumerable`),
 },
 ruby: {
  lineComments: ["#"],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: words(`def end class module return if elsif else unless for while until do begin rescue ensure
      raise yield block_given? lambda proc require require_relative attr_accessor attr_reader attr_writer
      include extend prepend then case when in break next redo retry self nil and or not`),
  types: words(`nil true false self`),
  builtins: words(`puts print p gets new inspect to_s to_i to_a length each map select reject`),
  hashCommentNeedsBoundary: false,
  caseInsensitive: false,
 },
 php: {
  lineComments: ["//", "#"],
  blockComment: ["/*", "*/"],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: words(`function class interface trait extends implements public private protected static return
      if else elseif endif for foreach while do switch case break continue new echo print require include
      namespace use as try catch finally throw instanceof clone abstract final const global`),
  types: words(`int float string bool array object callable void mixed null true false self parent`),
  builtins: words(`echo print var_dump count strlen array_map array_filter implode explode isset empty`),
  hashCommentNeedsBoundary: false,
  caseInsensitive: true,
 },
 shell: {
  lineComments: ["#"],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: words(`if then else elif fi for while until do done case esac function return exit local export
      readonly declare set unset shift source alias eval exec trap in`),
  types: NONE,
  builtins: words(`echo printf cd pwd ls cp mv rm mkdir rmdir touch cat head tail grep sed awk sort uniq wc
      find xargs chmod chown curl wget git npm node python pip test read`),
  hashCommentNeedsBoundary: true,
  caseInsensitive: false,
 },
 sql: {
  lineComments: ["--"],
  blockComment: ["/*", "*/"],
  strings: ["'"],
  multilineStrings: [],
  keywords: words(`select from where insert into update delete create table drop alter add column index view
      join left right inner outer full on group by order having limit offset union all distinct as and or not
      null is in between like exists case when then else end primary key foreign references default cascade
      begin commit rollback transaction`),
  types: words(`int integer bigint smallint decimal numeric float real char varchar text date timestamp
      boolean json uuid serial`),
  builtins: words(`count sum avg min max coalesce cast now current_date lower upper trim length`),
  hashCommentNeedsBoundary: false,
  caseInsensitive: true,
 },
 json: {
  lineComments: [],
  strings: ['"'],
  multilineStrings: [],
  keywords: NONE,
  types: words(`true false null`),
  builtins: NONE,
  hashCommentNeedsBoundary: false,
  caseInsensitive: false,
 },
 yaml: {
  lineComments: ["#"],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: NONE,
  types: words(`true false null yes no on off`),
  builtins: NONE,
  hashCommentNeedsBoundary: true,
  caseInsensitive: false,
 },
 ini: {
  lineComments: ["#", ";"],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: NONE,
  types: words(`true false yes no on off`),
  builtins: NONE,
  hashCommentNeedsBoundary: false,
  caseInsensitive: false,
 },
 css: {
  blockComment: ["/*", "*/"],
  lineComments: [],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: words(`import media supports keyframes font-face charset page layer container`),
  types: NONE,
  builtins: words(`display position color background margin padding border font flex grid width height
      transform transition animation opacity z-index overflow`),
  hashCommentNeedsBoundary: false,
  caseInsensitive: true,
 },
 xml: {
  blockComment: ["<!--", "-->"],
  lineComments: [],
  strings: ['"', "'"],
  multilineStrings: [],
  keywords: NONE,
  types: NONE,
  builtins: NONE,
  hashCommentNeedsBoundary: false,
  caseInsensitive: false,
  markupTags: true,
 },
};

const EXTENSION_PROFILE: Record<string, keyof typeof PROFILES> = {
 ts: "typescript",
 tsx: "typescript",
 mts: "typescript",
 cts: "typescript",
 js: "javascript",
 jsx: "javascript",
 mjs: "javascript",
 cjs: "javascript",
 json: "json",
 jsonc: "json",
 py: "python",
 pyi: "python",
 rs: "rust",
 go: "go",
 java: "java",
 c: "c",
 h: "c",
 cc: "cpp",
 cpp: "cpp",
 cxx: "cpp",
 hpp: "cpp",
 hh: "cpp",
 cs: "csharp",
 rb: "ruby",
 php: "php",
 sh: "shell",
 bash: "shell",
 zsh: "shell",
 ps1: "shell",
 psm1: "shell",
 sql: "sql",
 yml: "yaml",
 yaml: "yaml",
 toml: "ini",
 ini: "ini",
 cfg: "ini",
 conf: "ini",
 properties: "ini",
 css: "css",
 scss: "css",
 less: "css",
 html: "xml",
 htm: "xml",
 xml: "xml",
 svg: "xml",
 vue: "xml",
};

export function languageForPath(path: string): string | null {
 const dot = path.lastIndexOf(".");
 if (dot < 0) return null;
 return EXTENSION_PROFILE[path.slice(dot + 1).toLowerCase()] ?? null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function isWordBoundaryBefore(text: string, index: number): boolean {
 if (index === 0) return true;
 const previous = text[index - 1];
 return !IDENT_PART.test(previous);
}

/** Whitespace and newlines are transparent when asking what follows a token. */
function nextSignificant(text: string, from: number): string {
 let index = from;
 while (index < text.length && /\s/.test(text[index])) index += 1;
 return text[index] ?? "";
}

/** The last non-whitespace character before `index`, with `->` treated as one. */
function previousSignificant(text: string, index: number): string {
 let cursor = index - 1;
 while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
 if (cursor < 0) return "";
 if (text[cursor] === ">" && text[cursor - 1] === "-") return "->";
 return text[cursor];
}

/** Classify a bare identifier from the profile and its immediate context. */
function classify(word: string, profile: Profile, text: string, end: number): JjTokenRole {
 const probe = profile.caseInsensitive ? word.toLowerCase() : word;
 if (profile.keywords.has(probe)) return "keyword";
 if (profile.types.has(probe)) return "type";
 if (profile.builtins.has(probe)) return "builtin";
 if (nextSignificant(text, end) === "(") return "function";
 const previous = previousSignificant(text, end - word.length);
 if (previous === "." || previous === "->") return "attribute";
 return "plain";
}

/**
 * Tokenize a whole hunk side in one pass. Scanning the joined text, rather than
 * each line, is what keeps multi-line comments and template literals correct.
 */
export function tokenize(text: string, language: string | null): JjToken[] {
 const profile = language ? PROFILES[language] : undefined;
 if (!profile) return text.length > 0 ? [{ t: text, c: null }] : [];

 const tokens: JjToken[] = [];
 let plain = "";
 let index = 0;

 const flushPlain = () => {
  if (plain.length === 0) return;
  tokens.push({ t: plain, c: null });
  plain = "";
 };
 const push = (role: JjTokenRole, start: number, end: number) => {
  flushPlain();
  tokens.push({ t: text.slice(start, end), c: role });
 };

 while (index < text.length) {
  const rest = text.slice(index);

  // Line comments.
  let matchedComment = false;
  for (const marker of profile.lineComments) {
   if (!rest.startsWith(marker)) continue;
   if (marker === "#" && profile.hashCommentNeedsBoundary && !isWordBoundaryBefore(text, index)) continue;
   const newline = text.indexOf("\n", index);
   const end = newline < 0 ? text.length : newline;
   push("comment", index, end);
   index = end;
   matchedComment = true;
   break;
  }
  if (matchedComment) continue;

  // Block comments.
  const block = profile.blockComment;
  if (block && rest.startsWith(block[0])) {
   const close = text.indexOf(block[1], index + block[0].length);
   const end = close < 0 ? text.length : close + block[1].length;
   push("comment", index, end);
   index = end;
   continue;
  }

  // Strings that may span lines.
  let matchedMultiline = false;
  for (const delimiter of profile.multilineStrings) {
   if (!rest.startsWith(delimiter)) continue;
   let cursor = index + delimiter.length;
   while (cursor < text.length) {
    if (text.startsWith(delimiter, cursor)) {
     cursor += delimiter.length;
     break;
    }
    if (delimiter !== "`" && text[cursor] === "\\") {
     cursor += 2;
     continue;
    }
    cursor += 1;
   }
   push("string", index, Math.min(cursor, text.length));
   index = Math.min(cursor, text.length);
   matchedMultiline = true;
   break;
  }
  if (matchedMultiline) continue;

  // Single-line strings.
  let matchedString = false;
  for (const delimiter of profile.strings) {
   if (!rest.startsWith(delimiter)) continue;
   let cursor = index + delimiter.length;
   while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
     cursor += 2;
     continue;
    }
    if (char === delimiter) {
     cursor += 1;
     break;
    }
    if (char === "\n") break;
    cursor += 1;
   }
   push("string", index, Math.min(cursor, text.length));
   index = Math.min(cursor, text.length);
   matchedString = true;
   break;
  }
  if (matchedString) continue;

  const char = text[index];

  // Numbers: radix prefixes, then decimals, exponents, and type suffixes.
  if (DIGIT.test(char) || (char === "." && DIGIT.test(text[index + 1] ?? ""))) {
   let cursor = index;
   const radix = /^0[xX]/.test(rest)
    ? /[0-9a-fA-F_]/
    : /^0[bB]/.test(rest)
     ? /[01_]/
     : /^0[oO]/.test(rest)
      ? /[0-7_]/
      : null;
   if (radix) {
    cursor += 2;
    while (cursor < text.length && radix.test(text[cursor])) cursor += 1;
   } else {
    while (cursor < text.length && /[0-9_]/.test(text[cursor])) cursor += 1;
    if (text[cursor] === "." && DIGIT.test(text[cursor + 1] ?? "")) {
     cursor += 1;
     while (cursor < text.length && /[0-9_]/.test(text[cursor])) cursor += 1;
    }
    if (/[eE]/.test(text[cursor] ?? "")) {
     const exponent = cursor;
     let probe = cursor + 1;
     if (text[probe] === "+" || text[probe] === "-") probe += 1;
     if (DIGIT.test(text[probe] ?? "")) {
      cursor = probe;
      while (cursor < text.length && DIGIT.test(text[cursor])) cursor += 1;
     } else {
      cursor = exponent;
     }
    }
   }
   push("number", index, cursor);
   index = cursor;
   continue;
  }

  // Identifiers.
  if (IDENT_START.test(char)) {
   let cursor = index;
   while (cursor < text.length && IDENT_PART.test(text[cursor])) cursor += 1;
   const word = text.slice(index, cursor);
   push(classify(word, profile, text, cursor), index, cursor);
   index = cursor;
   continue;
  }

  // Markup tag names, so XML and HTML are not flat.
  if (profile.markupTags && char === "<" && /[A-Za-z/!?]/.test(text[index + 1] ?? "")) {
   let cursor = index + 1;
   if (text[cursor] === "/") cursor += 1;
   while (cursor < text.length && /[A-Za-z0-9:_-]/.test(text[cursor])) cursor += 1;
   if (cursor > index + 1) {
    push("tag", index, cursor);
    index = cursor;
    continue;
   }
  }

  plain += char;
  index += 1;
 }

 flushPlain();
 return tokens;
}

/** Tokenize a hunk side and cut the runs back into one array per line. */
export function tokenizeLines(lines: string[], language: string | null): JjToken[][] {
 if (lines.length === 0) return [];
 const tokens = tokenize(lines.join("\n"), language);

 const result: JjToken[][] = [];
 let current: JjToken[] = [];
 for (const token of tokens) {
  const parts = token.t.split("\n");
  for (let index = 0; index < parts.length; index += 1) {
   if (index > 0) {
    result.push(current);
    current = [];
   }
   if (parts[index].length > 0) current.push({ t: parts[index], c: token.c });
  }
 }
 result.push(current);

 // The joined text has one less separator than there are lines, so a trailing
 // empty line only appears when the source ended with a newline.
 while (result.length > lines.length) result.pop();
 while (result.length < lines.length) result.push([]);
 return result;
}
