#!/usr/bin/env node
/**
 * Frontend dead-code check.
 *
 * `src/web/public/*.js` is loaded as plain <script> files: no imports, so knip cannot
 * follow it, and it is outside ESLint. A method that lost its last caller therefore
 * stays in the tree unnoticed (the November 2026 cleanup removed about 2,000 such
 * lines of JS and 1,500 lines of CSS). This script finds them.
 *
 * JavaScript: every function, method and top-level binding the frontend files
 * define, checked against every identifier and every string or template literal in
 * those files, `index.html` (inline handlers), the gesture overlay's source and the
 * tests. A name that appears nowhere but at its own definition is reported.
 *
 * CSS: every class and id selector in `styles.css` and `mobile.css`, checked against
 * the same text. A class built at runtime (`tab-state-${state}`) is recognised by its
 * prefix and skipped, so the report holds only names no code can produce.
 *
 * Text matching is deliberately conservative: a mention in a comment does not count,
 * a mention in any string does. So a clean run does not prove everything is used,
 * but a reported name really has no reference. To keep one on purpose, add it to
 * ALLOW below with the reason.
 *
 * Usage: node scripts/check-frontend-dead-code.mjs [--production]
 *   --production  also report what only tests reference (informational, exit 0)
 *
 * Parsed with the TypeScript compiler (already a dev dependency), so this needs no
 * package of its own.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'src', 'web', 'public');
const require = createRequire(join(ROOT, 'package.json'));
const ts = require('typescript');
const postcss = require('postcss');

/**
 * Names kept on purpose although nothing references them. Key: the name as reported
 * (a JS name, or a selector with its `.` or `#`). Value: why it stays.
 */
const ALLOW = new Map([
  // ['exampleMethod', 'called from the browser console when debugging X'],
]);

/** Class prefixes that belong to vendored code, which the scan does not read. */
const EXTERNAL_CLASS_PREFIXES = ['xterm'];

const productionMode = process.argv.includes('--production');

function walk(dir, filter, skipDirs = []) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || skipDirs.includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, filter, skipDirs));
    else if (filter.test(entry)) out.push(path);
  }
  return out;
}

const rel = (path) => relative(ROOT, path);
const read = (path) => readFileSync(path, 'utf8');

// ── What counts as a reference ────────────────────────────────────────────────

// Shipped scripts. The vendored bundles and the generated gesture bundle are not ours
// to judge; the gesture overlay is read from its source instead.
const frontendFiles = walk(PUBLIC_DIR, /\.js$/, ['vendor', 'gesture', 'fonts']);
const htmlText = walk(PUBLIC_DIR, /\.html$/, ['vendor', 'gesture']).map(read).join('\n');
const gestureText = walk(join(ROOT, 'packages', 'gesture-control', 'src'), /\.(ts|js)$/)
  .map(read)
  .join('\n');
const serverText = walk(join(ROOT, 'src'), /\.ts$/, ['public']).map(read).join('\n');
const overlayText = walk(join(ROOT, 'packages', 'xterm-zerolag-input', 'src'), /\.(ts|js)$/)
  .map(read)
  .join('\n');
const testText = walk(join(ROOT, 'test'), /\.(ts|mjs|js)$/).map(read).join('\n');

const identifierCount = new Map();
const literalParts = [];
const definitions = [];

function bump(name) {
  identifierCount.set(name, (identifierCount.get(name) ?? 0) + 1);
}

function isFunctionLike(node) {
  return !!node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node));
}

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Top-level statements, looking one level into an IIFE wrapper. */
function topLevelStatements(sourceFile) {
  const out = [...sourceFile.statements];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    let expr = statement.expression;
    while (ts.isParenthesizedExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
      expr = ts.isParenthesizedExpression(expr) ? expr.expression : expr.operand;
    }
    if (!ts.isCallExpression(expr)) continue;
    let callee = expr.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if ((ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) && ts.isBlock(callee.body)) {
      out.push(...callee.body.statements);
    }
  }
  return out;
}

