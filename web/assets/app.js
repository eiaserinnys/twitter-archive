import { get, isPreview } from './api.js';
import { basePath, withBase } from './base-path.js';
import { $, topicColors, shortOf } from './dom.js';
import { createTimeline } from './timeline.js';
import { createToday } from './today.js';
import { createSearch } from './search.js';
import { createSettings } from './settings.js';

const context = { owner: false, preview: isPreview(), meta: null, timeline: null, tags: [], topics: [], searchTopics: [], topicById: new Map() };
let timeline, today, finder, settings;
let tab = 'timeline', lastRoute = '/';
const routePath = () => location.pathname.slice(basePath.length);

function showTab(name) {
  const changed = tab !== name;
  if (changed && tab === 'timeline') timeline?.closeSheet(true);
  tab = name;
  for (const id of ['timeline', 'search', 'today']) {
    const selected = id === name, button = $(`t-${id}`);
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`p-${id}`).hidden = !selected;
  }
  if (changed) {
    const top = document.querySelector('.mast').getBoundingClientRect().bottom + window.scrollY - (context.preview ? 44 : 0);
    if (window.scrollY > top) window.scrollTo(0, top);
  }
}

function navigate(path, replace = false) {
  if (path !== '/settings') lastRoute = path;
  history[replace ? 'replaceState' : 'pushState'](null, '', withBase(path));
}

function paintTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $('themeBtn').textContent = dark ? 'LIGHT' : 'DARK';
  $('themeBtn').setAttribute('aria-label', dark ? '밝은 화면으로 바꾸기' : '어두운 화면으로 바꾸기');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0A0A0A' : '#F1F0EA';
}
$('themeBtn').addEventListener('click', () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('ta-hip-theme', document.documentElement.dataset.theme);
  paintTheme();
});
paintTheme();

