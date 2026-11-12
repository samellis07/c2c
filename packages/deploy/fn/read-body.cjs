'use strict';
/**
 * Request body reading for the c2c_api entry. Split from index.js so the
 * generated-host contract tests can drive the exact code the host runs:
 * the decoded original JSON bytes are captured into req.rawBody BEFORE
 * JSON.parse, covering string, Buffer, and streamed bodies, chunked
 * transfer, and gzip/deflate content encodings (the captured bytes are the
 * decoded wire bytes, never the compressed stream and never a
 * re-serialization of the parsed object). A host that already parsed the
 * body leaves req.rawBody unset so downstream handlers fail closed.
 */
const zlib = require('node:zlib');

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Wrap every integer literal outside a string that is not a safe integer in
 * quotes, so JSON.parse keeps a 19-digit Creator id or a 17-digit ROWID exact.
 * Same algorithm as packages/shims/src/ids.ts quoteUnsafeIntegers.
 */
function quoteUnsafeIntegers(text) {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i += 1;
      const token = text.slice(start, i);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `${text.slice(last, start)}"${token}"`;
        last = i;
      }
      continue;
    }
    i += 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Return the normalized request media type without parameters. */
function requestMediaType(req) {
  const headers = req && typeof req.headers === 'object' ? req.headers : {};
  const value = headers['content-type'] ?? headers['Content-Type'];
  return String(Array.isArray(value) ? value[0] ?? '' : (value ?? ''))
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

/** 'gzip', 'deflate', 'identity', or null when the declared encoding is not one the host can decode. */
function contentEncoding(req) {
  const headers = req && typeof req.headers === 'object' ? req.headers : {};
  const value = headers['content-encoding'] ?? headers['Content-Encoding'];
  const text = String(Array.isArray(value) ? value[0] ?? '' : (value ?? ''))
    .trim()
    .toLowerCase();
  if (!text || text === 'identity') return 'identity';
  if (text === 'gzip' || text === 'x-gzip') return 'gzip';
  if (text === 'deflate') return 'deflate';
  return null;
}

function declaredLength(req) {
  const headers = req && typeof req.headers === 'object' ? req.headers : {};
  const value = headers['content-length'] ?? headers['Content-Length'];
  if (value === undefined || value === null) return null;
  // Every value of a repeated or comma-joined header counts: the largest wins and
  // any conflicting or non-numeric value is refused, never read as "first only".
  const tokens = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((t) => t.trim());
  if (!tokens.length || tokens.some((t) => !/^[0-9]+$/.test(t))) {
    throw Object.assign(new Error('invalid content-length'), { status: 400 });
  }
  const numbers = tokens.map((t) => (t.length > 15 ? Number.POSITIVE_INFINITY : Number(t)));
  if (new Set(numbers).size > 1) throw Object.assign(new Error('conflicting content-length'), { status: 400 });
  return numbers[0];
}

function inflate(encoding, buffer) {
  try {
    // Bound the DECODED size inside zlib so a tiny bomb never allocates past the cap.
    const options = { maxOutputLength: MAX_BODY_BYTES + 1 };
    return encoding === 'gzip' ? zlib.gunzipSync(buffer, options) : zlib.inflateSync(buffer, options);
  } catch (err) {
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw Object.assign(new Error('request body too large'), { status: 413 });
    throw Object.assign(new Error(`request body is not valid ${encoding} data`), { status: 400 });
  }
}

async function readBody(req) {
  // Simple cross-site form content types do not require CORS preflight. Refuse
  // them on writes so cookie-authenticated requests cannot reach a handler.
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && requestMediaType(req) !== 'application/json') {
    throw Object.assign(new Error('content type must be application/json'), { status: 415 });
  }
  const encoding = contentEncoding(req);
  if (encoding === null) {
    throw Object.assign(new Error('content encoding is not supported'), { status: 415 });
  }
  // The declared wire length is checked before any bytes are read or decoded:
  // an oversized claim is refused outright, whatever the actual body holds.
  const declared = declaredLength(req);
  if (declared !== null && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body too large'), { status: 413 });
  }
  // Every body is a JSON object: an array, a string or a number is a 400, never
  // read as an empty body. A body a runtime already read is held to the same
  // byte cap as a streamed one.
  const notObject = () => Object.assign(new Error('request body must be a JSON object'), { status: 400 });
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Array.isArray(req.body)) throw notObject();
    // A parsed body has lost the original member order and duplicate keys.  Do
    // not synthesize bytes from it: client-call handlers must fail closed when
    // the host cannot provide the decoded wire body.
    return req.body;
  }
  const tooLarge = () => Object.assign(new Error('request body too large'), { status: 413 });
  let raw = '';
  if (typeof req.body === 'string') {
    // A string body is already decoded text; it cannot carry compressed bytes.
    if (encoding !== 'identity') {
      throw Object.assign(new Error('encoded request body must arrive as bytes'), { status: 400 });
    }
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw tooLarge();
    raw = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_BODY_BYTES) throw tooLarge();
    const decoded = encoding === 'identity' ? req.body : inflate(encoding, req.body);
    if (decoded.length > MAX_BODY_BYTES) throw tooLarge();
    raw = decoded.toString('utf8');
  } else {
    let size = 0;
    const chunks = [];
    // The stream carries the wire bytes; decode before counting or parsing so
    // the cap and req.rawBody both measure what the handler sees.
    const source = encoding === 'identity' ? req : req.pipe(zlib.createUnzip());
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw tooLarge();
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch (err) {
      if (err && err.status) throw err;
      throw Object.assign(new Error(`request body is not valid ${encoding} data`), { status: 400 });
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  // Capture the decoded bytes before JSON.parse.  This is deliberately the
  // post-decompression stream supplied by the host, not a re-serialization of
  // the parsed object.
  req.rawBody = raw;
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(quoteUnsafeIntegers(raw));
  } catch {
    throw Object.assign(new Error('request body is not JSON'), { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw notObject();
  return parsed;
}

module.exports = { MAX_BODY_BYTES, quoteUnsafeIntegers, requestMediaType, readBody };
