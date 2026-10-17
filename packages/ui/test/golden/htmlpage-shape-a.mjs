/**
 * htmlpage hp1 on page Home: a server-side snippet compiled to a read-only endpoint.
 * Advanced I/O POST /htmlpages/Home/s0
 * Static markup was sanitized with the snippet allowlist at generation; every interpolated value is HTML-escaped
 * for its context (text or attribute). The client sanitizes the response again before inserting it.
 * Reads go through the runtime scopeRead (profile grants, record filters, hidden forms), like the report endpoints.
 * Page input values are bound criteria/parameters only; nothing is concatenated into ZCQL.
 * openUrl actions in the template render as links; "popup window" targets stay lifted popup triggers.
 * Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.
 * node: 20.20.1
 * typescript: 5.9.3
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, jsonReplacer, principalFromRequest, renderedDocumentViolation, renderedHtmlElements } from "creator-to-catalyst/shims";

const policyPath = join(dirname(fileURLToPath(import.meta.url)), "../access-policy.json");
export const access = JSON.parse(readFileSync(policyPath, "utf8"));

export const endpoint = { type: "advancedio", method: "POST", path: "/htmlpages/Home/s0", dryRun: true };
export const htmlpage = {"page":"Home","name":"hp1","forms":["Orders"]};

const c2c_static_0 = "\n";
const c2c_static_1 = "<h3>";
const c2c_static_2 = " open</h3><ul>";
const c2c_static_3 = "<li>";
const c2c_static_4 = ":";
const c2c_static_5 = "</li>";
const c2c_static_6 = "</ul>\n";
const c2c_static_7 = "\n";

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

function c2cStr(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (typeof v.zoho === "string") return v.zoho === "appuri" ? "#" : "";
    if (Array.isArray(v)) return v.map(c2cStr).join(", ");
    if (typeof v.y === "number" && typeof v.m === "number" && typeof v.d === "number") return v.toString();
    if (typeof v.label === "string") return v.label;
    try {
      return JSON.stringify(v, jsonReplacer);
    } catch (err) {
      return "";
    }
  }
  return String(v);
}

function c2cEsc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// An island inside a quoted style attribute renders only a strict CSS value:
// numbers with a unit, #hex, rgb()/rgba()/hsl()/hsla() with numeric arguments,
// and a keyword allowlist, joined by whitespace, commas or '/'. Semicolons,
// quotes, backslashes, comments, braces, url(), expression() and every other
// function can never come from a value — it renders empty and is reported as
// a note instead.
const C2C_CSS_WORDS = new Set(("auto none normal inherit initial unset revert solid dashed dotted double groove ridge inset outset hidden visible block inline inline-block flex inline-flex grid inline-grid table table-row table-cell list-item run-in absolute relative fixed static sticky center left right top bottom middle baseline sub super text-top text-bottom start end first last only even odd nowrap wrap wrap-reverse pre pre-wrap pre-line break-word italic oblique underline overline line-through wavy capitalize uppercase lowercase full-width small-caps all-small-caps transparent currentcolor cover contain repeat repeat-x repeat-y no-repeat space round scroll local serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong pointer default move text wait help crosshair not-allowed grab grabbing zoom-in zoom-out col-resize row-resize e-resize w-resize n-resize s-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize bold bolder lighter thin medium thick collapse separate show row row-reverse column column-reverse flex-start flex-end space-between space-around space-evenly stretch open closed both horizontal vertical ltr rtl forwards backwards alternate alternate-reverse infinite running paused ease linear ease-in ease-out ease-in-out step-start step-end jump-start jump-end jump-none jump-both border-box content-box padding-box margin-box fill-box stroke-box view-box flat preserve-3d aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

const C2C_CSS_VALUE =
  /^(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|s|ms|deg|rad|grad|turn|fr|%)?|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?\s*(?:,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?\s*){2,3}\)|[A-Za-z][A-Za-z0-9-]*)(?:[\s,/]+(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|s|ms|deg|rad|grad|turn|fr|%)?|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?\s*(?:,\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?\s*){2,3}\)|[A-Za-z][A-Za-z0-9-]*))*$/i;

function c2cCss(v) {
  const text = String(v == null ? "" : v).trim();
  if (!text) return "";
  if (/[;\\{}<>&'"!@]/.test(text) || text.includes("/*") || text.includes("*/")) return "";
  const flat = text.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (flat.includes("url(") || flat.includes("expression") || flat.includes("javascript:") || flat.includes("vbscript:")) return "";
  if (!C2C_CSS_VALUE.test(text)) return "";
  const words =
    text
      .replace(/(?:rgb|rgba|hsl|hsla)\([^()]*\)/gi, " ")
      .replace(/#[0-9a-fA-F]{3,8}/g, " ")
      .replace(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-zA-Z]{1,5}|%)?/g, " ")
      .match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
  if (!words.every((w) => C2C_CSS_WORDS.has(w.toLowerCase()))) return "";
  return text;
}

