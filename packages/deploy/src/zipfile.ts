/**
 * Minimal ZIP reader for archives handed to the CLI (a Creator app backup is a
 * zip holding more zips). Central-directory driven: stored and deflate members
 * only, no external tool is spawned.
 *
 * Guards run before any decompression: entry-count and byte caps, refusal of
 * zip-slip names, absolute paths, backslash separators, multi-disk archives,
 * encrypted or ZIP64 members, symlink and other special-file modes, members
 * whose declared sizes disagree with what inflate produced, and a deflate
 * ratio cap so a tiny packed stream cannot fan out into gigabytes.
 *
 * Integrity and structure are cross-checked, not trusted: every member's data
 * must match the central-directory CRC-32 (and the local header's when the
 * local record carries one), the local header's name/method/sizes must agree
 * with the central directory, two entries may not point at the same local
 * record, and walking the declared entry count must consume the directory
 * exactly.
 *
 * Nested archives share one byte budget: pass the same ZipBudget to the outer
 * archive and every inner archive and their combined inflated bytes are
 * capped by maxTotalBytes.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Archive path, '/'-separated, relative to the archive root. */
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  /** Refuse an archive holding more entries. Default 4096. */
  maxEntries?: number;
  /** Refuse a member whose declared uncompressed size exceeds this. Default 64 MiB. */
  maxEntryBytes?: number;
  /** Refuse when declared uncompressed sizes total more than this. Default 512 MiB. */
  maxTotalBytes?: number;
  /** Refuse a deflate member declaring more than this times its packed size. Default 100. */
  maxInflateRatio?: number;
}

/**
 * Byte accounting shared across nested archives. Each member's inflated bytes
 * accumulate in `used`; the running total may not exceed maxTotalBytes.
 */
export interface ZipBudget {
  used: number;
}

export interface ZipArchive {
  /** Member names in central-directory order, directory entries dropped. */
  names: string[];
  /** Whether the archive holds a member with this exact name. */
  has(name: string): boolean;
  /**
   * Inflate one member on demand. The returned buffer is not retained by the
   * archive, so a caller can drop it before reading the next member.
   */
  read(name: string): Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_LEN = 22;
const EOCD_SEARCH = EOCD_LEN + 0xffff;

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_ENTRY = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 512 * 1024 * 1024;
const DEFAULT_MAX_RATIO = 100;

const ZIP64 = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DATA_DESCRIPTOR = 0x8;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function fail(reason: string): never {
  throw new Error(`zip: ${reason}`);
}

/** A member name must stay a relative path inside the archive. */
export function checkZipName(name: string): string {
  if (!name.length || name.includes('\x00')) fail('an entry name is empty or holds a NUL');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail(`entry ${JSON.stringify(name)} is an absolute path`);
  if (name.includes('\\')) fail(`entry ${JSON.stringify(name)} uses a backslash separator`);
  if (name.split('/').some((part) => part === '..')) fail(`entry ${JSON.stringify(name)} escapes the archive root`);
  return name;
}

function endOfCentralDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let at = bytes.length - EOCD_LEN; at >= floor; at--) {
    if (bytes.readUInt32LE(at) !== EOCD_SIG) continue;
    const comment = bytes.readUInt16LE(at + 20);
    if (at + EOCD_LEN + comment === bytes.length) return at;
  }
  fail('no end-of-central-directory record');
}

interface Member {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

function centralMembers(bytes: Buffer, limits: Required<ZipLimits>): Member[] {
  const eocd = endOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const dirDisk = bytes.readUInt16LE(eocd + 6);
  const here = bytes.readUInt16LE(eocd + 8);
  const total = bytes.readUInt16LE(eocd + 10);
  const dirSize = bytes.readUInt32LE(eocd + 12);
  const dirOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || dirDisk !== 0 || here !== total) fail('multi-disk archives are not supported');
  if (dirOffset === ZIP64 || dirSize === ZIP64) fail('ZIP64 archives are not supported');
  if (dirOffset + dirSize > eocd) fail('the central directory runs past the archive end');
  if (total > limits.maxEntries) fail(`${total} entries exceeds the ${limits.maxEntries} entry limit`);
  const members: Member[] = [];
  const offsets = new Set<number>();
  let at = dirOffset;
  for (let i = 0; i < total; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) fail('the central directory is truncated');
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const startDisk = bytes.readUInt16LE(at + 34);
    const attrs = bytes.readUInt32LE(at + 38);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.slice(at + 46, at + 46 + nameLength).toString('utf8');
    if (startDisk !== 0) fail(`entry ${JSON.stringify(name)} starts on another disk`);
    if (flags & FLAG_ENCRYPTED) fail(`entry ${JSON.stringify(name)} is encrypted`);
    if (compressed === ZIP64 || size === ZIP64 || offset === ZIP64) fail(`entry ${JSON.stringify(name)} uses ZIP64`);
    if (method !== 0 && method !== 8) fail(`entry ${JSON.stringify(name)} uses compression method ${method}`);
    if (size > limits.maxEntryBytes) fail(`entry ${JSON.stringify(name)} declares ${size} bytes (limit ${limits.maxEntryBytes})`);
    const mode = (attrs >>> 16) & S_IFMT;
    if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
      fail(`entry ${JSON.stringify(name)} is a ${mode === S_IFLNK ? 'symbolic link' : 'special file'}, not a regular file`);
    }
    checkZipName(name);
    if (!name.endsWith('/')) {
      if (offsets.has(offset)) fail(`entry ${JSON.stringify(name)} points at a local record another entry already claims`);
      offsets.add(offset);
    }
    members.push({ name, method, flags, crc, compressed, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== dirOffset + dirSize) fail('the EOCD entry count does not span the whole central directory');
  return members;
}

