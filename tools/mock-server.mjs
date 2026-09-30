import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = join(root, 'web');
const dataDir = process.env.MOCK_DATA_DIR;
if (!dataDir) throw new Error('MOCK_DATA_DIR가 필요합니다.');
const rows = async name => (await readFile(join(dataDir, name), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const seed = JSON.parse(await readFile(join(root, 'src/shared/topics.json'), 'utf8'));
const scores = new Map((await rows('scores-v5.jsonl')).map(row => [String(row.id), row.scores]));
const topics = seed.topics.map((topic, sort_order) => ({
  ...topic, timeline_visibility: topic.timeline_visibility || (topic.id === 'politics' ? 'owner' : 'public'),
  search_visibility: topic.search_visibility || (topic.id === 'politics' ? 'owner' : 'public'), active: 1,
  version: seed.version, sort_order, scored: 0,
}));
const tweets = (await rows('sample.jsonl')).map(row => {
  const id = String(row.id);
  const created_at = row.created_at_utc;
  const date_kst = row.date_kst;
  const visible = Object.entries(scores.get(id) || {}).filter(([, score]) => score >= 0.7)
    .sort((a, b) => b[1] - a[1]).map(([topic, score]) => ({ id: topic, score }));
  return {
    id, created_at, date_kst, kind: row.kind, text: row.text || '',
    parent: row.parent ? { id: row.parent.id || null, text: row.parent.text || null, author: row.parent.author || null } : null,
    quoted: row.quoted ? { id: row.quoted.id || null, text: row.quoted.text || null } : null,
    media: (row.media || []).map(item => ({ type: item.type, url: null, width: item.width || null,
      height: item.height || null, alt: item.alt || null })),
    topics: visible, x_url: `https://x.com/i/status/${id}`, visibility: row.visibility ?? null,
  };
}).sort((a, b) => a.created_at.localeCompare(b.created_at));
for (const topic of topics) topic.scored = tweets.length;
let tags = [
  { id: 'mock-period', label: '프로젝트 기간', kind: 'career', start_date: '2009-01-01', end_date: '2013-12-31', note: null, visibility: 'public' },
  { id: 'mock-book', label: '읽은 책', kind: 'book', start_date: '2024-03-01', end_date: '2024-03-31', note: null, visibility: 'public' },
];
const makePreset = (label, query) => ({ id: createHash('sha256').update(query).digest('hex').slice(0, 12), label, query });
let searchPresets = [
  makePreset('영화가 기억나는 순간', '처음 좋아했던 영화가 생각난 날'),
  makePreset('오래된 게임 이야기', '예전에 푹 빠져 했던 게임'),
];
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const pad = n => String(n).padStart(2, '0');
const dateMs = s => Date.parse(`${s}T00:00:00Z`);
const isOwner = url => url.searchParams.get('as') !== 'visitor';
const isPublicHidden = tweet => tweet.visibility === 'private' || (tweet.visibility === null && Object.entries(scores.get(tweet.id) || {}).some(([id, score]) => {
  const topic = topics.find(item => item.id === id);
  return topic?.active && topic.public_hide_threshold != null && score >= topic.public_hide_threshold;
}));
const viewerTweets = owner => owner ? tweets : tweets.filter(tweet => !isPublicHidden(tweet));
const visibleTopics = owner => topics.filter(t => owner || t.timeline_visibility === 'public' || t.search_visibility === 'public');
const visibleTags = owner => tags.filter(t => owner || t.visibility === 'public');
const visibleTweet = (tweet, owner) => {
  const { visibility, ...rest } = tweet;
  const value = { ...rest, topics: tweet.topics.filter(({ id }) => {
    const topic = topics.find(t => t.id === id);
    return topic && (owner ? topic.timeline_visibility !== 'hidden' : topic.timeline_visibility === 'public');
  }) };
  return owner ? { ...value, visibility, public_hidden: isPublicHidden(tweet) } : value;
};
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const body = async req => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
const counts = (items, owner) => {
  const out = {};
  for (const tweet of items) for (const topic of visibleTweet(tweet, owner).topics) out[topic.id] = (out[topic.id] || 0) + 1;
  return out;
};
const estimate = { tweets: tweets.length, est_usd: +(tweets.length * 400 * 0.042 / 1e6).toFixed(4), est_minutes: Math.ceil(tweets.length / 400) };
const responseTopics = owner => visibleTopics(owner).map(topic => owner ? topic : (({ question, scored, public_hide_threshold, ...rest }) => rest)(topic));
const searchResponse = (query, owner) => {
  const tweet = viewerTweets(owner)[0];
  return {
    q: query, judged: { topics: [], period: null }, candidates: tweet ? 1 : 0,
    results: tweet ? [{ tweet: visibleTweet(tweet, owner), score: 0.93, why: '공개 검색 문구' }] : [],
    stages: [{ name: 'judge', ms: 12 }, { name: 'candidates', ms: 4 }, { name: 'rank', ms: 18 }],
    intent: 'one', strategies: [], rank_question: 'exact', fallback: false, rounds: 1,
  };
};
const period = tag => [tag.start_date, tag.end_date || today];
const inYear = (tag, year) => { const [a, b] = period(tag); return a <= `${year}-12-31` && b >= `${year}-01-01`; };
const tagDays = tag => Math.round((dateMs(period(tag)[1]) - dateMs(tag.start_date)) / 86400000) + 1;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  console.log(`${req.method} ${url.pathname}${url.search}`);
  try {
    if (url.pathname === '/owner') { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (!url.pathname.startsWith('/api/')) {
      const asset = url.pathname.startsWith('/assets/') ? join(web, url.pathname) : join(web, 'index.html');
      const file = await readFile(asset);
      res.writeHead(200, { 'content-type': mime[extname(asset)] || 'application/octet-stream' }); res.end(file); return;
    }
    const owner = isOwner(url);
    const path = url.pathname;
    if (path === '/api/me') return json(res, { owner: true, viewing_as: owner ? 'owner' : 'visitor' });
    if (path === '/api/meta') {
      const visible = viewerTweets(owner);
      return json(res, {
      site_title: '트윗 아카이브', account_handle: 'archive_account', total_tweets: visible.length,
      first_date: visible[0]?.date_kst || null, last_date: visible.at(-1)?.date_kst || null,
      source_url: process.env.MOCK_SOURCE_URL === '' ? null : process.env.MOCK_SOURCE_URL || 'https://github.com/eiaserinnys/twitter-archive',
      last_collected_at: '2026-09-29T03:00:00Z',
      thresholds: { display: 0.7, search: 0.5 }, topics: responseTopics(owner),
      ...(owner ? { public_hidden_count: tweets.filter(isPublicHidden).length, rescore_estimate: estimate } : {}),
      });
    }
    if (path === '/api/timeline') {
      const currentTweets = viewerTweets(owner);
      const years = [...new Set(currentTweets.map(t => +t.date_kst.slice(0, 4)))].sort((a, b) => a - b)
        .map(year => { const list = currentTweets.filter(t => t.date_kst.startsWith(`${year}-`)); return { year, total: list.length, counts: counts(list, owner) }; });
      const shown = visibleTags(owner);
      const long = shown.filter(t => tagDays(t) >= 365);
      const short_counts = Object.fromEntries(years.map(({ year }) => [year, shown.filter(t => tagDays(t) < 365 && inYear(t, year)).length]));
      return json(res, { years, tags: { long, short_counts } });
    }
    const yearMatch = path.match(/^\/api\/timeline\/(\d{4})$/);
    if (yearMatch) {
      const year = +yearMatch[1];
      const currentTweets = viewerTweets(owner);
      const months = Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        const list = currentTweets.filter(t => t.date_kst.startsWith(`${year}-${pad(month)}-`));
        return { month, total: list.length, counts: counts(list, owner) };
      });
      return json(res, { year, months, tags: visibleTags(owner).filter(t => inYear(t, year)) });
    }
    if (path === '/api/tweets') {
      let list = viewerTweets(owner);
      const q = url.searchParams;
      if (owner && q.get('public_hidden') === '1') list = list.filter(isPublicHidden);
      if (q.has('year')) list = list.filter(t => t.date_kst.startsWith(`${q.get('year')}-`));
      if (q.has('month')) list = list.filter(t => +t.date_kst.slice(5, 7) === +q.get('month'));
      if (q.has('date')) list = list.filter(t => t.date_kst === q.get('date'));
      if (q.has('from')) list = list.filter(t => t.date_kst >= q.get('from'));
      if (q.has('to')) list = list.filter(t => t.date_kst <= q.get('to'));
      if (q.has('q')) list = list.filter(t => t.text.toLowerCase().includes(q.get('q').toLowerCase()));
      if (q.has('kind')) { const kinds = q.get('kind').split(','); list = list.filter(t => kinds.includes(t.kind)); }
      if (q.has('topics')) {
        const selected = q.get('topics').split(',');
        if (selected.some(id => { const topic = topics.find(t => t.id === id); return !topic || (owner ? topic.timeline_visibility === 'hidden' : topic.timeline_visibility !== 'public'); }))
          return json(res, { error: 'topic_not_allowed' }, 400);
        list = list.filter(t => t.topics.some(topic => selected.includes(topic.id)));
      }
      if (q.get('order') === 'desc') list.reverse();
      const total = list.length;
      const start = +(q.get('cursor') || 0), limit = Math.min(200, +(q.get('limit') || 50));
      list = list.slice(start, start + limit).map(t => visibleTweet(t, owner));
      return json(res, { tweets: list, next_cursor: start + limit < total ? String(start + limit) : null, total });
    }
    const tweetMatch = path.match(/^\/api\/tweets\/([^/]+)$/);
    if (tweetMatch && req.method === 'PATCH') {
      if (!owner) return json(res, { error: 'owner_only' }, 403);
      const tweet = tweets.find(item => item.id === tweetMatch[1]);
      if (!tweet) return json(res, { error: 'not_found' }, 404);
      const input = await body(req);
      if (!(input.visibility === null || input.visibility === 'private' || input.visibility === 'public'))
        return json(res, { error: 'invalid', message: 'Tweet visibility is invalid.' }, 400);
      tweet.visibility = input.visibility;
      return json(res, { visibility: tweet.visibility, public_hidden: isPublicHidden(tweet) });
    }
    if (path === '/api/on-this-day') {
      const md = url.searchParams.get('md');
      const currentTweets = viewerTweets(owner);
      const years = [...new Set(currentTweets.map(t => +t.date_kst.slice(0, 4)))].sort((a, b) => b - a).map(year => {
        const dates = [...new Set(currentTweets.filter(t => t.date_kst.startsWith(`${year}-`)).map(t => t.date_kst))];
        const target = `${year}-${md}`;
        const date = dates.sort((a, b) => Math.abs(dateMs(a) - dateMs(target)) - Math.abs(dateMs(b) - dateMs(target)) || a.localeCompare(b))[0];
        const list = currentTweets.filter(t => t.date_kst === date);
        return { year, date, distance_days: Math.abs(Math.round((dateMs(date) - dateMs(target)) / 86400000)), total: list.length, tweets: list.slice(0, 3).map(t => visibleTweet(t, owner)) };
      });
      return json(res, { md, years });
    }
    if (path === '/api/calendar') {
      const year = +url.searchParams.get('year'), month = +url.searchParams.get('month');
      const currentTweets = viewerTweets(owner);
      const dates = [...new Set(currentTweets.filter(t => t.date_kst.startsWith(`${year}-${pad(month)}-`)).map(t => t.date_kst))];
      const days = dates.map(date => {
        const list = currentTweets.filter(t => t.date_kst === date);
        const scores = {};
        for (const tweet of list) for (const topic of visibleTweet(tweet, owner).topics) scores[topic.id] = (scores[topic.id] || 0) + topic.score;
        const top_topic = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return { date, total: list.length, top_topic };
      });
      return json(res, { year, month, days });
    }
    if (path === '/api/tags' && req.method === 'GET') return json(res, { tags: visibleTags(owner) });
    if (path === '/api/search/presets' && req.method === 'GET') return json(res, { presets: searchPresets });
    if (path === '/api/search/presets' && req.method === 'PUT') {
      if (!owner) return json(res, { error: 'owner_only' }, 403);
      const input = await body(req);
      if (!Array.isArray(input.presets) || input.presets.length > 20
        || input.presets.some(preset => typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 40
          || typeof preset.query !== 'string' || !preset.query.trim() || preset.query.length > 200)) {
        return json(res, { error: 'invalid', message: 'Search presets are invalid.' }, 400);
      }
      searchPresets = input.presets.map(({ label, query }) => makePreset(label, query));
      return json(res, { presets: searchPresets });
    }
    if (path === '/api/search' && req.method === 'POST') {
      const input = await body(req);
      if (!owner) {
        if (Object.hasOwn(input, 'q')) return json(res, {
          error: 'free_query_disabled', message: '공개 버전에서는 API 호출 비용 때문에 자유 검색어가 제한됩니다.',
        }, 403);
        const preset = searchPresets.find(item => item.id === input.preset_id);
        return preset ? json(res, searchResponse(preset.query, false)) : json(res, { error: 'not_found' }, 404);
      }
      return json(res, { error: 'not_found' }, 404);
    }
    if (req.method !== 'GET' && !owner) return json(res, { error: 'owner_only' }, 403);
    const histogramMatch = path.match(/^\/api\/topics\/([^/]+)\/score-histogram$/);
    if (histogramMatch && req.method === 'GET') {
      if (!owner) return json(res, { error: 'owner_only' }, 403);
      const id = histogramMatch[1];
      if (!topics.some(topic => topic.id === id)) return json(res, { error: 'not_found' }, 404);
      const buckets = Array(20).fill(0);
      for (const values of scores.values()) if (values[id] !== undefined) buckets[Math.min(19, Math.floor(values[id] * 20))]++;
      return json(res, { buckets });
    }
    if (path === '/api/topics' && req.method === 'POST') {
      const input = await body(req);
      if (input.public_hide_threshold !== undefined && !(input.public_hide_threshold === null || (typeof input.public_hide_threshold === 'number' && input.public_hide_threshold >= 0 && input.public_hide_threshold <= 1)))
        return json(res, { error: 'invalid', message: 'Topic fields are invalid.' }, 400);
      const topic = { ...input, id: `t_${Math.random().toString(36).slice(2, 10)}`, version: String(Date.now()), sort_order: topics.length, scored: 0 };
      topics.push(topic); return json(res, { topic, rescore_estimate: estimate });
    }
    const topicMatch = path.match(/^\/api\/topics\/([^/]+)$/);
    if (topicMatch) {
      const topic = topics.find(t => t.id === topicMatch[1]);
      if (!topic) return json(res, { error: 'not_found' }, 404);
      if (req.method === 'DELETE') { topics.splice(topics.indexOf(topic), 1); return json(res, { ok: true }); }
      if (req.method === 'PATCH') {
        const input = await body(req);
        if (input.public_hide_threshold !== undefined && !(input.public_hide_threshold === null || (typeof input.public_hide_threshold === 'number' && input.public_hide_threshold >= 0 && input.public_hide_threshold <= 1)))
          return json(res, { error: 'invalid', message: 'Topic fields are invalid.' }, 400);
        const rescored = input.question !== undefined && input.question !== topic.question;
        Object.assign(topic, input);
        if (rescored) { topic.version = String(Date.now()); topic.scored = 0; }
        return json(res, { topic, rescored, rescore_estimate: estimate });
      }
    }
    if (path === '/api/tags' && req.method === 'POST') {
      const tag = { ...await body(req), id: `tag_${Math.random().toString(36).slice(2, 10)}` };
      tags.push(tag); return json(res, { tag });
    }
    const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
    if (tagMatch) {
      const tag = tags.find(t => t.id === tagMatch[1]);
      if (!tag) return json(res, { error: 'not_found' }, 404);
      if (req.method === 'DELETE') { tags = tags.filter(t => t.id !== tag.id); return json(res, { ok: true }); }
      if (req.method === 'PATCH') { Object.assign(tag, await body(req)); return json(res, { tag }); }
    }
    return json(res, { error: 'not_found' }, 404);
  } catch (error) {
    console.error(error);
    return json(res, { error: 'internal', message: String(error.message || error) }, 500);
  }
}).listen(+(process.env.MOCK_PORT || 4179), '127.0.0.1', () => console.log('mock server ready'));