function c2cUrlOk(url) {
  const flat = String(url || "").replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (!flat || flat.startsWith("#") || flat.startsWith("/") || !/^[a-z][a-z0-9+.-]*:/.test(flat) || flat.startsWith("http:") || flat.startsWith("https:") || flat.startsWith("mailto:")) return true;
  return false;
}

const C2C_AUDIT_TAGS = new Set(["a","abbr","b","blockquote","br","button","caption","code","col","colgroup","dd","del","div","dl","dt","em","figcaption","figure","font","h1","h2","h3","h4","h5","h6","hr","i","img","ins","kbd","li","mark","ol","p","pre","q","s","samp","small","span","strong","sub","sup","table","tbody","td","tfoot","th","thead","tr","u","ul","var","wbr"]);
const C2C_AUDIT_ATTRS = {"*":["data-style-dropped","data-zml","title"],"a":["href","title","rel"],"button":["data-fn-argc","data-fn-args","data-fn-call","data-fn-msg","data-fn-refresh","type"],"font":["color","face","size"],"img":["alt","height","src","title","width"],"ol":["start","title"],"td":["colspan","rowspan","title"],"th":["colspan","rowspan","title"]};
const C2C_AUDIT_URLS = /^(href|src|srcset|action|formaction|xlink:href|poster|cite|background|longdesc|profile|usemap|data|ping|manifest|codebase|archive|lowsrc|dynsrc|srcdoc)$/i;
function c2cAttrAuditOk(tag, name, value) {
  const attr = String(name).toLowerCase();
  if (attr.slice(0, 2) === "on" || attr === "srcdoc") return false;
  if (attr === "style") {
    const flat = String(value == null ? "" : value).replace(/[\u0000-\u0020]+/g, "").toLowerCase();
    return flat.indexOf("javascript:") < 0 && flat.indexOf("vbscript:") < 0;
  }
  const specific = C2C_AUDIT_ATTRS[tag];
  if (tag === "button" && /^data-fn-arg-\d+$/.test(attr)) return true;
  if (!(specific && specific.indexOf(attr) >= 0) && C2C_AUDIT_ATTRS["*"].indexOf(attr) < 0) return false;
  if (C2C_AUDIT_URLS.test(attr) && !c2cUrlOk(value)) return false;
  return true;
}
function c2cAuditViolation(html) {
  const structural = renderedDocumentViolation(html);
  if (structural) return structural;
  for (const el of renderedHtmlElements(html)) {
    if (!C2C_AUDIT_TAGS.has(el.tag)) return "element " + el.tag;
    for (const attr of el.attributes) {
      if (!c2cAttrAuditOk(el.tag, attr.name, attr.value)) return el.tag + " " + attr.name;
    }
  }
  return "";
}

