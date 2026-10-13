// Netlify Function: haalt RSS-feeds van de bronnen uit psvnieuws.nl/bronnen.html op,
// filtert op PSV, ontdubbelt en serveert alles als JSON + een statische pagina.

const TTL = 5 * 60 * 1000;

// filter: true = alleen items die PSV noemen (algemene sport-/voetbalfeeds)
const FEEDS = [
  { name: 'NOS', url: 'https://feeds.nos.nl/nosvoetbal', filter: true },
  { name: 'NU.nl', url: 'https://www.nu.nl/rss/Sport', filter: true },
  { name: 'Omroep Brabant', url: 'https://www.omroepbrabant.nl/rss/sport', filter: true },
  { name: 'Eindhovens Dagblad', url: 'https://www.ed.nl/voetbal/rss.xml', filter: true },
  { name: 'AD', url: 'https://www.ad.nl/voetbal/rss.xml', filter: true },
  { name: 'Voetbal International', url: 'https://www.vi.nl/rss/nieuws', filter: true },
  { name: 'NRC', url: 'https://www.nrc.nl/rss/', filter: true },
  // PSV Inside, PSV.nl e.a. bieden zelf geen RSS; Google News dekt die via een PSV-zoekopdracht
  { name: 'Google News', url: 'https://news.google.com/rss/search?q=PSV+when:7d&hl=nl&gl=NL&ceid=NL:nl', filter: false, sourceFromTitle: true },
];

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const strip = s => decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1] : ''; };
const attr = (x, re) => { const m = x.match(re); return m ? decode(m[1]) : ''; };

function parse(xml, feed) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([x]) => {
    let title = strip(tag(x, 'title'));
    let source = feed.name;
    if (feed.sourceFromTitle) {
      const i = title.lastIndexOf(' - ');
      if (i > 0) { source = title.slice(i + 3); title = title.slice(0, i); }
    }
    const raw = tag(x, 'description') || tag(x, 'content:encoded');
    const link = strip(tag(x, 'link')) || attr(x, /<link[^>]*href="([^"]+)"/i);
    const image = attr(x, /<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i)
      || attr(x, /<enclosure[^>]*url="([^"]+)"[^>]*type="image/i)
      || attr(x, /<media:(?:content|thumbnail)[^>]*url="([^"]+)"/i)
      || attr(x, /<img[^>]*src="([^"]+)"/i);
    let summary = strip(raw);
    if (feed.sourceFromTitle) summary = '';
    if (summary.length > 260) summary = summary.slice(0, 260).replace(/\s\S*$/, '') + '…';
    const date = new Date(strip(tag(x, 'pubDate')) || strip(tag(x, 'dc:date')));
    return { title, link, source, summary, image, date: isNaN(date) ? null : date.toISOString() };
  }).filter(i => i.title && i.link && i.date);
}

let cache = { at: 0, data: null };
async function load() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 PSV-RSS-reader' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(r.status);
    let items = parse(await r.text(), f);
    if (f.filter) items = items.filter(i => /\bPSV\b|Eindhoven/i.test(`${i.title} ${i.summary}`));
    return items;
  }));
  const seen = new Set();
  const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(i => { const k = i.title.toLowerCase().replace(/\W+/g, ''); return seen.has(k) ? false : seen.add(k); });
  const feeds = FEEDS.map((f, n) => ({ name: f.name, ok: results[n].status === 'fulfilled', count: results[n].value?.length ?? 0 }));
  cache = { at: Date.now(), data: { updated: new Date().toISOString(), feeds, items } };
  return cache.data;
}


export default async () => {
  try {
    return new Response(JSON.stringify(await load()), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
};

export const config = { path: '/api/news' };