for (const file of frontendFiles) {
  const text = read(file);
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const define = (name, node, kind) => {
    if (name) definitions.push({ name, file: rel(file), line: lineOf(node), kind });
  };

  for (const statement of topLevelStatements(sourceFile)) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) define(decl.name.text, decl, 'binding');
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      define(statement.name.text, statement, 'binding');
    }
  }

  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) bump(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      literalParts.push(node.text);
    }

    if (ts.isFunctionDeclaration(node) && node.name) define(node.name.text, node, 'function');
    else if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      define(propertyName(node.name), node, 'method');
    } else if (ts.isPropertyAssignment(node) && isFunctionLike(node.initializer)) {
      define(propertyName(node.name), node, 'method');
    } else if (ts.isPropertyDeclaration(node) && isFunctionLike(node.initializer)) {
      define(propertyName(node.name), node, 'method');
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
      define(node.name.text, node, 'function');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const literalText = literalParts.join('\n');
const wordPattern = (name) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g');
const count = (text, pattern) => (text.match(pattern) ?? []).length;

// ── JavaScript ────────────────────────────────────────────────────────────────

const byName = new Map();
for (const def of definitions) {
  // A binding and a function for the same declaration are one definition.
  const list = byName.get(def.name) ?? [];
  if (!list.some((d) => d.file === def.file && d.line === def.line)) list.push(def);
  byName.set(def.name, list);
}

const deadJs = [];
const testOnlyJs = [];
for (const [name, defs] of byName) {
  if (name.length < 3 || name === 'constructor' || ALLOW.has(name)) continue;
  const pattern = wordPattern(name);
  const shipped =
    (identifierCount.get(name) ?? 0) -
    defs.length +
    count(literalText, pattern) +
    count(htmlText, pattern) +
    count(gestureText, pattern);
  if (shipped > 0) continue;
  const inTests = count(testText, pattern);
  (inTests > 0 ? testOnlyJs : deadJs).push({ name, defs, inTests });
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const cssCorpus = [
  ...frontendFiles.map(read),
  htmlText,
  gestureText,
  overlayText,
  serverText,
  ...walk(PUBLIC_DIR, /\.json$/, ['vendor', 'gesture']).map(read),
].join('\n');
const corpusWords = new Set(cssCorpus.match(/[A-Za-z_][\w-]*/g) ?? []);
// `foo-${x}` and 'foo-' + x build a class at runtime: everything with that prefix may exist.
const dynamicPrefixes = new Set();
for (const m of cssCorpus.matchAll(/([A-Za-z_][\w-]*-)(?:\$\{|['"`]\s*\+)/g)) dynamicPrefixes.add(m[1]);
// `${x}-suffix` and x + '-suffix' likewise, when the stem itself is a known word.
const dynamicSuffixes = new Set();
for (const m of cssCorpus.matchAll(/(?:\}|\+\s*['"`])(-[\w-]+)/g)) dynamicSuffixes.add(m[1]);

const deadCss = [];
for (const cssFile of [join(PUBLIC_DIR, 'styles.css'), join(PUBLIC_DIR, 'mobile.css')]) {
  const seen = new Map();
  postcss.parse(read(cssFile), { from: cssFile }).walkRules((rule) => {
    const selector = rule.selector.replace(/\[[^\]]*\]/g, ' ').replace(/"[^"]*"|'[^']*'/g, ' ');
    for (const m of selector.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) {
      const key = m[1] + m[2];
      if (!seen.has(key)) seen.set(key, rule.source.start.line);
    }
  });
  for (const [key, line] of seen) {
    const name = key.slice(1);
    if (ALLOW.has(key) || corpusWords.has(name)) continue;
    if (EXTERNAL_CLASS_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix + '-'))) continue;
    if ([...dynamicPrefixes].some((prefix) => name.startsWith(prefix))) continue;
    if ([...dynamicSuffixes].some((suffix) => name.endsWith(suffix) && corpusWords.has(name.slice(0, -suffix.length)))) {
      continue;
    }
    if (deadCss.some((d) => d.key === key)) continue;
    deadCss.push({ key, file: rel(cssFile), line });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const where = (defs) => defs.map((d) => `${d.file}:${d.line}`).join(', ');
const sortByPlace = (a, b) => where(a.defs).localeCompare(where(b.defs), undefined, { numeric: true });

if (productionMode && testOnlyJs.length > 0) {
  console.log(`Referenced by tests only (${testOnlyJs.length}):`);
  for (const item of testOnlyJs.sort(sortByPlace)) {
    console.log(`  ${item.name}  ${where(item.defs)}  (${item.inTests} mention${item.inTests === 1 ? '' : 's'} in test/)`);
  }
  console.log('');
}

if (deadJs.length === 0 && deadCss.length === 0) {
  console.log(
    `✓ no unreferenced frontend code: ${byName.size} names in ${frontendFiles.length} scripts and the selectors of 2 stylesheets checked`
  );
  process.exit(0);
}

if (deadJs.length > 0) {
  console.error(`Unreferenced frontend functions and bindings (${deadJs.length}):`);
  for (const item of deadJs.sort(sortByPlace)) console.error(`  ${item.name}  ${where(item.defs)}`);
}
if (deadCss.length > 0) {
  console.error(`${deadJs.length > 0 ? '\n' : ''}CSS selectors nothing can produce (${deadCss.length}):`);
  for (const item of deadCss) console.error(`  ${item.key}  ${item.file}:${item.line}`);
}
console.error(
  '\nRemove each one, or add it to ALLOW in scripts/check-frontend-dead-code.mjs with the reason it stays.'
);
process.exit(1);
