import { get, search, ApiError } from './api.js';
import { $, el, pad, kindLabels, tweetCard } from './dom.js';

const examples = [
  '몇 년 전 봤던 영화 이야기', '이사하던 무렵',
  '처음 산 게임기', '일이 막혔다가 풀린 날',
];
const stepNames = ['주제와 시기, 전략 판정', '후보 추림', '순위 매김'];

export function createSearch(ctx, { navigate, showTab }) {
  const input = $('q'), main = $('srMain');
  const filters = { topics: new Set(), kinds: new Set(), from: null, to: null };
  let currentQuery = '', requestNumber = 0, lastVisitorMode, presets = [], presetError = null;
  const visitorMode = () => !ctx.owner || ctx.preview;
  const minYear = () => ctx.timeline.years[0]?.year;
  const maxYear = () => ctx.timeline.years.at(-1)?.year;

  function filterBody() {
    return {
      q: currentQuery,
      ...(filters.topics.size ? { topics: [...filters.topics] } : {}),
      ...(filters.from ? { from: `${filters.from}-01-01` } : {}),
      ...(filters.to ? { to: `${filters.to}-12-31` } : {}),
      ...(filters.kinds.size ? { kinds: [...filters.kinds] } : {}),
    };
  }

  function drawFilters() {
    const topics = $('fTopics'); topics.replaceChildren();
    ctx.searchTopics.forEach(topic => {
      const button = el('button', 'tg'); button.type = 'button'; button.dataset.t = topic.id;
      button.setAttribute('aria-pressed', String(filters.topics.has(topic.id)));
      const swatch = el('i'); swatch.style.background = topic.color;
      button.append(swatch, topic.label); topics.append(button);
    });
    const kinds = $('fKinds'); kinds.replaceChildren();
    Object.entries(kindLabels).forEach(([kind, label]) => {
      const button = el('button', 'tg', label); button.type = 'button'; button.dataset.k = kind;
      button.setAttribute('aria-pressed', String(filters.kinds.has(kind))); kinds.append(button);
    });
    for (const id of ['fFrom', 'fTo']) {
      const select = $(id); select.replaceChildren(new Option('전체', ''));
      for (let year = minYear(); year <= maxYear(); year++) select.append(new Option(year, year));
      select.value = filters[id === 'fFrom' ? 'from' : 'to'] || '';
    }
    $('fCount').textContent = [filters.topics.size > 0, filters.kinds.size > 0, !!filters.from || !!filters.to].filter(Boolean).length ? ' 켬' : '';
  }

  function idle() {
    const box = el('div', 'idle'), big = el('p', 'big');
    big.append('기억나는 대로 적으면, ', el('em', null, '뜻으로'), ' 찾습니다.');
    const list = el('ol');
    stepNames.forEach((name, index) => {
      const row = el('li'); row.append(el('b', null, pad(index + 1)), el('span', null, name)); list.append(row);
    });
    box.append(big, list); main.replaceChildren(box);
  }

  function publicIdle() { main.replaceChildren(); }

  function syncSearchMode() {
    const visitor = visitorMode();
    $('searchForm').hidden = visitor;
    $('searchIntro').hidden = visitor;
    $('exList').hidden = visitor;
    $('filters').hidden = visitor;
    $('publicSearch').hidden = !visitor;
  }

  function drawPresetChips() {
    const chips = $('presetChips');
    chips.hidden = presets.length === 0;
    chips.replaceChildren(...presets.map(preset => {
      const button = el('button', 'tg preset-chip', preset.label);
      button.type = 'button'; button.title = preset.query;
      button.addEventListener('click', () => runPreset(preset));
      return button;
    }));
    const error = $('presetLoadError');
    error.hidden = !presetError;
    error.textContent = presetError ? `검색 문구를 불러오지 못했습니다: ${presetError}` : '';
  }

  async function refreshPresets() {
    try {
      const response = await get('/api/search/presets');
      presets = response.presets;
      presetError = null;
    } catch (error) {
      presets = [];
      presetError = error instanceof Error ? error.message : String(error);
    }
    drawPresetChips();
  }

  function resultHeader(label, note) {
    const head = el('div', 'res-head');
    head.append(el('span', 'mode', label), el('h3', null, `“${currentQuery}”`), el('p', 'note', note));
    return head;
  }

  function stagesBox() {
    const box = el('div', 'replay-box'), top = el('div', 'replay-top');
    top.append(el('b', null, '● 검색'), el('span', null, '세 단계로 찾는 중')); box.append(top);
    stepNames.forEach((name, index) => {
      const step = el('div', `step${index === 0 ? ' run' : ''}`); step.dataset.step = index;
      const bar = el('span', 'bar'); bar.append(el('i'));
      step.append(el('span', 'n', pad(index + 1)), el('span', 'nm', name), el('span', 'val', ''), bar);
      box.append(step);
    });
    return box;
  }

  function fillStages(box, response) {
    const judged = response.judged || {};
    const labels = (judged.topics || []).map(({ id, score }) => `${ctx.topicById.get(id)?.label || id} ${score.toFixed(2)}`).join(', ');
    const period = judged.period ? `${judged.period.from} ~ ${judged.period.to}` : '시기 단서 없음';
    const stageMs = Object.fromEntries((response.stages || []).map(stage => [stage.name, stage.ms]));
    const values = [
      `${labels || '주제 단서 없음'} / ${period}${stageMs.judge != null ? ` · ${stageMs.judge}ms` : ''}`,
      `후보 ${response.candidates}개${stageMs.candidates != null ? ` · ${stageMs.candidates}ms` : ''}`,
      `결과 ${response.results.length}개${stageMs.rank != null ? ` · ${stageMs.rank}ms` : ''}`,
    ];
    box.querySelectorAll('.step').forEach((step, index) => {
      step.classList.remove('run'); step.classList.add('done');
      step.querySelector('.val').textContent = values[index];
    });
    box.querySelector('.replay-top span').textContent = `후보 ${response.candidates}개`;
  }

  function renderSearchResponse(response) {
    fillStages(main.querySelector('.replay-box'), response);
    const head = main.querySelector('.res-head');
    if (response.intent === 'many') head.querySelector('.mode').textContent = 'SEARCH / 모아 보기';
    const chips = el('div', 'toggles'); chips.style.marginTop = '12px';
    chips.setAttribute('aria-label', '선택된 검색 전략');
    (response.strategies || []).filter(strategy => strategy.selected)
      .forEach(strategy => chips.append(el('span', 'tg', strategy.label)));
    if (chips.childElementCount) head.append(chips);
    main.append(renderResults(response.results, response.results.length,
      response.fallback && response.results.length ? '정확히 맞는 트윗은 없어 관련 트윗을 보여 드립니다' : null));
  }

  function renderResults(items, total, note, nextPage = null) {
    const box = el('div');
    box.append(el('div', 'hidden-note', `결과 ${total}개, 연도별`));
    if (note) box.append(el('p', 'why-all', note));
    if (!items.length) {
      const empty = el('div', 'empty'); empty.append(el('span', 'zero', '0'), el('h3', null, '맞는 트윗이 없습니다'), el('p', null, '다른 낱말이나 문장으로 검색해 보세요.'));
      box.append(empty); return box;
    }
    const list = el('ul', 'results');
    function add(rows) {
      const groups = new Map();
      rows.forEach(({ tweet, why }) => {
        const year = tweet.date_kst.slice(0, 4);
        if (!groups.has(year)) groups.set(year, []);
        groups.get(year).push({ tweet, why });
      });
      [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([year, tweets]) => {
        const separator = el('li', 'sep'); separator.append(el('b', null, year), el('span', null, `${tweets.length}개`));
        list.append(separator);
        tweets.forEach(({ tweet, why }) => list.append(tweetCard(tweet, ctx, { why })));
      });
    }
    add(items); box.append(list);
    if (nextPage) {
      const button = el('button', 'more', '더 보기'); button.type = 'button';
      button.addEventListener('click', async () => {
        const next = await nextPage(); add(next.items);
        if (!next.next) button.remove(); else nextPage = next.next;
      });
      box.append(button);
    }
    return box;
  }

  async function fallback() {
    const params = { q: currentQuery, ...(filters.from ? { from: `${filters.from}-01-01` } : {}),
      ...(filters.to ? { to: `${filters.to}-12-31` } : {}),
      ...(filters.kinds.size ? { kind: [...filters.kinds].join(',') } : {}), limit: 200 };
    const first = await get('/api/tweets', params);
    const convert = page => page.tweets.map(tweet => ({ tweet, why: `본문에 “${currentQuery}” 일치` }));
    function pageLoader(cursor) {
      return async () => {
        const page = await get('/api/tweets', { ...params, cursor });
        return { items: convert(page), next: page.next_cursor ? pageLoader(page.next_cursor) : null };
      };
    }
    main.replaceChildren(resultHeader('KEYWORD / 본문 일치', '뜻 검색은 준비 중입니다. 본문에서 일치하는 말을 보여 줍니다.'),
      renderResults(convert(first), first.total, null, first.next_cursor ? pageLoader(first.next_cursor) : null));
  }

  async function run(query, route = true) {
    if (visitorMode()) {
      if (route) navigate('/search');
      currentQuery = ''; input.value = '';
      $('searchForm').classList.remove('has-q');
      publicIdle();
      return;
    }
    currentQuery = query.trim(); input.value = currentQuery;
    $('searchForm').classList.toggle('has-q', !!currentQuery);
    showTab('search');
    if (route) navigate(`/search${currentQuery ? `?q=${encodeURIComponent(currentQuery)}` : ''}`);
    if (!currentQuery) { idle(); return; }
    const token = ++requestNumber;
    const box = stagesBox();
    main.replaceChildren(resultHeader('SEARCH / 뜻 검색', '주제와 시기, 전략을 판정하고 후보를 추린 뒤 뜻으로 순위를 매깁니다.'), box);
    const progress = setInterval(() => {
      const running = box.querySelector('.step.run');
      const next = running?.nextElementSibling;
      if (next) { running.classList.replace('run', 'done'); next.classList.add('run'); }
    }, 450);
    try {
      const response = await search(filterBody());
      if (token !== requestNumber) return;
      renderSearchResponse(response);
    } catch (error) {
      if (token !== requestNumber) return;
      if (error instanceof ApiError && [404, 501].includes(error.status)) await fallback();
      else if (error instanceof ApiError && error.status === 429) main.replaceChildren(resultHeader('SEARCH / 뜻 검색', '오늘 검색 한도를 다 썼습니다. 내일 다시 시도해 주세요.'));
      else main.replaceChildren(resultHeader('SEARCH / 뜻 검색', `검색에 실패했습니다: ${error.message}`));
    } finally { clearInterval(progress); }
  }

  async function runPreset(preset) {
    currentQuery = preset.query;
    input.value = '';
    $('searchForm').classList.remove('has-q');
    showTab('search'); navigate('/search');
    const token = ++requestNumber;
    const box = stagesBox();
    main.replaceChildren(resultHeader('SEARCH / 공개 문구', '설정한 공개 검색 문구로 찾습니다.'), box);
    const progress = setInterval(() => {
      const running = box.querySelector('.step.run');
      const next = running?.nextElementSibling;
      if (next) { running.classList.replace('run', 'done'); next.classList.add('run'); }
    }, 450);
    try {
      const response = await search({ preset_id: preset.id });
      if (token !== requestNumber) return;
      renderSearchResponse(response);
    } catch (error) {
      if (token !== requestNumber) return;
      if (error instanceof ApiError && error.status === 429) main.replaceChildren(resultHeader('SEARCH / 공개 문구', '오늘 검색 한도를 다 썼습니다. 내일 다시 시도해 주세요.'));
      else main.replaceChildren(resultHeader('SEARCH / 공개 문구', `검색에 실패했습니다: ${error.message}`));
    } finally { clearInterval(progress); }
  }

  $('exList').replaceChildren(...examples.map((label, index) => {
    const item = el('li'), button = el('button', 'ex'); button.type = 'button';
    button.append(el('span', 'ex-type', `0${index + 1} EXAMPLE`), el('span', 'ex-label', label), el('span', 'arr', '→'));
    button.addEventListener('click', () => run(label)); item.append(button); return item;
  }));
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); run(input.value); input.blur(); });
  input.addEventListener('input', () => { $('searchForm').classList.toggle('has-q', !!input.value); showTab('search'); });
  $('clearQ').addEventListener('click', () => { input.value = ''; run(''); input.focus(); });
  $('fTopics').addEventListener('click', event => {
    const button = event.target.closest('button[data-t]'); if (!button) return;
    const id = button.dataset.t; filters.topics.has(id) ? filters.topics.delete(id) : filters.topics.add(id);
    drawFilters(); if (currentQuery) run(currentQuery, false);
  });
  $('fKinds').addEventListener('click', event => {
    const button = event.target.closest('button[data-k]'); if (!button) return;
    const kind = button.dataset.k; filters.kinds.has(kind) ? filters.kinds.delete(kind) : filters.kinds.add(kind);
    drawFilters(); if (currentQuery) run(currentQuery, false);
  });
  $('fFrom').addEventListener('change', () => { filters.from = $('fFrom').value || null; drawFilters(); if (currentQuery) run(currentQuery, false); });
  $('fTo').addEventListener('change', () => { filters.to = $('fTo').value || null; drawFilters(); if (currentQuery) run(currentQuery, false); });
  $('fReset').addEventListener('click', () => { filters.topics.clear(); filters.kinds.clear(); filters.from = filters.to = null; drawFilters(); if (currentQuery) run(currentQuery, false); });
  function refresh() {
    drawFilters(); syncSearchMode();
    const visitor = visitorMode();
    if (visitor !== lastVisitorMode) {
      requestNumber += 1; currentQuery = ''; input.value = '';
      $('searchForm').classList.remove('has-q');
      if (visitor) publicIdle(); else idle();
      lastVisitorMode = visitor;
    }
    if (visitor) void refreshPresets();
  }

  refresh();
  return { run, refresh, refreshPresets };
}
