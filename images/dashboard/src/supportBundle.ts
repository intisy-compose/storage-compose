import { gunzipSync, inflateRawSync } from "node:zlib";

/** One file of a zip archive, decompressed. */
export interface ZipEntry {
  name: string;
  content: Buffer;
}

export class UnreadableZip extends Error {}

const endOfDirectorySignature = 0x06054b50;
const directoryEntrySignature = 0x02014b50;
const localHeaderSignature = 0x04034b50;
const endOfDirectoryLength = 22;
const longestComment = 0xffff;
const zip64Marker = 0xffffffff;
const storedMethod = 0;
const deflatedMethod = 8;

function endOfDirectoryAt(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - endOfDirectoryLength - longestComment);
  for (let offset = zip.length - endOfDirectoryLength; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) === endOfDirectorySignature) return offset;
  }
  throw new UnreadableZip("no end of the central directory");
}

function entryContent(zip: Buffer, method: number, localOffset: number, compressedSize: number, maxBytes: number): Buffer {
  if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== localHeaderSignature) throw new UnreadableZip("a file header is missing");
  const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  if (dataStart + compressedSize > zip.length) throw new UnreadableZip("a file runs past the archive");
  const data = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === storedMethod) return data;
  if (method === deflatedMethod) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new UnreadableZip(`compression method ${method}`);
}

/**
 * Every file of a zip archive, read from its central directory.
 * @implNote Go's `archive/zip`, which writes Syncthing's support bundle, puts the sizes of a streamed file only in its data descriptor and
 * the central directory, so the sizes are taken from there. An archive this reader does not know (zip64, another compression) is refused
 * rather than read in part, and so is one whose files unpack to more than `maxBytes` together.
 */
export function zipEntries(zip: Buffer, maxBytes: number): ZipEntry[] {
  let unpacked = 0;
  if (zip.length < endOfDirectoryLength) throw new UnreadableZip("too short for a zip archive");
  const end = endOfDirectoryAt(zip);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== directoryEntrySignature) throw new UnreadableZip("the central directory is broken");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    if (compressedSize === zip64Marker || localOffset === zip64Marker) throw new UnreadableZip("zip64 archives are not read");
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    try {
      const content = entryContent(zip, method, localOffset, compressedSize, maxBytes - unpacked);
      unpacked += content.length;
      entries.push({ name, content });
    } catch (error) {
      if (error instanceof UnreadableZip) throw error;
      throw new UnreadableZip(`${name}: ${(error as Error).message}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const secretKey = /password|apikey/i;

/** Every non-empty value of a key that names a password or an API key, anywhere in Syncthing's configuration. */
export function configSecrets(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(configSecrets);
  if (typeof config !== "object" || config === null) return [];
  return Object.entries(config).flatMap(([key, value]) => (secretKey.test(key) && typeof value === "string" && value ? [value] : configSecrets(value)));
}

/** A secret as it reads in a JSON file that Go wrote, which escapes `<`, `>` and `&` besides what JSON must. */
function goJsonForm(secret: string): string {
  return JSON.stringify(secret)
    .slice(1, -1)
    .replace(/[<>&]/g, (character) => `\\u00${character.charCodeAt(0).toString(16)}`);
}

const xmlEntities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function xmlForm(secret: string): string {
  return secret.replace(/[&<>"']/g, (character) => xmlEntities[character]);
}

/** Every way a secret can read in a file: as written, as Go writes it into JSON, as XML escapes it. */
export function secretForms(secret: string): string[] {
  return [...new Set([secret, goJsonForm(secret), xmlForm(secret)])];
}

export function holdsSecret(content: Buffer, secret: string): boolean {
  return secretForms(secret).some((form) => content.includes(form));
}

/** Each secret, in every form it can be written in, replaced by `[redacted]`; the longest forms go first, so no part of one is left. */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  const forms = secrets.flatMap(secretForms).sort((left, right) => right.length - left.length);
  return forms.reduce((current, form) => current.split(form).join("[redacted]"), text);
}

function isGzip(content: Buffer): boolean {
  return content.length > 2 && content[0] === 0x1f && content[1] === 0x8b;
}

const archiveMagics = [Buffer.from("PK\x03\x04", "latin1"), Buffer.from([0x1f, 0x8b]), Buffer.from("BZh"), Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])];

/** Whether the content is itself an archive or compressed (zip, gzip, bzip2, xz, zstd, 7z), which a plain search cannot see into. */
function isPacked(content: Buffer): boolean {
  return archiveMagics.some((magic) => content.subarray(0, magic.length).equals(magic));
}

/**
 * A file as searched: a gzipped one, as Go writes its profiles, unpacked once too.
 * @implNote Null, which counts as holding a secret, for a file that cannot be unpacked, or that is or unpacks to another archive.
 */
function searchedForms(content: Buffer, maxBytes: number): Buffer[] | null {
  if (!isGzip(content)) return isPacked(content) ? null : [content];
  try {
    const unpacked = gunzipSync(content, { maxOutputLength: maxBytes });
    return isPacked(unpacked) ? null : [content, unpacked];
  } catch {
    return null;
  }
}

/** The names of the bundle's files that hold one of `secrets`, in any form it can be written in, or that cannot be searched whole. */
export function filesHoldingSecrets(entries: readonly ZipEntry[], secrets: readonly string[], maxBytes: number): string[] {
  return entries
    .filter((entry) => {
      const forms = searchedForms(entry.content, maxBytes);
      return forms === null || forms.some((form) => secrets.some((secret) => holdsSecret(form, secret)));
    })
    .map((entry) => entry.name);
}
