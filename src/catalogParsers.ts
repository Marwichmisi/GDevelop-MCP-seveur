/**
 * Catalogue parsers (ticket #15) — port of `gb2b/gdevelop-mcp`
 * `src/core/catalog-parsers.ts` + `catalog-dynamic.ts`, applied to a pinned
 * GDevelop source tree. Pure functions: no I/O, no engine, no network.
 *
 * The parser is regex + bracket-matching, not a real C++/JS parser. That is
 * enough for GDevelop's hand-written extension builder syntax, which is highly
 * regular (always chained method calls on a builder). See
 * `docs/research/gdevelop-mcp-catalogue-research.md` §1 and §3.
 */

export type InstructionKind = 'action' | 'condition' | 'expression' | 'strExpression';

export type ReceiverKind = 'extension' | 'object' | 'behavior' | 'unknown';

export interface CatalogParameter {
  type: string;
  description?: string | undefined;
  extraInfo?: string | undefined;
  optional?: boolean | undefined;
}

export interface ParsedInstruction {
  type: string;
  fullName?: string | undefined;
  description?: string | undefined;
  kind: InstructionKind;
  /** Raw identifier preceding the `.AddXxx` call, e.g. `extension`, `obj`. */
  receiver?: string | undefined;
  parameters: CatalogParameter[];
}

export type TypeDeclarationKind = 'object' | 'behavior' | 'eventsBasedObject' | 'eventsBasedBehavior';

export interface ParsedTypeDeclaration {
  /** Declared name, or `<events-based>` when only the marker was found. */
  name: string;
  kind: TypeDeclarationKind;
}

export interface ParsedExtension {
  /** `SetExtensionInformation` first argument, or null when absent. */
  name: string | null;
  fullName?: string | undefined;
  description?: string | undefined;
  instructions: ParsedInstruction[];
  typeDeclarations: ParsedTypeDeclaration[];
}

const INSTRUCTION_METHODS = new Map<string, InstructionKind>([
  ['AddAction', 'action'],
  ['addAction', 'action'],
  ['AddScopedAction', 'action'],
  ['addScopedAction', 'action'],
  ['AddCondition', 'condition'],
  ['addCondition', 'condition'],
  ['AddScopedCondition', 'condition'],
  ['addScopedCondition', 'condition'],
  ['AddExpression', 'expression'],
  ['addExpression', 'expression'],
  ['AddStrExpression', 'strExpression'],
  ['addStrExpression', 'strExpression'],
]);

const DUAL_PREFIXES = ['AddExpressionAndCondition', 'addExpressionAndCondition'];
const PARAMETER_METHODS = new Set([
  'AddParameter',
  'addParameter',
  'AddCodeOnlyParameter',
  'addCodeOnlyParameter',
]);

const METHOD_CALL_RE = /\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g;