function paintHeader() {
  const meta = context.meta;
  $('siteTitle').textContent = meta.site_title;
  $('handleLink').textContent = `@${meta.account_handle}`;
  $('handleLink').href = `https://x.com/${encodeURIComponent(meta.account_handle)}`;
  document.title = `@${meta.account_handle} ${meta.site_title}`;
  if (meta.first_date) $('since').textContent = `, ${+meta.first_date.slice(0, 4)}년 ${+meta.first_date.slice(5, 7)}월부터`;
  $('fullSize').textContent = meta.total_tweets.toLocaleString('ko-KR');
  if (meta.last_collected_at) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(meta.last_collected_at)).map(part => [part.type, part.value]));
    $('collected').textContent = `${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
    $('collected').nextElementSibling?.remove();
    $('collected').after(Object.assign(document.createElement('small'), { textContent: 'KST' }));
  } else $('collected').textContent = '없음';
  $('footNote').textContent = `주제 표시 기준 ${meta.thresholds.display} · 전체 트윗 ${meta.total_tweets.toLocaleString('ko-KR')}개`;
  document.documentElement.classList.toggle('visitor', !context.owner || context.preview);
  $('visitorBar').hidden = !context.preview;
  $('setBtn').hidden = !context.owner || context.preview;
  const authLink = $('authLink');
  authLink.hidden = context.preview;
  authLink.href = context.owner ? '/cdn-cgi/access/logout' : withBase('/owner');
  authLink.textContent = context.owner ? '로그아웃' : '로그인';
  $('visSwitch').setAttribute('aria-checked', String(context.preview));
  const sourceLink = $('sourceLink');
  sourceLink.hidden = !meta.source_url;
  if (meta.source_url) sourceLink.href = meta.source_url;
}

async function loadData() {
  const [me, meta, timelineData, tags] = await Promise.all([
    get('/api/me'), get('/api/meta'), get('/api/timeline'), get('/api/tags'),
  ]);
  context.owner = me.owner;
  context.preview = isPreview();
  context.meta = meta; context.timeline = timelineData; context.tags = tags.tags;
  const ordered = meta.topics.slice().sort((a, b) => a.sort_order - b.sort_order);
  const enriched = ordered.map((topic, index) => ({ ...topic, color: topicColors[index % topicColors.length], short: shortOf(topic.label) }));
  context.topicById = new Map(enriched.map(topic => [topic.id, topic]));
  const ownerView = me.owner && !context.preview;
  context.topics = enriched.filter(topic => topic.timeline_visibility === 'public' || (ownerView && topic.timeline_visibility === 'owner'));
  context.searchTopics = enriched.filter(topic => topic.search_visibility === 'public' || (ownerView && topic.search_visibility === 'owner'));
  context.searchEnabled = ownerView || meta.visitor_search !== 'off';
  $('t-search').hidden = !context.searchEnabled;
  context.meta.topics = enriched;
  paintHeader();
}

async function refreshData() {
  await loadData();
  timeline.refresh(); finder.refresh(); settings.refresh();
  if (tab === 'today') await today.refresh();
}

async function renderRoute() {
  const path = routePath();
  if (path !== '/settings' && settings?.isOpen()) $('settings').close();
  if (path === '/settings') {
    if (!context.owner || context.preview) { navigate('/', true); showTab('timeline'); timeline.closeYear(false); return; }
    showTab('timeline'); await settings.open(null, false); return;
  }
  if (/^\/year\/\d{4}$/.test(path)) {
    const year = +path.split('/')[2];
    if (!context.timeline.years.some(item => item.year === year)) { navigate('/', true); showTab('timeline'); return; }
    showTab('timeline'); await timeline.openYear(year, false);
    window.scrollTo(0, document.querySelector('.tabs').offsetTop); return;
  }
  if (path === '/search') {
    if (!context.searchEnabled) { navigate('/', true); showTab('timeline'); timeline.closeYear(false); return; }
    showTab('search'); await finder.run(new URLSearchParams(location.search).get('q') || '', false); return;
  }
  if (path === '/today') { showTab('today'); await today.showToday(); return; }
  if (/^\/day\/\d{4}-\d{2}-\d{2}$/.test(path)) {
    showTab('today'); await today.goDate(path.split('/')[2], false); return;
  }
  if (path === '/' && new URLSearchParams(location.search).get('public_hidden') === '1'
    && context.owner && !context.preview) {
    showTab('timeline'); timeline.closeYear(false); timeline.openPublicHidden(false); return;
  }
  showTab('timeline'); timeline.closeYear(false);
}

async function main() {
  await loadData();
  timeline = createTimeline(context, {
    navigate,
    openSettings: tagId => settings.open(tagId),
    searchFor: text => finder.run(text),
  });
  today = createToday(context, { navigate });
  finder = createSearch(context, { navigate, showTab });
  settings = createSettings(context, {
    navigate,
    onClose: () => { navigate(lastRoute, true); renderRoute(); },
    onPreview: async () => {
      if (routePath() === '/settings') navigate(lastRoute, true);
      await refreshData(); await renderRoute();
    },
    refreshData,
  });
  document.querySelector('.tabs').addEventListener('click', async event => {
    const button = event.target.closest('.tab'); if (!button) return;
    const name = button.dataset.tab; showTab(name);
    if (name === 'timeline') { timeline.closeYear(false); navigate('/'); }
    if (name === 'search') { navigate('/search'); await finder.run('', false); }
    if (name === 'today') { navigate('/today'); await today.showToday(); }
  });
  document.querySelector('.tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const tabs = ['timeline', 'search', 'today'].filter(id => !$(`t-${id}`).hidden), index = tabs.indexOf(tab);
    document.querySelector(`[data-tab="${tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]}"]`).click();
  });
  document.addEventListener('click', async event => {
    const chip = event.target.closest('button.chip');
    if (chip) { showTab('timeline'); await timeline.goTopic(+chip.dataset.y, chip.dataset.t); return; }
    const date = event.target.closest('button.tw-date');
    if (date) { showTab('today'); await today.goDate(date.dataset.date); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !document.documentElement.classList.contains('visitor')
      && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { event.preventDefault(); $('q').focus(); }
  });
  window.addEventListener('popstate', renderRoute);
  lastRoute = routePath() === '/settings' ? '/' : routePath() + location.search;
  await renderRoute();
}

main().catch(error => {
  console.error(error);
  document.querySelector('main').prepend(Object.assign(document.createElement('p'), {
    className: 'foot', textContent: `아카이브를 불러오지 못했습니다: ${error.message}`,
  }));
});
