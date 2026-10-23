// Gift Lists server: serves the app and reads product info (title, image, price) from a link.
// Needs Node 18 or newer. No npm packages required.
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, "public", "index.html");

// ---- safety: never fetch private or internal addresses ----
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https links are allowed");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error("Blocked address");
}
async function fetchPage(startUrl) {
  let url = new URL(startUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; GiftListsBot/1.0)",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    if (!res.ok) throw new Error("Store returned " + res.status);
    return { html: (await res.text()).slice(0, 1500000), url };
  }
  throw new Error("Too many redirects");
}

// ---- reading product details ----
function decode(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const val = (/content\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (key && val && !out[key.toLowerCase()]) out[key.toLowerCase()] = decode(val);
  }
  return out;
}
function jsonLdProducts(html) {
  const found = [];
  const walk = n => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = [].concat(n["@type"] || []).join(",");
    if (/Product/i.test(t)) found.push(n);
    if (n["@graph"]) walk(n["@graph"]);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch (e) { /* skip bad JSON */ }
  }
  return found;
}
function toPrice(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}
function firstImage(i) { return Array.isArray(i) ? firstImage(i[0]) : (i && typeof i === "object" ? i.url : i); }

function extract(html, pageUrl) {
  const meta = metaTags(html);
  const product = jsonLdProducts(html)[0] || {};
  const offer = [].concat(product.offers || [])[0] || {};
  const spec = offer.priceSpecification ? [].concat(offer.priceSpecification)[0] : {};
  const price = toPrice(offer.price) || toPrice(offer.lowPrice) || toPrice(spec && spec.price) ||
    toPrice(meta["product:price:amount"]) || toPrice(meta["og:price:amount"]) ||
    toPrice(meta["twitter:data1"]) || toPrice(meta["price"]);
  let image = firstImage(product.image) || meta["og:image"] || meta["og:image:secure_url"] || meta["twitter:image"];
  try { if (image) image = new URL(image, pageUrl).href; } catch (e) { image = ""; }
  if (image && !/^https?:/i.test(image)) image = "";
  const title = decode(product.name || meta["og:title"] || meta["twitter:title"] ||
    ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]) || "");
  return { title, price, image: image || "" };
}

// ---- web server ----
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/preview") {
    res.setHeader("content-type", "application/json");
    try {
      const target = u.searchParams.get("url") || "";
      if (target.length > 2000) throw new Error("Link too long");
      const { html, url } = await fetchPage(target);
      res.end(JSON.stringify(extract(html, url)));
    } catch (e) {
      res.statusCode = 200; // the app treats any failure as "fill it in yourself"
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return fs.createReadStream(PAGE).pipe(res);
  }
  res.statusCode = 404;
  res.end("Not found");
}).listen(PORT, () => console.log("Gift Lists running at http://localhost:" + PORT));
