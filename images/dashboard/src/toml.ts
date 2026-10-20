/**
 * The TOML the stack reads and writes: tables with bare or quoted dotted names, arrays of tables, and
 * values that are strings (basic or literal), integers, floats, booleans or arrays of those, arrays
 * possibly over several lines. Enough for `.storage/node.toml`, `nodes.toml`, `array.toml` and the
 * setup repo's `drive-sync.toml`, so the image needs no TOML package.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {}

class Reader {
  position = 0;
  line = 1;

  constructor(readonly text: string) {}

  get done(): boolean {
    return this.position >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text[this.position + offset] ?? "";
  }

  next(): string {
    const character = this.text[this.position++] ?? "";
    if (character === "\n") this.line++;
    return character;
  }

  fail(message: string): never {
    throw new TomlError(`line ${this.line}: ${message}`);
  }

  skipBlanks(): void {
    while (this.peek() === " " || this.peek() === "\t") this.next();
  }

  skipComment(): void {
    if (this.peek() === "#") while (!this.done && this.peek() !== "\n") this.next();
  }

  /** Blanks, comments and line breaks, as allowed inside an array. */
  skipWhitespace(): void {
    for (;;) {
      this.skipBlanks();
      this.skipComment();
      if (this.peek() === "\n" || this.peek() === "\r") this.next();
      else return;
    }
  }

  endOfLine(): void {
    this.skipBlanks();
    this.skipComment();
    if (this.peek() === "\r") this.next();
    if (!this.done && this.next() !== "\n") this.fail("expected the end of the line");
  }
}

const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function readBasicString(reader: Reader): string {
  reader.next();
  let value = "";
  for (;;) {
    if (reader.peek() === "" || reader.peek() === "\n") reader.fail("unterminated string");
    const character = reader.next();
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = reader.next();
    if (escaped === "u" || escaped === "U") {
      const length = escaped === "u" ? 4 : 8;
      const hex = reader.text.slice(reader.position, reader.position + length);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) reader.fail("bad unicode escape");
      reader.position += length;
      value += String.fromCodePoint(parseInt(hex, 16));
    } else if (escaped in escapes) {
      value += escapes[escaped];
    } else {
      reader.fail(`unknown escape \\${escaped}`);
    }
  }
}

function readLiteralString(reader: Reader): string {
  reader.next();
  const end = reader.text.indexOf("'", reader.position);
  const lineEnd = reader.text.indexOf("\n", reader.position);
  if (end < 0 || (lineEnd >= 0 && lineEnd < end)) reader.fail("unterminated string");
  const value = reader.text.slice(reader.position, end);
  reader.position = end + 1;
  return value;
}

function readKeyPart(reader: Reader): string {
  if (reader.peek() === '"') return readBasicString(reader);
  if (reader.peek() === "'") return readLiteralString(reader);
  let key = "";
  while (/[A-Za-z0-9_-]/.test(reader.peek())) key += reader.next();
  if (!key) reader.fail("expected a key");
  return key;
}

function readDottedKey(reader: Reader): string[] {
  const parts = [readKeyPart(reader)];
  for (;;) {
    reader.skipBlanks();
    if (reader.peek() !== ".") return parts;
    reader.next();
    reader.skipBlanks();
    parts.push(readKeyPart(reader));
  }
}

function readArray(reader: Reader): TomlValue[] {
  reader.next();
  const values: TomlValue[] = [];
  for (;;) {
    reader.skipWhitespace();
    if (reader.peek() === "]") {
      reader.next();
      return values;
    }
    values.push(readValue(reader));
    reader.skipWhitespace();
    if (reader.peek() === ",") reader.next();
    else if (reader.peek() !== "]") reader.fail("expected , or ] in an array");
  }
}

function readScalar(reader: Reader): number | boolean {
  let token = "";
  while (/[A-Za-z0-9_.+-]/.test(reader.peek())) token += reader.next();
  if (token === "true") return true;
  if (token === "false") return false;
  const number = Number(token.replace(/_/g, ""));
  if (token === "" || Number.isNaN(number)) reader.fail(`unreadable value '${token}'`);
  return number;
}

function readValue(reader: Reader): TomlValue {
  const start = reader.peek();
  if (start === '"') return readBasicString(reader);
  if (start === "'") return readLiteralString(reader);
  if (start === "[") return readArray(reader);
  return readScalar(reader);
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tableAt(root: TomlTable, path: string[], reader: Reader): TomlTable {
  let table = root;
  for (const part of path) {
    let child = table[part];
    if (child === undefined) table[part] = child = {};
    if (Array.isArray(child)) child = child[child.length - 1];
    if (!isTable(child)) reader.fail(`${path.join(".")} is not a table`);
    table = child;
  }
  return table;
}

export function parseToml(text: string): TomlTable {
  const reader = new Reader(text);
  const root: TomlTable = {};
  let current = root;
  while (!reader.done) {
    reader.skipWhitespace();
    if (reader.done) break;
    if (reader.peek() === "[") {
      const isArrayOfTables = reader.peek(1) === "[";
      reader.next();
      if (isArrayOfTables) reader.next();
      reader.skipBlanks();
      const path = readDottedKey(reader);
      if (reader.next() !== "]" || (isArrayOfTables && reader.next() !== "]")) reader.fail("unclosed table header");
      if (isArrayOfTables) {
        const parent = tableAt(root, path.slice(0, -1), reader);
        const name = path[path.length - 1];
        const list = (parent[name] ?? (parent[name] = [])) as TomlValue[];
        if (!Array.isArray(list)) reader.fail(`${path.join(".")} is not an array of tables`);
        current = {};
        list.push(current);
      } else {
        current = tableAt(root, path, reader);
      }
      reader.endOfLine();
      continue;
    }
    const key = readDottedKey(reader);
    reader.skipBlanks();
    if (reader.next() !== "=") reader.fail("expected =");
    reader.skipBlanks();
    const table = tableAt(current, key.slice(0, -1), reader);
    table[key[key.length - 1]] = readValue(reader);
    reader.endOfLine();
  }
  return root;
}

export function formatTomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  throw new TomlError("a table cannot be written as a value here");
}

/** `key = value` lines with the `=` signs aligned, in the order of `keys`, leaving out unset keys. */
export function formatPairs(table: TomlTable, keys: string[]): string[] {
  const present = keys.filter((key) => table[key] !== undefined && table[key] !== null);
  const width = Math.max(0, ...present.map((key) => key.length));
  return present.map((key) => `${key.padEnd(width)} = ${formatTomlValue(table[key])}`);
}
