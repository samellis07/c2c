# c2c fetch-assets

Some exports style a page with a remote CSS background (`background: url(https://host/pic.png)`). The generated app's policy allows images only from its own origin, so by default that declaration is dropped and counted. `c2c fetch-assets` copies the image into the app at migration time instead.

```sh
c2c fetch-assets <file|dir>
c2c ui-react <file|dir> --out <dir>      # reads the lock; no network
```

It writes, next to the export:

- `c2c-assets/<sha256>.<ext>` - the image bytes, named by content hash
- `c2c-assets.lock.json` - `{ "version": 1, "entries": [...] }`, sorted by url; each entry is `fetched` (sha256, ext, size), `refused` or `failed` (reason)

Generation (`c2c ui`, `ui-react`, `analyze`, `determinism`) never uses the network. It reads the lock, re-hashes each cached file, re-checks the image signature, and rewrites the literal url to `bg/<sha256>.<ext>`. The file ships as `public/bg/...` (React) or `slate/bg/...` (vanilla). Same bytes in, same output out. An unused locked image is not shipped.

## What is rewritten

Only a `url()` inside a `background` or `background-image` declaration whose every character is literal text. A url with a `<%` island, or any value that comes from record data, never matches, so no url is built from data. Other properties (`list-style-image`, `content`, ...) are untouched.

## What stays counted

A url with no verified copy keeps the existing counted TODO (`Static <style> CSS not carried over` / `Inline style declarations not carried over`), and its manual step adds the host and the reason: `http` (only `https` is fetched), an IP-literal, local or internal host, a host that resolves to a private, loopback, link-local or reserved address, a redirect to any of these, a non-image or SVG answer, an image over 1 MiB, a timeout, a missing or mismatched cache file. `c2c fetch-assets` exits 1 when any url was refused or failed, or when the app names more than 32 urls.

## Bounds

https only, port 443, no credentials, no IP literal, no `localhost` or `.local`/`.internal`-style name; every resolved address checked and the connection pinned to the checked address; the checks run again on each redirect, at most 3; 1 MiB size cap; 10 s deadline; Content-Type must be png, jpeg, gif or webp and the leading bytes must agree (no SVG); the file is written, never run, parsed or inlined. The inline-style sanitizer accepts exactly one `url()` shape for `background` and `background-image`: `bg/<64 hex>.<png|jpg|gif|webp>`. The CSP is unchanged.