/** Position of the `)` matching the `(` at `openPos`, skipping strings and comments. */
function findMatchingParen(source: string, openPos: number): number {
  let depth = 0;
  let index = openPos;
  let inString: '"' | "'" | null = null;
  while (index < source.length) {
    const char = source[index];
    if (inString) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === inString) inString = null;
    } else if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
    } else if (char === '"' || char === "'") {
      inString = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** Split the arguments of a call at top-level commas (nested brackets respected). */
function splitTopLevelArgs(source: string, startInside: number, endExclusive: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let buffer = '';
  for (let index = startInside; index < endExclusive; index += 1) {
    const char = source[index] as string;
    if (inString) {
      buffer += char;
      if (char === '\\') {
        buffer += source[(index += 1)] ?? '';
        continue;
      }
      if (char === inString) inString = null;
    } else if (char === '"' || char === "'") {
      inString = char;
      buffer += char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      buffer += char;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      buffer += char;
    } else if (char === ',' && depth === 0) {
      args.push(buffer.trim());
      buffer = '';
    } else {
      buffer += char;
    }
  }
  if (buffer.trim()) args.push(buffer.trim());
  return args;
}

/** Unwrap `"…"`, `'…'`, `_('…')` / `_("…")` and `` `…` `` into the raw string. */
export function extractString(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  const trimmed = arg.trim();
  const doubleQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = /^'((?:[^'\\]|\\.)*)'$/.exec(trimmed);
  if (singleQuoted) return singleQuoted[1];
  const i18n = /^_\(\s*["']((?:[^"'\\]|\\.)*)["']\s*\)$/.exec(trimmed);
  if (i18n) return i18n[1];
  const template = /^`([^`$]*)`$/.exec(trimmed);
  if (template) return template[1];
  return undefined;
}

/** Identifier immediately before a `.` call, e.g. `extension` in `extension.AddAction(`. */
function receiverBefore(source: string, dotPos: number): string | undefined {
  let index = dotPos - 1;
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1;
  const end = index + 1;
  while (index >= 0 && /[A-Za-z0-9_]/.test(source[index] as string)) index -= 1;
  const start = index + 1;
  if (start === end) return undefined;
  const token = source.slice(start, end);
  return /^[0-9]/.test(token) ? undefined : token;
}

/** Normalize the receiver token into the gb2b receiver kinds. */
export function classifyReceiver(token: string | undefined): ReceiverKind {
  if (!token) return 'unknown';
  const known: Record<string, ReceiverKind> = {
    extension: 'extension',
    obj: 'object',
    object: 'object',
    objectMetadata: 'object',
    aut: 'behavior',
    behavior: 'behavior',
    behaviorMetadata: 'behavior',
  };
  const kind = known[token];
  if (kind) return kind;
  if (/Object$/.test(token) || /Obj$/.test(token)) return 'object';
  if (/Behavior$/.test(token) || /^aut/.test(token)) return 'behavior';
  return 'unknown';
}

interface MethodCall {
  index: number;
  methodName: string;
  closePos: number;
}

function collectMethodCalls(source: string): MethodCall[] {
  const calls: MethodCall[] = [];
  for (const match of source.matchAll(METHOD_CALL_RE)) {
    const index = match.index ?? 0;
    const openPos = index + match[0].length - 1;
    const closePos = findMatchingParen(source, openPos);
    if (closePos < 0) continue;
    calls.push({ index, methodName: match[1] as string, closePos });
  }
  return calls;
}

function toParameter(args: string[]): CatalogParameter | null {
  const type = extractString(args[0]);
  if (!type) return null;
  return {
    type,
    description: extractString(args[1]),
    extraInfo: extractString(args[2]),
    optional: args[3]?.trim() === 'true',
  };
}

function flush(out: ParsedInstruction[], instructions: (ParsedInstruction | null)[]): void {
  for (const instruction of instructions) {
    if (instruction && instruction.type) out.push(instruction);
  }
}

/** `.addObject('Name', …)` / `.addBehavior('Name', …)` / C++ `AddObject`/`AddBehavior`. */
function declarationFromCall(methodName: string, args: string[]): ParsedTypeDeclaration | null {
  const name = extractString(args[0]);
  if (!name) return null;
  if (methodName === 'addObject' || methodName === 'AddObject') return { name, kind: 'object' };
  if (methodName === 'addBehavior' || methodName === 'AddBehavior') return { name, kind: 'behavior' };
  if (methodName === 'addEventsBasedObject' || methodName === 'AddEventsBasedObject') {
    return { name, kind: 'eventsBasedObject' };
  }
  if (methodName === 'addEventsBasedBehavior' || methodName === 'AddEventsBasedBehavior') {
    return { name, kind: 'eventsBasedBehavior' };
  }
  return null;
}

const EVENTS_BASED_PATTERNS: { kind: TypeDeclarationKind; re: RegExp }[] = [
  { kind: 'eventsBasedObject', re: /[Ee]ventsBasedObject'?\s*[(:=]\s*['"]?([A-Za-z0-9_]*)/g },
  { kind: 'eventsBasedBehavior', re: /[Ee]ventsBasedBehavior'?\s*[(:=]\s*['"]?([A-Za-z0-9_]*)/g },
];

/** Marker-only detection of custom (events-based) declarations in a source file. */
export function detectEventsBasedDeclarations(source: string): ParsedTypeDeclaration[] {
  const declarations: ParsedTypeDeclaration[] = [];
  for (const { kind, re } of EVENTS_BASED_PATTERNS) {
    for (const match of source.matchAll(re)) {
      const captured = match[1];
      declarations.push({ name: captured && captured !== '' ? captured : '<events-based>', kind });
    }
  }
  return declarations;
}

/**
 * Parse one `Extension.cpp` / `JsExtension.js` / `.ts` source into instructions,
 * type declarations and the extension header. Both C++ and JS builder syntaxes
 * are accepted; the source of truth for the syntax is
 * `docs/research/gdevelop-mcp-catalogue-research.md` §1.
 */
export function parseExtensionSource(source: string): ParsedExtension {
  const instructions: ParsedInstruction[] = [];
  const typeDeclarations: ParsedTypeDeclaration[] = [];
  let name: string | null = null;
  let fullName: string | undefined;
  let description: string | undefined;
  let current: ParsedInstruction | null = null;
  let mirrors: ParsedInstruction[] = [];

  for (const call of collectMethodCalls(source)) {
    const openPos = source.indexOf('(', call.index);
    const args = splitTopLevelArgs(source, openPos + 1, call.closePos);

    if (call.methodName === 'SetExtensionInformation' || call.methodName === 'setExtensionInformation') {
      name = extractString(args[0]) ?? name;
      fullName = extractString(args[1]) ?? fullName;
      description = extractString(args[2]) ?? description;
      continue;
    }

    const declaration = declarationFromCall(call.methodName, args);
    if (declaration) {
      typeDeclarations.push(declaration);
      continue;
    }

    const kind = INSTRUCTION_METHODS.get(call.methodName);
    if (kind) {
      flush(instructions, [current, ...mirrors]);
      mirrors = [];
      current = {
        type: extractString(args[0]) ?? '',
        fullName: extractString(args[1]),
        description: extractString(args[2]),
        kind,
        receiver: receiverBefore(source, call.index),
        parameters: [],
      };
      continue;
    }

    if (DUAL_PREFIXES.some((prefix) => call.methodName.startsWith(prefix))) {
      flush(instructions, [current, ...mirrors]);
      const expressionKind: InstructionKind = extractString(args[0]) === 'string' ? 'strExpression' : 'expression';
      const receiver = receiverBefore(source, call.index);
      const base = {
        type: extractString(args[1]) ?? '',
        fullName: extractString(args[2]),
        description: extractString(args[3]),
        receiver,
      };
      current = { ...base, kind: expressionKind, parameters: [] };
      mirrors = [{ ...base, kind: 'condition', parameters: [] }];
      if (call.methodName.endsWith('AndAction')) {
        mirrors.push({ ...base, kind: 'action', parameters: [] });
      }
      continue;
    }

    if (current && PARAMETER_METHODS.has(call.methodName)) {
      const parameter = toParameter(args);
      if (parameter) {
        current.parameters.push(parameter);
        for (const mirror of mirrors) mirror.parameters.push(parameter);
      }
    }
  }
  flush(instructions, [current, ...mirrors]);

  for (const declaration of detectEventsBasedDeclarations(source)) typeDeclarations.push(declaration);

  const parsed: ParsedExtension = { name, instructions, typeDeclarations };
  if (fullName !== undefined) parsed.fullName = fullName;
  if (description !== undefined) parsed.description = description;
  return parsed;
}