function memberData(bytes: Buffer, member: Member, limits: Required<ZipLimits>, budget: ZipBudget | undefined): Buffer {
  const at = member.offset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== LOCAL_SIG) {
    fail(`entry ${JSON.stringify(member.name)} has no local header at its offset`);
  }
  const localMethod = bytes.readUInt16LE(at + 8);
  if (localMethod !== member.method) {
    fail(`entry ${JSON.stringify(member.name)} uses local method ${localMethod} but the directory says ${member.method}`);
  }
  const nameLength = bytes.readUInt16LE(at + 26);
  const extraLength = bytes.readUInt16LE(at + 28);
  const localName = bytes.slice(at + 30, at + 30 + nameLength).toString('utf8');
  if (localName !== member.name) {
    fail(`entry ${JSON.stringify(member.name)} is named ${JSON.stringify(localName)} in its local header`);
  }
  if (!(member.flags & FLAG_DATA_DESCRIPTOR)) {
    const localCrc = bytes.readUInt32LE(at + 14);
    const localCompressed = bytes.readUInt32LE(at + 18);
    const localSize = bytes.readUInt32LE(at + 22);
    if (localCrc !== member.crc || localCompressed !== member.compressed || localSize !== member.size) {
      fail(`entry ${JSON.stringify(member.name)} has a local header that disagrees with the central directory`);
    }
  }
  const start = at + 30 + nameLength + extraLength;
  if (start + member.compressed > bytes.length) fail(`entry ${JSON.stringify(member.name)} runs past the archive end`);
  const packed = bytes.slice(start, start + member.compressed);
  let data: Buffer;
  if (member.method === 0) {
    data = packed;
  } else {
    if (member.compressed > 0 && member.size > member.compressed * limits.maxInflateRatio) {
      fail(`entry ${JSON.stringify(member.name)} declares ${member.size} bytes from ${member.compressed} packed (ratio cap ${limits.maxInflateRatio})`);
    }
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(packed, { maxOutputLength: member.size + 1 });
    } catch {
      fail(`entry ${JSON.stringify(member.name)} does not inflate`);
    }
    data = inflated;
  }
  if (data.length !== member.size) {
    fail(`entry ${JSON.stringify(member.name)} declared ${member.size} bytes but holds ${data.length}`);
  }
  if (crc32(data) !== member.crc) fail(`entry ${JSON.stringify(member.name)} fails its CRC-32 check`);
  if (budget) {
    budget.used += data.length;
    if (budget.used > limits.maxTotalBytes) {
      fail(`inflated members across the archive exceed the ${limits.maxTotalBytes} byte budget`);
    }
  }
  return data;
}

function resolveLimits(limits: ZipLimits): Required<ZipLimits> {
  return {
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL,
    maxInflateRatio: limits.maxInflateRatio ?? DEFAULT_MAX_RATIO,
  };
}

/**
 * Open an archive without inflating anything: the central directory is parsed
 * and checked up front, and each member inflates on `read`. Nothing is cached,
 * so a member buffer is released when the caller drops it.
 */
export function openZip(bytes: Buffer, limits: ZipLimits = {}, budget?: ZipBudget): ZipArchive {
  const resolved = resolveLimits(limits);
  const members = centralMembers(bytes, resolved);
  let totalBytes = 0;
  const files = new Map<string, Member>();
  const names: string[] = [];
  for (const member of members) {
    totalBytes += member.size;
    if (totalBytes > resolved.maxTotalBytes) fail(`declared sizes total more than ${resolved.maxTotalBytes} bytes`);
    if (member.name.endsWith('/')) continue;
    if (files.has(member.name)) fail(`entry ${JSON.stringify(member.name)} appears twice`);
    files.set(member.name, member);
    names.push(member.name);
  }
  return {
    names,
    has: (name) => files.has(name),
    read: (name) => {
      const member = files.get(name);
      if (!member) fail(`no member ${JSON.stringify(name)}`);
      return memberData(bytes, member, resolved, budget);
    },
  };
}

/**
 * Every member of the archive, in central-directory order. Directory entries
 * (trailing '/') are dropped. A repeated member name is refused.
 */
export function readZip(bytes: Buffer, limits: ZipLimits = {}, budget?: ZipBudget): ZipEntry[] {
  const archive = openZip(bytes, limits, budget);
  return archive.names.map((name) => ({ name, data: archive.read(name) }));
}
