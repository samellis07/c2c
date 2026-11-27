/**
 * Literal remote CSS backgrounds, rewritten to the same-origin copy that
 * `c2c fetch-assets` stored. Only a `background` or `background-image`
 * declaration is read, and only a `url()` whose every character is literal
 * text: a url with a `<%` island, a quote break or any other markup never
 * matches, so no url is ever assembled from record data. A url with no
 * verified fetched copy is left untouched for the sanitizer to drop and count.
 */

import { assetPublicPath, type RemoteAsset } from '../../core/src/remote-assets.js';

const ENTITY = '&(?:apos|quot|amp|#39|#34);';
const QUOTE = `'|"|&apos;|&quot;|&#39;|&#34;`;
const LITERAL_URL = `https?:\\/\\/(?:&amp;|[^\\s'"()<>\\\\{}&;])*`;
const BACKGROUND_DECL = new RegExp(`(?<![\\w-])(background(?:-image)?\\s*:)((?:${ENTITY}|[^;{}<>])*)`, 'gi');
const URL_CALL = new RegExp(`url\\(\\s*(?:(${QUOTE})\\s*(${LITERAL_URL})\\s*\\1|(${LITERAL_URL}))\\s*\\)`, 'gi');

export interface BackgroundRewrite {
  text: string;
  /** Public paths of the fetched images the text now points at. */
  used: Set<string>;
  /** Literal remote urls left as they were, each with the reason no copy was used. */
  unresolved: Map<string, string>;
}

export function rewriteRemoteBackgrounds(text: string, assets: readonly RemoteAsset[]): BackgroundRewrite {
  const byUrl = new Map(assets.map((asset) => [asset.url, asset] as const));
  const used = new Set<string>();
  const unresolved = new Map<string, string>();
  const out = text.replace(BACKGROUND_DECL, (_whole, head: string, value: string) =>
    head +
    value.replace(URL_CALL, (call: string, _quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const url = (quoted ?? bare ?? '').replace(/&amp;/g, '&');
      const asset = byUrl.get(url);
      if (asset?.status === 'fetched' && asset.bytes && asset.sha256 && asset.ext) {
        const path = assetPublicPath(asset.sha256, asset.ext);
        used.add(path);
        return `url(${path})`;
      }
      unresolved.set(url, asset?.reason ?? 'no fetched copy is recorded; run c2c fetch-assets');
      return call;
    }),
  );
  return { text: out, used, unresolved };
}

/** Literal remote urls a background declaration names, decoded, sorted, unique. The same match the rewrite uses. */
export function literalBackgroundUrls(text: string): string[] {
  const found = new Set<string>();
  for (const decl of text.matchAll(BACKGROUND_DECL)) {
    for (const call of (decl[2] as string).matchAll(URL_CALL)) found.add(((call[2] ?? call[3]) as string).replace(/&amp;/g, '&'));
  }
  return [...found].sort();
}
