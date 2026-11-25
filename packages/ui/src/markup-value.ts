/**
 * `c2cMarkup` in a generated page endpoint: how a rendered page prints a value
 * that holds markup, the way Creator's `<%=value%>` prints a string built from
 * HTML (a literal, an app function's return, an image field).
 *
 * Creator prints such a value raw. The endpoint cannot: the value may carry
 * text a caller or a record supplied. So the value is rebuilt from a small
 * allowlist instead of being trusted or escaped whole. Known tags and
 * attributes are re-serialized with every value escaped; an unknown tag shows
 * as text; an attribute outside the list is dropped; an `<img>` keeps only an
 * inline raster `data:` source; an `<a>` keeps only a target the endpoint
 * resolves to an own-app route (the navigation `shim.nav.resolve` applies to an
 * `openUrl`) or a web or mail address. The output still passes the endpoint's
 * audit and the client sanitizer.
 */

/** Element tags a markup value keeps. */
const MARKUP_TAGS = ['a', 'b', 'br', 'div', 'em', 'i', 'img', 'p', 'small', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u'] as const;

/** Style properties a markup value keeps; every value passes the endpoint's CSS value grammar. */
const MARKUP_STYLE_PROPS = [
  'background', 'background-color', 'border', 'border-bottom', 'border-color', 'border-left', 'border-radius', 'border-right',
  'border-style', 'border-top', 'border-width', 'box-sizing', 'clear', 'color', 'cursor', 'display', 'float', 'font-size', 'font-style',
  'font-weight', 'height', 'line-height', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width',
  'min-height', 'min-width', 'opacity', 'overflow', 'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'text-align', 'text-decoration', 'vertical-align', 'white-space', 'width',
] as const;

/** Longest value the endpoint rebuilds; a longer one renders empty. */
const MARKUP_VALUE_MAX = 4 * 1024 * 1024;

/** The one `src` an `<img>` in a markup value may carry. */
const MARKUP_IMAGE_SRC = '^data:image\\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+\\/]+={0,2}$';

export function c2cMarkupFunctionSource(): string {
  return `var C2C_MK_TAGS = ${JSON.stringify(Object.fromEntries(MARKUP_TAGS.map((tag) => [tag, 1])))};
var C2C_MK_STYLE_PROPS = ${JSON.stringify(Object.fromEntries(MARKUP_STYLE_PROPS.map((prop) => [prop, 1])))};
var C2C_MK_IMAGE_SRC = /${MARKUP_IMAGE_SRC}/;
var C2C_MK_TAG_AT = /<(\\/?)([A-Za-z][A-Za-z0-9]*)/y;
var C2C_MK_ATTR_AT = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
// Presentation the page's sanitizer never keeps; dropping it is no news.
var C2C_MK_QUIET = { border: 1, cellspacing: 1, cellpadding: 1, target: 1, rel: 1 };

// Text between tags: a character reference stays one (it can only show a
// character), every other ampersand and angle bracket is escaped.
function c2cMkText(text) {
  return text
    .replace(/&(?!(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Attributes of one tag, read the way an HTML tokenizer reads them: a quoted
// value may be followed by the next name with no space. Null when the tag does
// not close, so the caller shows its "<" as text.
function c2cMkTag(text, from) {
  var attrs = [];
  var i = from;
  var n = text.length;
  while (i < n) {
    while (i < n && /[\\s\\/]/.test(text[i])) i++;
    if (text[i] === ">") return { attrs: attrs, end: i + 1 };
    C2C_MK_ATTR_AT.lastIndex = i;
    var name = C2C_MK_ATTR_AT.exec(text);
    if (!name) return null;
    i += name[0].length;
    var value = "";
    var j = i;
    while (j < n && /\\s/.test(text[j])) j++;
    if (text[j] === "=") {
      j++;
      while (j < n && /\\s/.test(text[j])) j++;
      var quote = text[j];
      if (quote === '"' || quote === "'") {
        var close = text.indexOf(quote, j + 1);
        if (close < 0) return null;
        value = text.slice(j + 1, close);
        i = close + 1;
      } else {
        var start = j;
        while (j < n && !/[\\s>"'<=\`]/.test(text[j])) j++;
        if (j === start) return null;
        value = text.slice(start, j);
        i = j;
      }
    }
    attrs.push([name[0].toLowerCase(), value]);
    if (attrs.length > 32) return null;
  }
  return null;
}

// A style attribute keeps the declarations whose property is on the list and
// whose value passes the CSS value grammar; an empty result drops the attribute.
function c2cMkStyle(value) {
  var kept = [];
  var decls = String(value).split(";");
  for (var d = 0; d < decls.length; d++) {
    var colon = decls[d].indexOf(":");
    if (colon < 0) continue;
    var prop = decls[d].slice(0, colon).trim().toLowerCase();
    var css = c2cCss(decls[d].slice(colon + 1));
    if (Object.prototype.hasOwnProperty.call(C2C_MK_STYLE_PROPS, prop) && css) kept.push(prop + ":" + css);
  }
  return kept.join(";");
}

function c2cMarkup(value, notes, href) {
  var text = String(value == null ? "" : value);
  if (text.length > ${MARKUP_VALUE_MAX}) {
    notes.push("a markup value was too large and rendered empty");
    return "";
  }
  var note = function (message) { if (notes.indexOf(message) < 0) notes.push(message); };
  var out = [];
  var open = [];
  var at = 0;
  while (at < text.length) {
    var lt = text.indexOf("<", at);
    if (lt < 0) {
      out.push(c2cMkText(text.slice(at)));
      break;
    }
    if (lt > at) out.push(c2cMkText(text.slice(at, lt)));
    if (text.startsWith("<!--", lt)) {
      // HTML's bogus-comment state closes an empty comment at the first >:
      // both the empty and hyphenated forms are comments, followed by live text/markup.
      if (text.startsWith("<!-->", lt)) { at = lt + 5; continue; }
      if (text.startsWith("<!--->", lt)) { at = lt + 6; continue; }
      var end = text.indexOf("-->", lt + 4);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    C2C_MK_TAG_AT.lastIndex = lt;
    var head = C2C_MK_TAG_AT.exec(text);
    var tag = head ? c2cMkTag(text, lt + head[0].length) : null;
    if (!head || !tag) {
      out.push("&lt;");
      at = lt + 1;
      continue;
    }
    at = tag.end;
    var name = head[2].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(C2C_MK_TAGS, name)) {
      note("a markup value held <" + name + ">, which is shown as text");
      out.push(c2cEsc(text.slice(lt, tag.end)));
      continue;
    }
    if (head[1]) {
      var depth = open.lastIndexOf(name);
      while (depth >= 0 && open.length > depth) out.push("</" + open.pop() + ">");
      continue;
    }
    if (open.length >= 64) {
      note("a markup value nested deeper than 64 elements and the rest is shown as text");
      out.push(c2cEsc(text.slice(lt)));
      at = text.length;
      break;
    }
    var html = "<" + name;
    var seen = {};
    var source = "";
    for (var a = 0; a < tag.attrs.length; a++) {
      var attr = tag.attrs[a][0];
      var val = tag.attrs[a][1];
      if (Object.prototype.hasOwnProperty.call(seen, attr)) continue;
      seen[attr] = 1;
      if (attr === "class" && /^[A-Za-z0-9_ -]{1,200}$/.test(val)) html += ' class="' + val + '"';
      else if (attr === "style" && c2cMkStyle(val)) html += ' style="' + c2cEsc(c2cMkStyle(val)) + '"';
      else if (attr === "title" || (name === "img" && attr === "alt")) html += " " + attr + '="' + c2cEsc(val.slice(0, 200)) + '"';
      else if (name === "img" && (attr === "width" || attr === "height") && /^[0-9]{1,4}%?$/.test(val)) html += " " + attr + '="' + val + '"';
      else if (name === "img" && attr === "src" && C2C_MK_IMAGE_SRC.test(val)) source = ' src="' + val + '"';
      else if ((name === "td" || name === "th") && (attr === "colspan" || attr === "rowspan") && /^[0-9]{1,3}$/.test(val)) html += " " + attr + '="' + val + '"';
      else if (name === "a" && attr === "href") {
        var target = href(val);
        if (target) html += ' href="' + c2cEsc(target) + '"';
        else note("a link in a markup value names no page, form, report or web address of this app and has no target");
      }
      else if (!Object.prototype.hasOwnProperty.call(C2C_MK_QUIET, attr)) note("a markup value attribute the page does not keep was removed");
    }
    if (name === "img") {
      if (!source) {
        note("a markup value image had no inline raster source and was removed");
        continue;
      }
      html += source;
    }
    out.push(html + ">");
    if (name !== "br" && name !== "img") open.push(name);
  }
  while (open.length) out.push("</" + open.pop() + ">");
  return out.join("");
}`;
}

/** Largest image the endpoint inlines, and the most image bytes one render inlines. */
const IMAGE_INLINE_MAX = 2 * 1024 * 1024;
const IMAGE_RENDER_MAX = 4 * 1024 * 1024;

/**
 * `c2cImage` in a generated page endpoint: an image field's value as Creator
 * shows it to Deluge, an `<img>` element. The stored value is a Stratus key,
 * so the endpoint signs a download for it (the key must belong to the form and
 * field, like the download route), reads the bytes, and inlines a raster image
 * as a `data:` URL: the page's CSP allows `img-src data:` and no other host.
 * An empty value stays empty. A key it cannot sign, an image over the size
 * limits, a response that is not PNG, JPEG, GIF or WebP by its own bytes, and a
 * dry run (nothing is signed) each render empty and add a render note.
 */
export function c2cImageFunctionSource(): string {
  return `async function liveFileStore(req) {
  try {
    const mod = await import("../c2c-files.mjs");
    if (mod && typeof mod.fileStore === "function") return await mod.fileStore(req);
  } catch (err) {
    /* files module is absent when this file is loaded alone */
  }
  return null;
}

function c2cImageType(bytes) {
  const at = (i, text) => text.split("").every((ch, k) => bytes[i + k] === ch.charCodeAt(0));
  if (bytes.length > 8 && bytes[0] === 0x89 && at(1, "PNG") && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "image/gif";
  if (bytes.length > 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return "";
}

async function c2cImage(env, value, form, field) {
  if (value == null || value === "") return value;
  const refuse = (note) => {
    if (env.notes.indexOf(note) < 0) env.notes.push(note);
    return "";
  };
  if (!env.files) return refuse("an image field is not shown in a dry run");
  try {
    const signed = await signDownload(env.files, form, field, value);
    const res = await fetch(signed.url, { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!res.ok) return refuse("an image could not be read and is not shown");
    const room = Math.min(${IMAGE_INLINE_MAX}, ${IMAGE_RENDER_MAX} - env.bytes);
    const tooBig = () => refuse("an image is over the size the page inlines and is not shown");
    if (Number(res.headers.get("content-length")) > room) return tooBig();
    // Read only as much as fits, so an object far larger than the limit is never held in memory.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > room) {
        await reader.cancel();
        return tooBig();
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    const type = c2cImageType(bytes);
    if (!type) return refuse("an image field did not hold a PNG, JPEG, GIF or WebP image and is not shown");
    env.bytes += bytes.length;
    return '<img src="data:' + type + ";base64," + Buffer.from(bytes).toString("base64") + '">';
  } catch (err) {
    return refuse("an image could not be read and is not shown");
  }
}`;
}
