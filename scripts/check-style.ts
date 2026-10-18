import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** A source location where public API documentation or function spacing violates project style. */
export interface StyleViolation {
  file: string;
  line: number;
  rule: "public-jsdoc" | "function-spacing";
  message: string;
}

const ignoredDirectories = new Set([
  "node_modules",
  ".worktrees",
  "dist",
  "generated",
  "__generated__",
  "tests",
  "docs",
  ".mastra",
]);

function isFunctionExpression(node: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return isFunctionExpression(node.expression);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isImplementation(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return Boolean(node.body);
  if (
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return Boolean(node.body);
  return (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.initializer && isFunctionExpression(declaration.initializer),
    )
  );
}

function siblingNodes(node: ts.Node): readonly ts.Node[] {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node.members;
  if (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  )
    return node.statements;
  return [];
}

function spacingAnchor(source: ts.SourceFile, previous: ts.Node, next: ts.Node) {
  const trailing = ts.getTrailingCommentRanges(source.text, previous.end) ?? [];
  const previousEnd = trailing.at(-1)?.end ?? previous.end;
  const leading = ts.getLeadingCommentRanges(source.text, next.getFullStart()) ?? [];
  const nextStart =
    leading.find((comment) => comment.pos >= previousEnd)?.pos ?? next.getStart(source);
  return { previousEnd, nextStart };
}

function spacingViolations(source: ts.SourceFile, parent: ts.Node): StyleViolation[] {
  const violations: StyleViolation[] = [];
  const siblings = siblingNodes(parent);
  for (let index = 1; index < siblings.length; index++) {
    const previous = siblings[index - 1];
    const next = siblings[index];
    if (!previous || !next || !isImplementation(previous) || !isImplementation(next)) continue;
    const { previousEnd, nextStart } = spacingAnchor(source, previous, next);
    const previousLine = source.getLineAndCharacterOfPosition(previousEnd).line;
    const nextLine = source.getLineAndCharacterOfPosition(nextStart).line;
    if (nextLine - previousLine !== 2)
      violations.push({
        file: source.fileName,
        line: nextLine + 1,
        rule: "function-spacing",
        message:
          "Use exactly one blank line between adjacent function implementations, before leading comments.",
      });
  }
  return violations;
}

function requiresDocumentation(node: ts.Statement): boolean {
  if (ts.isExportDeclaration(node)) return false;
  if (ts.isExportAssignment(node)) return true;
  return (
    ts.canHaveModifiers(node) &&
    Boolean(
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
  );
}

/**
 * Inspect a module without executing it. Top-level exported definitions require JSDoc;
 * export lists, barrel reexports, and individual class members do not require duplicate docs.
 */
export function analyzeStyle(file: string, text: string): StyleViolation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: StyleViolation[] = [];
  for (const statement of source.statements) {
    if (!requiresDocumentation(statement) || ts.getJSDocCommentsAndTags(statement).some(ts.isJSDoc))
      continue;
    violations.push({
      file,
      line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
      rule: "public-jsdoc",
      message: "Document this exported definition with JSDoc describing its public contract.",
    });
  }
  const visit = (node: ts.Node) => {
    violations.push(...spacingViolations(source, node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations.sort(
    (left, right) => left.line - right.line || left.rule.localeCompare(right.rule),
  );
}

function isMaintainedSource(file: string): boolean {
  const segments = file.split(/[\\/]/);
  if (segments.some((segment) => ignoredDirectories.has(segment))) return false;
  return !/\.(?:test|spec|generated|gen)\.[^.]+$/.test(file);
}

/** Inspect maintained source, scripts, and application configuration relative to a repository root. */
export function checkStyle(root = process.cwd()): StyleViolation[] {
  const files = globSync(
    [
      "apps/*/src/**/*.{ts,tsx,js,mjs,cjs}",
      "packages/*/src/**/*.{ts,tsx,js,mjs,cjs}",
      "scripts/**/*.{ts,tsx,js,mjs,cjs}",
      "config/**/*.{mjs,js}",
      "opensenpai.config.mjs",
    ],
    { cwd: root },
  );
  return files
    .filter(isMaintainedSource)
    .sort()
    .flatMap((file) => analyzeStyle(file, readFileSync(resolve(root, file), "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = checkStyle();
  for (const violation of violations)
    process.stderr.write(
      `${relative(process.cwd(), resolve(violation.file))}:${violation.line}:${violation.rule}: ${violation.message}\n`,
    );
  if (violations.length) process.exitCode = 1;
}
