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
 * rather than read in part, and so is one that unpacks to more than `maxBytes` in a file.
 */
export function zipEntries(zip: Buffer, maxBytes: number): ZipEntry[] {
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
      entries.push({ name, content: entryContent(zip, method, localOffset, compressedSize, maxBytes) });
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

function holdsSecret(content: Buffer, secret: string): boolean {
  return [secret, goJsonForm(secret)].some((form) => content.includes(form));
}

function isGzip(content: Buffer): boolean {
  return content.length > 2 && content[0] === 0x1f && content[1] === 0x8b;
}

/** A file as searched: a gzipped one, as Go writes its profiles, unpacked too; one that cannot be unpacked counts as holding a secret. */
function searchedForms(content: Buffer, maxBytes: number): Buffer[] | null {
  if (!isGzip(content)) return [content];
  try {
    return [content, gunzipSync(content, { maxOutputLength: maxBytes })];
  } catch {
    return null;
  }
}

/** The names of the bundle's files that hold one of `secrets`, as written or as JSON writes it, or that cannot be searched whole. */
export function filesHoldingSecrets(entries: readonly ZipEntry[], secrets: readonly string[], maxBytes: number): string[] {
  return entries
    .filter((entry) => {
      const forms = searchedForms(entry.content, maxBytes);
      return forms === null || forms.some((form) => secrets.some((secret) => holdsSecret(form, secret)));
    })
    .map((entry) => entry.name);
}