function c2cLink(url) {
  const text = String(url || "").trim();
  let href = "";
  let label = text;
  const internal = /^#(Form|Report):(.+)$/.exec(text);
  if (internal) {
    href = "#/" + internal[1].toLowerCase() + "/" + encodeURIComponent(internal[2]);
    label = internal[2].replace(/_/g, " ");
  } else if (/^https?:\/\//i.test(text)) {
    href = text;
  }
  if (!href) return "";
  return '<a href="' + c2cEsc(href) + '">' + c2cEsc(label) + "</a>";
}

async function render(ctx) {
  const shim = ctx.shim;
  // Deluge: c2c_out = List()
  var c2c_out = [];
  // Deluge: c2c_out.add({"***":"***","***":c2c_static_0})
  shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_0 });
  // Deluge: if (zoho.loginuserid == "***") { open = Orders[Status == "***"]; } else { ope...
  if ((shim.zoho.loginUserId(ctx) == "u1")) {
    // Deluge: open = Orders[Status == "***"]
    var open = shim.datastore.query(ctx, "Orders", { op: "==", field: "Status", value: "open" });
  } else {
    // Deluge: open = Orders[Status == "***"]
    open = shim.datastore.query(ctx, "Orders", { op: "==", field: "Status", value: "archived" });
  }
  // Deluge: c2c_out.add({"***":"***","***":c2c_static_1})
  shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_1 });
  // Deluge: c2c_out.add({"***":"***","***":(open.count())})
  shim.list.add(c2c_out, { ["k"]: "T", ["v"]: await shim.datastore.aggregate(ctx, open, "count", undefined) });
  // Deluge: c2c_out.add({"***":"***","***":c2c_static_2})
  shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_2 });
  // Deluge: for each row in open { c2c_out.add({"***":"***","***":c2c_static_3}); c2c_out...
  for (var d_row of shim.each(ctx, await shim.datastore.rows(ctx, open))) {
    // Deluge: c2c_out.add({"***":"***","***":c2c_static_3})
    shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_3 });
    // Deluge: c2c_out.add({"***":"***","***":(row.Status)})
    shim.list.add(c2c_out, { ["k"]: "T", ["v"]: shim.record.get(d_row, "Status") });
    // Deluge: c2c_out.add({"***":"***","***":c2c_static_4})
    shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_4 });
    // Deluge: c2c_out.add({"***":"***","***":(row.Amount)})
    shim.list.add(c2c_out, { ["k"]: "T", ["v"]: shim.record.get(d_row, "Amount") });
    // Deluge: c2c_out.add({"***":"***","***":c2c_static_5})
    shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_5 });
  }
  // Deluge: c2c_out.add({"***":"***","***":c2c_static_6})
  shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_6 });
  // Deluge: c2c_out.add({"***":"***","***":c2c_static_7})
  shim.list.add(c2c_out, { ["k"]: "H", ["v"]: c2c_static_7 });
  const c2c_parts = [];
  const c2c_notes = [];
  // A URL attribute value may span several parts (static pieces and islands).
  // The scheme check runs on the whole joined value, so the pieces accumulate
  // until the next non-URL part; a dropped island inside the value does not
  // break the accumulation.
  let c2c_url_on = false;
  let c2c_url_raw = "";
  let c2c_url_esc = "";
  const c2c_urlFlush = () => {
    if (!c2c_url_on) return;
    c2c_parts.push(c2cUrlOk(c2c_url_raw) ? c2c_url_esc : "");
    c2c_url_on = false;
    c2c_url_raw = "";
    c2c_url_esc = "";
  };
  for (const item of c2c_out) {
    if (item && typeof item === "object" && !Array.isArray(item) && (item.k === "V" || item.k === "W")) {
      const piece = item.k === "V" ? c2cStr(item.v) : String(item.v == null ? "" : item.v);
      c2c_url_on = true;
      c2c_url_raw += piece;
      c2c_url_esc += item.k === "V" ? c2cEsc(piece) : piece;
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item) && item.k === "D") continue;
    c2c_urlFlush();
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.k === "H") c2c_parts.push(item.v == null ? "" : String(item.v));
    else if (item.k === "T") c2c_parts.push(c2cEsc(c2cStr(item.v)));
    else if (item.k === "A") c2c_parts.push(c2cEsc(c2cStr(item.v)));
    else if (item.k === "L") c2c_parts.push(c2cLink(c2cStr(item.v)));
    else if (item.k === "C") {
      const piece = c2cStr(item.v);
      const css = c2cCss(piece);
      if (!css && piece.trim()) c2c_notes.push("a style island value was not a safe CSS value and rendered empty");
      c2c_parts.push(css);
    } else if (item.k === "N") c2c_notes.push(String(item.v == null ? "" : item.v));
  }
  c2c_urlFlush();
  return { html: c2c_parts.join(""), notes: c2c_notes };
}

