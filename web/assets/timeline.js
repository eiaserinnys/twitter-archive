import { get, ApiError } from './api.js';
import { $, el, pad, dateMs, dimOf, tagKinds, tagKind, tagTopics, tagSpan, periodText, lockIcon, tweetCard } from './dom.js';

const levels = [0, 1, 2, 4, 7, 11];
const level = value => levels.reduce((out, min, index) => value >= min ? index : out, 0);
const desktop = matchMedia('(min-width: 1080px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function createTimeline(ctx, { navigate, openSettings, searchFor }) {
  const allGrid = $('grid'), monthGrid = $('mgrid'), panel = $('panel'), scrim = $('scrim');
  const panelHead = $('panelHead'), feed = $('feed');
  let year = null, yearData = null, selection = null, lastTrigger = null, sheetOpen = false;
  let gridAll = null, gridMonth = null, requestNumber = 0;
  const years = () => ctx.timeline.years.map(row => row.year);
  const firstYear = () => years()[0];
  const lastYear = () => years().at(-1);
  const title = id => ctx.topicById.get(id)?.label || id;
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const tagById = id => ctx.tags.find(tag => tag.id === id);

  function track(tags, rows, shortCounts = null, monthly = false) {
    if (!tags.length && !shortCounts) return null;
    const kinds = tagKinds.map(([id]) => id).filter(id => tags.some(tag => tag.kind === id));
    const bars = [], dots = [];
    tags.forEach(tag => {
      const span = tagSpan(tag);
      const length = Math.round((dateMs(span.end) - dateMs(span.start)) / 86400000) + 1;
      const lane = kinds.indexOf(tag.kind);
      if (monthly) {
        const y = year;
        const position = (date, end) => {
          const yy = +date.slice(0, 4), mm = +date.slice(5, 7), dd = +date.slice(8, 10);
          if (yy < y) return 0;
          if (yy > y) return 12;
          return mm - 1 + (end ? dd : dd - 1) / dimOf(yy, mm);
        };
        if (length < 28) {
          const month = +span.start.slice(0, 4) === y ? +span.start.slice(5, 7) : 1;
          dots.push({ tag, lane, top: (month - .5) / 12 });
        } else {
          const top = position(span.start, false) / 12, bottom = position(span.end, true) / 12;
          bars.push({ tag, lane, top, height: Math.max(0, bottom - top), before: span.start < `${y}-01-01`, after: span.end > `${y}-12-31` || span.ongoing });
        }
      } else {
        const position = date => {
          const yy = +date.slice(0, 4), month = +date.slice(5, 7);
          if (yy < firstYear()) return 0;
          if (yy > lastYear()) return rows.length;
          const index = rows.indexOf(yy);
          return index < 0 ? rows.filter(row => row < yy).length : index + (month - 1) / 12;
        };
        const start = position(span.start), end = Math.min(rows.length, position(span.end) + 1 / 12);
        bars.push({ tag, lane, top: start / rows.length, height: Math.max(0, (end - start) / rows.length),
          before: span.start < `${firstYear()}-01-01`, after: span.end > `${lastYear()}-12-31` || span.ongoing });
      }
    });
    return { kinds, bars, dots, counts: shortCounts, list: tags };
  }

  function trackCell(data, rows) {
    const td = el('td', 'track'); td.rowSpan = rows.length;
    const inside = el('div', 'track-in'); td.append(inside);
    const offset = data.counts ? 'var(--count-w) + ' : '';
    const left = lane => `calc(${offset}${lane} * (var(--lane-w) + var(--lane-gap)) + 2px)`;
    for (const bar of data.bars) {
      const button = el('button', `tbar k-${bar.tag.kind}`); button.type = 'button'; button.dataset.tag = bar.tag.id;
      button.style.cssText = `top:${(bar.top * 100).toFixed(3)}%;height:${(bar.height * 100).toFixed(3)}%;left:${left(bar.lane)};--k:${tagKind(bar.tag.kind)[2]}`;
      const mask = bar.before && bar.after ? 'linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 14px), transparent)'
        : bar.before ? 'linear-gradient(to bottom, transparent, #000 14px)'
          : bar.after ? 'linear-gradient(to top, transparent, #000 14px)' : '';
      if (mask) button.style.maskImage = mask;
      button.append(el('span', null, bar.tag.label));
      button.setAttribute('aria-label', `${bar.tag.label}, ${periodText(bar.tag)}`); inside.append(button);
    }
    for (const dot of data.dots) {
      const button = el('button', `tdot k-${dot.tag.kind}`); button.type = 'button'; button.dataset.tag = dot.tag.id;
      button.style.cssText = `top:${(dot.top * 100).toFixed(3)}%;left:calc(${left(dot.lane)} - 1px);--k:${tagKind(dot.tag.kind)[2]}`;
      button.setAttribute('aria-label', `${dot.tag.label}, ${periodText(dot.tag)}`); inside.append(button);
    }
    if (data.counts) rows.forEach((row, index) => {
      const count = data.counts[row]; if (!count) return;
      const button = el('button', 'tcnt'); button.type = 'button'; button.dataset.open = row;
      button.style.cssText = `top:${(index / rows.length * 100).toFixed(3)}%;height:${(100 / rows.length).toFixed(3)}%`;
      button.append(el('span', 'n-m', count), el('span', 'n-d', `태그 ${count}`));
      button.setAttribute('aria-label', `${row}년 짧은 기간 태그 ${count}개`); inside.append(button);
    });
    return td;
  }

  function buildGrid(table, rows, rowData, corner, tracks) {
    const cols = table.querySelector('colgroup'), head = table.tHead.rows[0], body = table.tBodies[0];
    cols.replaceChildren(); head.replaceChildren(); body.replaceChildren();
    if (tracks) {
      cols.append(el('col', 'c-tag'));
      table.style.setProperty('--tag-w', `calc(${tracks.counts ? 'var(--count-w) + ' : ''}${tracks.kinds.length} * (var(--lane-w) + var(--lane-gap)) + 4px)`);
      const th = el('th', 'tag-h'); th.append(el('span', null, '태그')); head.append(th);
    }
    cols.append(el('col', 'c-row'));
    const first = el('th', 'corner'); first.append(el('span', null, corner)); head.append(first);
    const cells = {};
    ctx.topics.forEach(topic => {
      const th = el('th'), button = el('button', 'topic-h'); button.type = 'button'; button.dataset.t = topic.id;
      button.title = topic.label; button.setAttribute('aria-label', `${topic.label} 전체`);
      button.append(el('span', null, topic.short)); th.append(button); head.append(th);
    });
    rows.forEach((row, index) => {
      const tr = el('tr'), data = rowData(row);
      if (tracks && index === 0) tr.append(trackCell(tracks, rows));
      const th = el('th'), rb = el('button', `row-h${data.total ? '' : ' none'}`); rb.type = 'button'; rb.dataset.r = row;
      if (corner === '연도') rb.append(el('span', 'yl', row), el('span', 'ys', `’${String(row).slice(2)}`));
      else rb.append(el('span', null, pad(row)));
      rb.setAttribute('aria-label', corner === '연도' ? `${row}년 월 연표 열기` : `${year}년 ${row}월 전체 트윗 ${data.total}개`);
      th.append(rb); tr.append(th); cells[row] = {};
      ctx.topics.forEach(topic => {
        const td = el('td'), count = data.counts[topic.id] || 0;
        const cell = el(count ? 'button' : 'span', 'cell', count ? String(count) : '');
        if (count) cell.type = 'button'; else cell.append(el('span', 'sr-only', '트윗 없음'));
        cell.dataset.l = level(count); cell.dataset.r = row; cell.dataset.t = topic.id;
        cell.setAttribute('aria-label', `${row}${corner === '월' ? '월' : '년'} ${topic.label} ${count}개`);
        td.append(cell); tr.append(td); cells[row][topic.id] = cell;
      });
      body.append(tr);
    });
    return cells;
  }

  function renderStrip(box, tracks, scope) {
    const fragment = document.createDocumentFragment();
    const header = el('div', 'ts-head'); header.append(el('span', 'label', '기간 태그'));
    if (ctx.owner && !ctx.preview) {
      const button = el('button', 'ts-set', '설정'); button.type = 'button'; button.addEventListener('click', openSettings); header.append(button);
    }
    fragment.append(header);
    const list = tracks?.list || [];
    if (list.length) {
      const kinds = el('ul', 'ts-kinds');
      tagKinds.filter(([id]) => list.some(tag => tag.kind === id)).forEach(([, label, color]) => {
        const item = el('li'), swatch = el('i'); swatch.style.setProperty('--k', color); item.append(swatch, label); kinds.append(item);
      });
      fragment.append(kinds);
      const chips = el('div', 'ts-list');
      for (const tag of list) {
        const button = el('button', 'tagchip'); button.type = 'button'; button.dataset.tag = tag.id;
        const swatch = el('i'); swatch.style.setProperty('--k', tagKind(tag.kind)[2]);
        button.append(swatch, el('b', null, tag.label), el('span', null, periodText(tag, true)));
        if (tag.visibility === 'owner') button.append(lockIcon());
        chips.append(button);
      }
      fragment.append(chips);
    } else fragment.append(el('p', 'ts-note', scope === 'all' ? '기간 태그가 없습니다.' : '이 해와 겹치는 기간 태그가 없습니다.'));
    box.replaceChildren(fragment);
  }

  function renderAll() {
    const rows = ctx.timeline.years;
    $('yearCount').textContent = rows.length;
    document.querySelectorAll('.tcount').forEach(node => { node.textContent = ctx.topics.length; });
    const tracks = track(ctx.timeline.tags.long, years(), ctx.timeline.tags.short_counts);
    gridAll = buildGrid(allGrid, years(), year => rows.find(row => row.year === year), '연도', tracks);
    renderStrip($('allTags'), tracks, 'all');
    $('tlFoot').textContent = `칸 숫자는 주제 점수 ${ctx.meta.thresholds.display} 이상인 트윗 수입니다. 한 트윗은 여러 주제에 들 수 있습니다.`;
    paintGrid();
  }

  function renderMonth() {
    const tracks = track(yearData.tags, Array.from({ length: 12 }, (_, i) => i + 1), null, true);
    gridMonth = buildGrid(monthGrid, Array.from({ length: 12 }, (_, i) => i + 1), month => yearData.months[month - 1], '월', tracks);
    renderStrip($('yearTags'), tracks, 'year');
    $('yvCrumb').textContent = year; $('yvTitle').textContent = `${year}년`;
    $('yvSub').innerHTML = `월 12 × 주제 ${ctx.topics.length}<br>트윗 ${ctx.timeline.years.find(row => row.year === year)?.total || 0}개`;
    const index = years().indexOf(year), previous = years()[index - 1], next = years()[index + 1];
    $('yvPrev').disabled = !previous; $('yvNext').disabled = !next;
    $('yvPrev').querySelector('.lab').textContent = previous || '처음';
    $('yvNext').querySelector('.lab').textContent = next || '끝';
    $('yearAllBtn').innerHTML = `이 해 전체 트윗 ${ctx.timeline.years[index]?.total || 0}개 <span class="arr">→</span>`;
    $('yvFoot').textContent = `칸에 세지 않은 트윗도 월 번호를 누르면 볼 수 있습니다.`;
    paintGrid();
  }

  function paintGrid() {
    for (const table of [allGrid, monthGrid]) {
      table.classList.remove('dim');
      table.querySelectorAll('[aria-current]').forEach(node => node.removeAttribute('aria-current'));
      table.querySelectorAll('.cell.on, .tbar.on, .tdot.on').forEach(node => node.classList.remove('on'));
    }
    document.querySelectorAll('.tagchip.on').forEach(node => node.classList.remove('on'));
    const s = selection;
    $('recentBtn').classList.toggle('acid', !!s?.recent);
    $('yearAllBtn').classList.toggle('acid', !!s && year !== null && s.y === year && !s.m && !s.t);
    if (!s) return;
    if (s.tag) { document.querySelectorAll(`[data-tag="${CSS.escape(s.tag)}"]`).forEach(node => node.classList.add('on')); return; }
    if (s.recent) return;
    const table = year === null ? allGrid : monthGrid, grid = year === null ? gridAll : gridMonth;
    if (!grid || (year !== null && s.y !== year)) return;
    const row = year === null ? s.y : s.m;
    if (row != null) table.querySelector(`.row-h[data-r="${row}"]`)?.setAttribute('aria-current', 'true');
    if (s.t) table.querySelector(`.topic-h[data-t="${CSS.escape(s.t)}"]`)?.setAttribute('aria-current', 'true');
    if (row != null && s.t && grid[row]?.[s.t]) grid[row][s.t].setAttribute('aria-current', 'true');
    else if (row != null || s.t) {
      table.classList.add('dim');
      table.querySelectorAll(`.cell${row != null ? `[data-r="${row}"]` : ''}${s.t ? `[data-t="${CSS.escape(s.t)}"]` : ''}`).forEach(node => node.classList.add('on'));
    }
  }

  function queryFor(s) {
    if (s.publicHidden) return { public_hidden: 1 };
    if (s.recent) return { order: 'desc', limit: 20 };
    if (s.tag) {
      const tag = tagById(s.tag), span = tagSpan(tag);
      const related = tagTopics[tag.kind] || [];
      return { from: span.start, to: span.end, ...(!s.all && !s.noTopicFilter && related.length ? { topics: related.join(',') } : {}) };
    }
    return { ...(s.y ? { year: s.y } : {}), ...(s.m ? { month: s.m } : {}), ...(s.t ? { topics: s.t } : {}) };
  }

  function shift(s, direction) {
    if (!s || s.recent || s.tag || !s.y) return null;
    if (s.m) {
      let y = s.y, m = s.m + direction;
      if (m < 1) { y--; m = 12; } else if (m > 12) { y++; m = 1; }
      return years().includes(y) ? { y, m, t: s.t } : null;
    }
    const y = years()[years().indexOf(s.y) + direction];
    return y ? { y, t: s.t } : null;
  }

  function panelHeading(s, total) {
    $('pExtra').hidden = true; $('pExtra').replaceChildren();
    $('prevBtn').hidden = $('nextBtn').hidden = true;
    if (s.tag) {
      const tag = tagById(s.tag), related = tagTopics[tag.kind] || [];
      $('pKicker').textContent = `TAG / ${tagKind(tag.kind)[1]}${tag.visibility === 'owner' ? ' / 나만' : ''}`;
      $('pTitle').textContent = tag.label; $('pSub').textContent = periodText(tag);
      const extra = $('pExtra');
      if (tag.note) extra.append(el('p', 'p-memo', tag.note));
      const actions = el('div', 'p-actions');
      if (related.length && !s.noTopicFilter) {
        const toggle = el('button', `btn${s.all ? ' acid' : ''}`, s.all ? `${related.map(title).join(', ')}만 보기` : '전체 보기');
        toggle.type = 'button'; toggle.addEventListener('click', () => select({ tag: s.tag, all: !s.all })); actions.append(toggle);
      }
      if (ctx.owner && !ctx.preview) {
        const search = el('button', 'btn', '이 이름으로 검색 →'); search.type = 'button'; search.addEventListener('click', () => searchFor(tag.label)); actions.append(search);
      }
      if (ctx.owner && !ctx.preview) {
        const edit = el('button', 'btn', '수정'); edit.type = 'button'; edit.addEventListener('click', () => openSettings(tag.id)); actions.append(edit);
      }
      extra.append(actions); extra.hidden = false;
      return;
    }
    if (s.publicHidden) {
      $('pKicker').textContent = 'OWNER / 공개 숨김';
      $('pTitle').textContent = '공개에서 숨겨지는 트윗';
      $('pSub').textContent = `트윗 ${total}개`;
      $('prevBtn').hidden = $('nextBtn').hidden = true;
      return;
    }
    const name = s.t ? title(s.t) : '전체';
    $('pKicker').textContent = s.recent ? 'LATEST / 새로 들어온 순' : s.m ? `${s.y}.${pad(s.m)}${s.t ? ` × ${name}` : ' / 이 달 전체'}` : s.y ? `${s.y}${s.t ? ` × ${name}` : ' / 이 해 전체'}` : 'ALL YEARS / 전체 기간';
    $('pTitle').textContent = s.recent ? '최근 트윗' : s.m ? `${s.y}년 ${s.m}월 ${name}` : s.y ? `${s.y}년 ${name}` : name;
    $('pSub').textContent = `트윗 ${total}개, ${s.recent ? '새로 들어온 순' : '오래된 순'}`;
    const previous = shift(s, -1), next = shift(s, 1);
    if (s.y) {
      $('prevBtn').hidden = $('nextBtn').hidden = false;
      $('prevBtn').disabled = !previous; $('nextBtn').disabled = !next;
      $('prevYr').textContent = previous ? previous.m ? `${previous.y}.${pad(previous.m)}` : previous.y : '처음';
      $('nextYr').textContent = next ? next.m ? `${next.y}.${pad(next.m)}` : next.y : '끝';
    }
  }

  async function renderPanel(s) {
    const token = ++requestNumber;
    feed.replaceChildren(el('li', 'empty-row', '트윗을 불러오는 중…'));
    let params = queryFor(s), page;
    try {
      page = await get('/api/tweets', { ...params, limit: params.limit || 200 });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'topic_not_allowed' && s.tag) {
        s.noTopicFilter = true;
        params = { ...params }; delete params.topics;
        page = await get('/api/tweets', { ...params, limit: 200 });
      } else throw error;
    }
    if (token !== requestNumber) return;
    panelHeading(s, page.total);
    const items = page.tweets;
    feed.replaceChildren();
    if (!items.length) feed.append(el('li', 'empty-row', '여기에 해당하는 트윗이 없습니다.'));
    else items.forEach(tweet => feed.append(tweetCard(tweet, ctx, { selectedTopic: s.t })));
    let cursor = page.next_cursor;
    if (cursor) {
      const more = el('button', 'more', '더 보기'); more.type = 'button'; $('panelBody').append(more);
      more.addEventListener('click', async () => {
        const next = await get('/api/tweets', { ...params, limit: 200, cursor });
        if (token !== requestNumber) return;
        next.tweets.forEach(tweet => feed.append(tweetCard(tweet, ctx, { selectedTopic: s.t })));
        cursor = next.next_cursor; if (!cursor) more.remove();
      });
    }
    $('panelBody').scrollTop = 0;
  }

  function select(s, trigger) {
    selection = s; lastTrigger = trigger || lastTrigger;
    $('panelBody').querySelector(':scope > .more')?.remove();
    paintGrid(); renderPanel(s).catch(error => { feed.replaceChildren(el('li', 'empty-row', `트윗을 불러오지 못했습니다: ${error.message}`)); });
    if (!desktop.matches) openSheet();
  }

  const spring = { x: 0, v: 0, raf: 0, target: 0 };
  const closedY = () => panel.offsetHeight + 24;
  function applyY(value) {
    spring.x = value; panel.style.transform = `translate3d(0, ${value}px, 0)`;
    scrim.style.opacity = Math.max(0, Math.min(1, 1 - value / closedY()));
  }
  function animateTo(target, velocity = 0, done) {
    cancelAnimationFrame(spring.raf); spring.target = target; spring.v = velocity;
    if (reduceMotion.matches) { applyY(target); done?.(); return; }
    const k = Math.pow(2 * Math.PI / .34, 2), damping = 4 * Math.PI / .34;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      const acceleration = -k * (spring.x - target) - damping * spring.v;
      spring.v += acceleration * dt; applyY(spring.x + spring.v * dt);
      if (Math.abs(spring.v) < 8 && Math.abs(spring.x - target) < .5) { applyY(target); done?.(); return; }
      spring.raf = requestAnimationFrame(step);
    };
    spring.raf = requestAnimationFrame(step);
  }
  function openSheet() {
    if (desktop.matches) return;
    sheetOpen = true; panel.inert = false; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    if (!panel.classList.contains('presented')) { panel.classList.add('presented'); applyY(closedY()); }
    scrim.hidden = false; document.documentElement.classList.add('sheet-open'); animateTo(0);
    requestAnimationFrame(() => $('pTitle').focus({ preventScroll: true }));
  }
  function closeSheet(silent = false) {
    if (desktop.matches || !sheetOpen) return;
    sheetOpen = false; requestNumber++;
    const done = () => { panel.classList.remove('presented'); panel.inert = true; scrim.hidden = true; document.documentElement.classList.remove('sheet-open'); };
    if (silent) { cancelAnimationFrame(spring.raf); applyY(closedY()); done(); } else animateTo(closedY(), 0, done);
    selection = null; paintGrid(); if (!silent) lastTrigger?.focus({ preventScroll: true });
  }
  let drag = null;
  panelHead.addEventListener('pointerdown', event => {
    if (!sheetOpen || event.button > 0 || event.target.closest('button')) return;
    drag = { id: event.pointerId, start: spring.x, y: event.clientY, time: event.timeStamp };
    panelHead.setPointerCapture(event.pointerId);
  });
  panelHead.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    applyY(Math.max(-40, drag.start + event.clientY - drag.y));
  });
  panelHead.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const velocity = (event.clientY - drag.y) / Math.max(.01, (event.timeStamp - drag.time) / 1000);
    const close = spring.x + velocity * .12 > closedY() * .45; drag = null;
    if (close) closeSheet(); else animateTo(0, velocity);
  });
  panelHead.addEventListener('pointercancel', () => { drag = null; animateTo(0); });
  scrim.addEventListener('click', () => closeSheet());
  $('closeBtn').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && sheetOpen) closeSheet(); });

  function syncLayout() {
    cancelAnimationFrame(spring.raf);
    if (desktop.matches) {
      sheetOpen = false; panel.inert = false; panel.removeAttribute('role'); panel.removeAttribute('aria-modal');
      panel.style.transform = ''; panel.classList.add('presented'); scrim.hidden = true; document.documentElement.classList.remove('sheet-open');
      if (!selection) select({ recent: true });
    } else if (!sheetOpen) {
      panel.classList.remove('presented'); panel.inert = true; panel.style.transform = '';
    }
  }
  desktop.addEventListener('change', syncLayout);

  async function openYear(value, route = true) {
    year = value; yearData = await get(`/api/timeline/${value}`);
    $('allView').hidden = true; $('yearView').hidden = false;
    renderMonth();
    if (route) navigate(`/year/${value}`);
    if (desktop.matches) select({ y: value }); else closeSheet(true);
    if (route) window.scrollTo(0, document.querySelector('.tabs').offsetTop);
  }
  function closeYear(route = true) {
    year = null; yearData = null; $('yearView').hidden = true; $('allView').hidden = false;
    if (route) navigate('/'); closeSheet(true);
    if (desktop.matches) select({ recent: true });
  }

  function openPublicHidden(route = true) {
    select({ publicHidden: true });
    if (route) navigate('/?public_hidden=1');
  }
  function gridClick(event, month) {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.tag) { select({ tag: button.dataset.tag, all: false }, button); return; }
    if (button.dataset.open) { openYear(+button.dataset.open); return; }
    if (!month && button.classList.contains('row-h')) { openYear(+button.dataset.r); return; }
    select({ y: month ? year : button.dataset.r ? +button.dataset.r : null,
      m: month && button.dataset.r ? +button.dataset.r : null, t: button.dataset.t || null }, button);
  }
  allGrid.addEventListener('click', event => gridClick(event, false));
  monthGrid.addEventListener('click', event => gridClick(event, true));
  document.querySelectorAll('.tagstrip').forEach(box => box.addEventListener('click', event => {
    const button = event.target.closest('button.tagchip'); if (button) select({ tag: button.dataset.tag, all: false }, button);
  }));
  $('recentBtn').addEventListener('click', event => select({ recent: true }, event.currentTarget));
  $('yvBack').addEventListener('click', closeYear);
  $('yvPrev').addEventListener('click', () => { const previous = years()[years().indexOf(year) - 1]; if (previous) openYear(previous); });
  $('yvNext').addEventListener('click', () => { const next = years()[years().indexOf(year) + 1]; if (next) openYear(next); });
  $('yearAllBtn').addEventListener('click', event => select({ y: year }, event.currentTarget));
  $('prevBtn').addEventListener('click', () => { const next = shift(selection, -1); if (next) select(next); });
  $('nextBtn').addEventListener('click', () => { const next = shift(selection, 1); if (next) select(next); });
  document.querySelectorAll('.ramp').forEach(ramp => ['0', '1', '2~3', '4~6', '7~10', '11+'].forEach((label, index) => {
    const item = el('li', null, label); item.dataset.l = index; ramp.append(item);
  }));

  renderAll(); syncLayout();
  return {
    openYear,
    closeYear,
    closeSheet,
    openPublicHidden,
    async goTopic(y, topic) { await openYear(y); select({ y, t: topic }); },
    refresh() { renderAll(); if (year) openYear(year, false); else if (desktop.matches) select({ recent: true }); },
    currentYear: () => year,
  };
}
