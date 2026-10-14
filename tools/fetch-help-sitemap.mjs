#!/usr/bin/env node
/**
 * Polite Creator-help sitemap crawl.
 * At most one HTTP request per 2 seconds (longer if robots Crawl-delay says so).
 * Obeys robots.txt on every redirect hop. Only https://www.zoho.com/ is fetched.
 * A skipped hop marks the crawl incomplete.
 * Writes the crawl manifest. Coverage claims come only from that file.
 * --matrix fills section rowIds where a row doc_url matches a crawled URL exactly.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://www.zoho.com';
const HELP_PREFIXES = ['/creator/help/', '/creator/newhelp/'];
const USER_AGENT = 'c2c-matrix-fetch/0.1 (+creator-to-catalyst feature matrix; polite)';
const MIN_INTERVAL_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || current.locked) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null, locked: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    current.locked = true;
    if (key === 'allow') current.allow.push(value);
    else if (key === 'disallow') current.disallow.push(value);
    else if (key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.crawlDelay = delay;
    }
  }
  return { groups, sitemaps };
}

function ruleToRegExp(rule) {
  if (!rule) return null;
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function pathAllowed(pathname, group) {
  if (!group) return true;
  let bestLen = -1;
  let allowed = true;
  const consider = (rule, isAllow) => {
    if (rule === '') {
      if (isAllow) return;
      if (bestLen < 0) {
        bestLen = 0;
        allowed = true;
      }
      return;
    }
    const re = ruleToRegExp(rule);
    if (!re || !re.test(pathname)) return;
    const len = rule.length;
    if (len > bestLen || (len === bestLen && isAllow)) {
      bestLen = len;
      allowed = isAllow;
    }
  };
  for (const rule of group.disallow) consider(rule, false);
  for (const rule of group.allow) consider(rule, true);
  return allowed;
}

function selectGroup(groups) {
  const agent = USER_AGENT.toLowerCase();
  const exact = groups.find((group) => group.agents.some((name) => name === agent || agent.startsWith(name)));
  if (exact && exact.agents.some((name) => name !== '*')) return exact;
  return groups.find((group) => group.agents.includes('*')) || null;
}

function sameOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'www.zoho.com';
  } catch {
    return false;
  }
}

function helpPrefix(urlPath) {
  return HELP_PREFIXES.find((prefix) => urlPath.startsWith(prefix)) || null;
}

export function sectionIdFor(urlPath) {
  const prefix = helpPrefix(urlPath);
  if (!prefix) return null;
  let rest = urlPath.slice(prefix.length);
  if (!rest || rest.startsWith('?')) return null;
  rest = rest.split('?')[0].replace(/\/+$/, '');
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last.includes('.')) parts.pop();
  if (parts.length === 0) return null;
  const id = parts.join('/');
  return prefix === '/creator/newhelp/' ? `newhelp/${id}` : id;
}

function isCreatorSitemap(url) {
  try {
    return new URL(url).pathname.startsWith('/creator/');
  } catch {
    return false;
  }
}

function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

class PoliteFetcher {
  constructor(intervalMs, fetchImpl, maxRequests) {
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.maxRequests = maxRequests;
    this.last = 0;
    this.count = 0;
    this.isAllowed = null;
    this.skippedHop = false;
    this.truncated = false;
  }

  setIntervalMs(intervalMs) {
    this.intervalMs = Math.max(this.intervalMs, intervalMs);
  }

  async pace() {
    const wait = this.last === 0 ? 0 : this.intervalMs - (Date.now() - this.last);
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    this.count += 1;
  }

  async get(url) {
    let current = url;
    for (let hop = 0; hop < 8; hop += 1) {
      if (!sameOrigin(current) || (this.isAllowed && !this.isAllowed(current))) {
        this.skippedHop = true;
        return null;
      }
      if (this.maxRequests && this.count >= this.maxRequests) {
        this.truncated = true;
        return null;
      }
      await this.pace();
      const response = await this.fetchImpl(current, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain, application/xml, text/xml, */*' },
        redirect: 'manual',
      });
      const status = response.status;
      if (status >= 300 && status < 400 && status !== 304) {
        const location = response.headers.get('location');
        if (!location) {
          this.skippedHop = true;
          return null;
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`${status} ${current}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const body = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
        ? zlib.gunzipSync(bytes)
        : bytes;
      return body.toString('utf8');
    }
    this.skippedHop = true;
    return null;
  }
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1].replace(/&amp;/g, '&'));
}

export { MIN_INTERVAL_MS };

export async function crawlHelpSitemap(options) {
  const maxRequests = options.maxRequests;
  const matrixRows = options.matrixRows || [];
  const fetcher = new PoliteFetcher(options.intervalMs, options.fetchImpl || globalThis.fetch, maxRequests);
  const robotsText = await fetcher.get(`${ORIGIN}/robots.txt`);
  if (robotsText == null) {
    return {
      version: 1,
      source: `${ORIGIN}/creator/help/`,
      fetchedAt: new Date().toISOString(),
      complete: false,
      minIntervalMs: fetcher.intervalMs,
      robotsRespected: true,
      requests: fetcher.count,
      note: 'skipped a redirect hop while fetching robots.txt',
      sections: [],
    };
  }
  const parsed = parseRobots(robotsText);
  const group = selectGroup(parsed.groups);
  if (group?.crawlDelay) fetcher.setIntervalMs(Math.max(options.intervalMs, group.crawlDelay * 1000));
  const requests = () => fetcher.count;

  const allowed = (url) => {
    if (!sameOrigin(url)) return false;
    const pathname = new URL(url).pathname;
    return pathAllowed(pathname, group);
  };
  fetcher.isAllowed = allowed;

  if (HELP_PREFIXES.every((prefix) => !pathAllowed(prefix, group))) {
    return {
      version: 1,
      source: `${ORIGIN}/creator/help/`,
      fetchedAt: new Date().toISOString(),
      complete: false,
      minIntervalMs: fetcher.intervalMs,
      robotsRespected: true,
      note: 'robots.txt disallows Creator help',
      sections: [],
    };
  }

  let seeds = parsed.sitemaps
    .filter((url) => sameOrigin(url) && allowed(url))
    .sort((a, b) => Number(!a.includes('creator')) - Number(!b.includes('creator')));
  const seenSitemaps = new Set();
  const pageUrls = [];
  let truncated = false;

  async function takeSitemap(url) {
    if (seenSitemaps.has(url)) return;
    seenSitemaps.add(url);
    if (requests() >= maxRequests) {
      truncated = true;
      return;
    }
    if (!allowed(url)) return;
    const xml = await fetcher.get(url);
    if (xml == null) return;
    const locs = sitemapLocs(xml);
    const childSitemaps = [];
    for (const loc of locs) {
      if (!sameOrigin(loc)) continue;
      const pathname = new URL(loc).pathname;
      if (pathname.endsWith('.xml') || pathname.endsWith('.xml.gz')) {
        if (isCreatorSitemap(loc)) childSitemaps.push(loc);
      } else if (helpPrefix(pathname) && pathAllowed(pathname, group)) pageUrls.push(loc);
    }
    childSitemaps.sort((a, b) => Number(!a.includes('creator')) - Number(!b.includes('creator')));
    for (const child of childSitemaps) {
      if (requests() >= maxRequests) {
        truncated = true;
        break;
      }
      await takeSitemap(child);
    }
  }

  if (seeds.length === 0 && allowed(`${ORIGIN}/sitemap.xml`)) seeds = [`${ORIGIN}/sitemap.xml`];
  for (const seed of seeds) {
    if (requests() >= maxRequests) {
      truncated = true;
      break;
    }
    await takeSitemap(seed);
  }

  const byDocUrl = new Map();
  for (const row of matrixRows) {
    if (!row || !row.doc_url || row.id === undefined) continue;
    try {
      const key = normalizeUrl(row.doc_url);
      if (!byDocUrl.has(key)) byDocUrl.set(key, []);
      byDocUrl.get(key).push(row.id);
    } catch {
      // Rows with odd doc_urls simply do not match the crawl.
    }
  }

  const sections = new Map();
  for (const pageUrl of pageUrls) {
    let parsedUrl;
    try {
      parsedUrl = new URL(pageUrl);
    } catch {
      continue;
    }
    if (!allowed(pageUrl)) continue;
    const id = sectionIdFor(parsedUrl.pathname);
    if (!id) continue;
    if (!sections.has(id)) {
      sections.set(id, {
        id,
        url: id.startsWith('newhelp/')
          ? `${ORIGIN}/creator/newhelp/${id.slice('newhelp/'.length)}/`
          : `${ORIGIN}/creator/help/${id}/`,
        title: id,
        count: 0,
        rowIds: [],
      });
    }
    const section = sections.get(id);
    section.count += 1;
    try {
      const ids = byDocUrl.get(normalizeUrl(pageUrl)) || [];
      for (const idValue of ids) {
        if (!section.rowIds.some((existing) => String(existing) === String(idValue))) {
          section.rowIds.push(idValue);
        }
      }
    } catch {
      // ignore malformed page URLs
    }
  }

  const list = [...sections.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const complete = !truncated && !fetcher.truncated && !fetcher.skippedHop && pageUrls.length > 0 && seeds.length > 0;
  return {
    version: 1,
    source: `${ORIGIN}/creator/help/`,
    fetchedAt: new Date().toISOString(),
    complete,
    minIntervalMs: fetcher.intervalMs,
    robotsRespected: true,
    requests: requests(),
    note: complete
      ? `Crawled ${pageUrls.length} Creator help URLs into ${list.length} sections.`
      : `Crawl incomplete (requests=${requests()}, cap=${maxRequests}, pages=${pageUrls.length}). Not coverage.`,
    sections: list,
  };
}

function parseArgs(argv) {
  const opts = {
    output: 'docs/feature-matrix/help-sitemap-manifest.json',
    matrix: null,
    maxRequests: 20,
    intervalMs: MIN_INTERVAL_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--output') opts.output = next();
    else if (arg === '--matrix') opts.matrix = next();
    else if (arg === '--max-requests') opts.maxRequests = Number(next());
    else if (arg === '--min-interval-ms') opts.intervalMs = Number(next());
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isFinite(opts.maxRequests) || opts.maxRequests < 1) {
    throw new Error('--max-requests must be >= 1');
  }
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`--min-interval-ms must be >= ${MIN_INTERVAL_MS}`);
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('usage: node tools/fetch-help-sitemap.mjs [--output manifest.json] [--matrix matrix.json] [--max-requests 20]');
      process.exit(0);
    }
    let matrixRows = [];
    if (opts.matrix) {
      const doc = JSON.parse(fs.readFileSync(opts.matrix, 'utf8'));
      matrixRows = Array.isArray(doc) ? doc : doc.rows || [];
    }
    const manifest = await crawlHelpSitemap({
      maxRequests: opts.maxRequests,
      intervalMs: opts.intervalMs,
      matrixRows,
    });
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(manifest.note);
    if (!manifest.complete) process.exit(2);
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}
