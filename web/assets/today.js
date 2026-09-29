import { get } from './api.js';
import { $, el, pad, dot, dateMs, dimOf, weekdays, weekday, monthDay, kstToday, tweetCard } from './dom.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const desktop = matchMedia('(min-width: 1080px)');

export function createToday(ctx, { navigate }) {
  const current = { md: kstToday().slice(5), today: true, view: 'stack', expanded: new Set() };
  const cal = { year: +ctx.meta.last_date?.slice(0, 4) || new Date().getFullYear(), month: +kstToday().slice(5, 7), selected: null };
  let dayResult = null, calendar = null;
  const firstYear = () => ctx.timeline.years[0]?.year;
  const lastYear = () => ctx.timeline.years.at(-1)?.year;
  const nowYear = () => +kstToday().slice(0, 4);

  function setView(view) {
    current.view = view;
    $('vStack').setAttribute('aria-pressed', String(view === 'stack'));
    $('vCal').setAttribute('aria-pressed', String(view === 'cal'));
    $('stackWrap').hidden = view !== 'stack'; $('calWrap').hidden = view !== 'cal';
  }

  async function moreTweets(date, list, button, firstCount) {
    const result = await get('/api/tweets', { date, limit: 200 });
    result.tweets.slice(firstCount).forEach(tweet => list.append(tweetCard(tweet, ctx)));
    button.remove();
  }

  function renderStack() {
    const [month, day] = current.md.split('-').map(Number);
    $('tdTitleText').textContent = current.today ? 'N년 전 오늘' : `N년 전 ${month}월 ${day}일`;
    $('tdSub').innerHTML = `${month}월 ${day}일 기준, KST<br>14일 넘게 떨어진 해는 접음`;
    $('backToday').hidden = current.today;
    const fragment = document.createDocumentFragment();
    for (const item of dayResult?.years || []) {
      const year = item.year;
      const ago = nowYear() - year;
      const agoText = ago === 0 ? '올해' : `${ago}년 전`;
      const target = `${year}-${current.md}`;
      const signed = Math.round((dateMs(item.date) - dateMs(target)) / 86400000);
      const offset = signed === 0 ? '같은 날' : `${Math.abs(signed)}일 ${signed < 0 ? '앞' : '뒤'}`;
      const row = el('li', 'yr');
      const list = el('ul', 'yr-list');
      item.tweets.forEach(tweet => list.append(tweetCard(tweet, ctx)));
      if (item.distance_days > 14) {
        row.classList.add('far');
        const details = el('details'), summary = el('summary');
        const near = el('span', 'far-t'); near.append('가까운 날 ', el('b', null, monthDay(item.date)), `, ${offset}`);
        const action = el('span', 'far-x'); action.append(el('span', 'x-closed', `${item.total}개 +`), el('span', 'x-open', '접기 −'));
        summary.append(el('span', 'far-n', year), near, action);
        details.append(summary, list);
        details.addEventListener('toggle', () => {
          if (details.open && item.total > item.tweets.length && !details.dataset.loaded) {
            details.dataset.loaded = '1';
            get('/api/tweets', { date: item.date, limit: 200 }).then(result => {
              result.tweets.slice(item.tweets.length).forEach(tweet => list.append(tweetCard(tweet, ctx)));
            });
          }
        });
        row.append(details);
      } else {
        const head = el('div', 'yr-head'), when = el('span', 'yr-when');
        when.append(el('b', null, `${dot(item.date)} ${weekday(item.date)}`), `, ${offset}, ${item.total}개`);
        head.append(el('span', 'yr-n', year), el('span', 'yr-ago', agoText), when);
        row.append(head, list);
        if (item.total > item.tweets.length) {
          const more = el('button', 'more', `더 보기 +${item.total - item.tweets.length}`);
          more.type = 'button'; more.addEventListener('click', () => moreTweets(item.date, list, more, item.tweets.length));
          row.append(more);
        }
      }
      fragment.append(row);
    }
    $('stack').replaceChildren(fragment);
  }

  async function loadStack(md) {
    current.md = md;
    dayResult = await get('/api/on-this-day', { md });
    renderStack();
  }

  async function loadCalendar() {
    calendar = await get('/api/calendar', { year: cal.year, month: cal.month });
    await renderCalendar();
  }

  async function renderCalendar() {
    const { year, month, selected } = cal;
    const box = $('cal'), fragment = document.createDocumentFragment();
    const head = el('div', 'cal-head'), title = el('h3', 'cal-title', `${year}.${pad(month)}`);
    title.append(el('small', null, `${year}년 ${month}월, 트윗 있는 날 ${calendar.days.length}일`));
    const monthNav = el('div', 'cal-mnav');
    for (const direction of [-1, 1]) {
      const button = el('button', 'btn'); button.type = 'button';
      button.innerHTML = `<span class="arr">${direction < 0 ? '‹' : '›'}</span>`;
      button.setAttribute('aria-label', direction < 0 ? '이전 달' : '다음 달');
      button.disabled = direction < 0 ? year === firstYear() && month === 1 : year === lastYear() && month === 12;
      button.addEventListener('click', async () => {
        cal.month += direction;
        if (cal.month < 1) { cal.month = 12; cal.year--; }
        if (cal.month > 12) { cal.month = 1; cal.year++; }
        cal.selected = null; await loadCalendar();
      });
      monthNav.append(button);
    }
    head.append(title, monthNav); fragment.append(head);
    const yearNav = el('div', 'cal-ynav');
    for (const direction of [-1, 1]) {
      const yearNext = year + direction;
      const button = el('button', 'btn'); button.type = 'button';
      if (direction < 0) button.append(el('span', 'arr', '←'));
      button.append(el('span', null, `${yearNext}년 같은 무렵`));
      if (direction > 0) button.append(el('span', 'arr', '→'));
      button.disabled = yearNext < firstYear() || yearNext > lastYear();
      button.addEventListener('click', async () => { cal.year = yearNext; cal.selected = null; await loadCalendar(); });
      yearNav.append(button);
    }
    fragment.append(yearNav);
    const days = el('div', 'days'); days.setAttribute('role', 'group'); days.setAttribute('aria-label', `${year}년 ${month}월 달력`);
    weekdays.forEach((name, index) => days.append(el('span', `wd${index === 0 ? ' sun' : ''}`, name)));
    const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    for (let index = 0; index < firstDay; index++) days.append(el('span', 'day blank'));
    const byDate = new Map(calendar.days.map(day => [day.date, day]));
    for (let day = 1; day <= dimOf(year, month); day++) {
      const date = `${year}-${pad(month)}-${pad(day)}`, info = byDate.get(date);
      const cell = el(info ? 'button' : 'span', 'day'); cell.append(el('span', 'dn', day));
      if (date.slice(5) === current.md) cell.classList.add('ref');
      if (info) {
        cell.type = 'button'; cell.dataset.date = date; cell.setAttribute('aria-pressed', String(selected === date));
        const topic = ctx.topicById.get(info.top_topic), marker = el('span', 'dt'), swatch = el('i', topic ? '' : 'none');
        if (topic) swatch.style.background = topic.color;
        marker.append(swatch, topic?.short || ''); cell.append(marker);
        cell.setAttribute('aria-label', `${month}월 ${day}일 트윗 ${info.total}개`);
        cell.addEventListener('click', () => goDate(date));
      }
      days.append(cell);
    }
    fragment.append(days);
    const legend = el('ul', 'cal-legend');
    ctx.topics.forEach(topic => {
      const item = el('li'), swatch = el('i'); swatch.style.background = topic.color;
      item.append(swatch, topic.short); legend.append(item);
    });
    const reference = el('li', 'ref-key'); reference.append(el('i'), current.today ? '오늘 날짜' : '기준 날짜');
    legend.append(reference); fragment.append(legend);
    if (selected) {
      const result = await get('/api/tweets', { date: selected, limit: 200 });
      const view = el('div', 'dayview'); view.id = 'dayview';
      const header = el('div', 'dayview-head'); header.append(el('h3', null, `${dot(selected)} ${weekday(selected)}`), el('p', null, `${result.total}개`));
      const list = el('ul', 'feed'); result.tweets.forEach(tweet => list.append(tweetCard(tweet, ctx)));
      view.append(header, list); fragment.append(view);
    } else if (calendar.days.length) fragment.append(el('p', 'cal-note', '날짜를 누르면 그날 트윗이 아래에 나옵니다.'));
    else fragment.append(el('p', 'cal-note', '이 달에는 트윗이 없습니다.'));
    box.replaceChildren(fragment);
  }

  async function showToday() {
    current.today = true; current.md = kstToday().slice(5);
    await loadStack(current.md);
    const near = dayResult.years.find(item => item.distance_days <= 14) || dayResult.years[0];
    if (near) { cal.year = near.year; cal.month = +near.date.slice(5, 7); cal.selected = near.date; }
    setView('stack'); await loadCalendar();
  }

  async function goDate(date, route = true) {
    cal.year = +date.slice(0, 4); cal.month = +date.slice(5, 7); cal.selected = date;
    if (route) navigate(`/day/${date}`);
    setView('cal'); await loadCalendar();
    requestAnimationFrame(() => (desktop.matches ? $('dayview') : $('calWrap'))?.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'instant' : 'smooth' }));
  }

  $('vStack').addEventListener('click', () => setView('stack'));
  $('vCal').addEventListener('click', () => setView('cal'));
  $('randomBtn').addEventListener('click', async () => {
    const random = new Date(Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 365) * 86400000);
    current.today = false; await loadStack(`${pad(random.getUTCMonth() + 1)}-${pad(random.getUTCDate())}`);
    const near = dayResult.years[0]; if (near) { cal.year = near.year; cal.month = +near.date.slice(5, 7); cal.selected = near.date; }
    await loadCalendar();
  });
  $('backToday').addEventListener('click', showToday);

  return { showToday, goDate, refresh: () => current.view === 'cal' ? loadCalendar() : loadStack(current.md) };
}