function modeOverride() {
  const value = typeof process !== "undefined" && process.env ? process.env.C2C_DEPLOY_MODE : undefined;
  return value === "live" || value === "dry-run" ? value : "";
}

function deployConfig() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "../c2c-deploy.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const mode = modeOverride() || (parsed && parsed.mode === "live" ? "live" : "dry-run");
    const appTimeZone = parsed && typeof parsed.appTimeZone === "string" ? parsed.appTimeZone : "";
    const origins = c2cPageOrigins(parsed && parsed.allowedOrigins);
    return { mode, appTimeZone, origins };
  } catch (err) {
    return { mode: modeOverride() || "dry-run", appTimeZone: "", origins: [] };
  }
}

// c2c-deploy.json allowedOrigins names this app's own page origins — the
// Slate URL origin and the function's own domain — written by c2c deploy.
// Each entry is normalized to a URL origin (scheme + host + port), so a
// wildcard or a path suffix can never widen the match.
function c2cPageOrigins(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    try {
      const parsed = new URL(String(item));
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.host.includes("*") && parsed.pathname === "/" && !parsed.search && !parsed.hash) out.push(parsed.origin);
    } catch (err) {}
  }
  return out;
}

async function liveDatastore() {
  try {
    const mod = await import("../c2c-store.mjs");
    if (mod && typeof mod.getDatastore === "function") {
      const stored = mod.getDatastore();
      if (stored) return stored;
    }
  } catch (err) {
    /* store module is absent when this file is loaded alone */
  }
  try {
    if (globalThis.__c2cDatastore) return globalThis.__c2cDatastore;
  } catch (err) {
    /* no injected global */
  }
  return null;
}

export default async function handler(req, res) {
  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: true, error: "authenticated caller required" });
    return;
  }
  for (const form of htmlpage.forms) {
    if (isHidden(form)) {
      send(res, 403, { dryRun: true, error: "hidden form" });
      return;
    }
  }
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  const datastore = live ? await liveDatastore() : null;
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const body = req && typeof req.body === "object" && req.body && !Array.isArray(req.body) ? req.body : {};
  const input = body && typeof body.input === "object" && body.input && !Array.isArray(body.input) ? body.input : {};
  try {
    const runtime = createRuntime({
      dryRun: !live,
      appTimeZone,
      access,
      ...(datastore ? { datastore } : {}),
    });
    const ctx = runtime.context({ record: input, old: {}, principal, appTimeZone });
    const rendered = await render(ctx);
    let violation = "";
    try {
      violation = c2cAuditViolation(rendered.html);
    } catch (err) {
      violation = "markup audit unavailable";
    }
    if (violation) {
      send(res, 500, { dryRun: !live, error: "rendered markup failed the output attribute check" });
      return;
    }
    send(res, 200, { dryRun: !live, html: rendered.html, notes: rendered.notes, transcript: runtime.transcript });
  } catch (err) {
    const denied = err && err.code === "RECORD_ACCESS_DENIED";
    send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "render failed" });
  }
}
