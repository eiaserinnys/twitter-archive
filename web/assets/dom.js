export const $ = id => document.getElementById(id);
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
export const pad = number => String(number).padStart(2, '0');
export const dot = date => date.replaceAll('-', '.');
export const shortOf = label => label.replace(/\s/g, '').slice(0, 2);
export const dateMs = date => Date.parse(`${date}T00:00:00Z`);
export const dimOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
export const weekday = date => weekdays[new Date(dateMs(date)).getUTCDay()];
export const monthDay = date => `${+date.slice(5, 7)}월 ${+date.slice(8, 10)}일`;
export const kstToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
export const topicColors = ['#FF5436', '#E8C200', '#4D9DFF', '#2FD27A', '#F062C8', '#8BE9FF', '#FF9A3D', '#A98BFF', '#C6F03A', '#E07BFF', '#D8B48A', '#27D6B0', '#F4F1E6'];
export const tagKinds = [
  ['career', '경력', 'var(--ink)'], ['game', '게임', '#2FD27A'],
  ['video', '영상', '#F062C8'], ['book', '책', '#FF9A3D'], ['other', '기타', '#9AA0A8'],
];
export const tagKind = id => tagKinds.find(([kind]) => kind === id) || tagKinds.at(-1);
export const tagTopics = { career: ['work'], game: ['games'], video: ['film', 'anime'], book: ['books'], other: [] };
export const kindLabels = { original: '원글', reply: '답글', self_reply: '이어 쓴 글', quote: '인용' };

export function tagSpan(tag) {
  return { start: tag.start_date, end: tag.end_date || kstToday(), ongoing: !tag.end_date };
}

export function periodText(tag, short = false) {
  const span = tagSpan(tag);
  const start = dot(span.start), end = dot(span.end);
  const range = span.ongoing ? `${start} ~ 진행 중` : start === end ? start : `${start} ~ ${end}`;
  if (short) return range.replace(' ~ ', '~');
  const days = Math.round((dateMs(span.end) - dateMs(span.start)) / 86400000) + 1;
  const months = Math.max(1, Math.round(days / 30.44));
  const duration = days < 28 ? (days === 1 ? '하루' : `${days}일`)
    : months < 12 ? `${months}개월` : `${Math.floor(months / 12)}년${months % 12 ? ` ${months % 12}개월` : ''}`;
  return `${range}, ${duration}`;
}

const linkPattern = /(https?:\/\/[^\s<>"'　]+)|(@[A-Za-z0-9_]{1,15})/g;
function linkify(target, text) {
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    const index = match.index;
    if (index > last) target.append(text.slice(last, index));
    const a = el('a');
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    if (match[1]) {
      let token = match[0];
      const trailing = token.match(/[.,!?)\]}」』’”]+$/)?.[0] || '';
      if (trailing) token = token.slice(0, -trailing.length);
      a.href = token;
      const shown = token.replace(/^https?:\/\/(www\.)?/, '');
      a.textContent = shown.length > 30 ? `${shown.slice(0, 29)}…` : shown;
      target.append(a, trailing);
    } else {
      a.href = `https://x.com/${match[0].slice(1)}`;
      a.textContent = match[0]; target.append(a);
    }
    last = index + match[0].length;
  }
  if (last < text.length) target.append(text.slice(last));
}

const xIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h7.5V11M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>';
export function lockIcon() {
  const template = document.createElement('template');
  template.innerHTML = '<svg class="lk-i" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="6" width="10" height="7.5" fill="currentColor"/><path d="M3.4 6.2V4.3a2.6 2.6 0 0 1 5.2 0v1.9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  return template.content.firstChild;
}

export function tweetCard(tweet, ctx, { why, selectedTopic } = {}) {
  const item = el('li', 'tw'), article = el('article'); item.append(article);
  const date = tweet.date_kst;
  const localTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(tweet.created_at));
  const meta = el('header', 'tw-meta');
  const dateButton = el('button', 'tw-date', dot(date)); dateButton.type = 'button'; dateButton.dataset.date = date;
  dateButton.setAttribute('aria-label', `${date} 달력에서 보기`);
  meta.append(dateButton, el('span', null, `${weekday(date)} ${localTime}`));
  if (tweet.kind !== 'original') meta.append(el('span', 'tw-kind', kindLabels[tweet.kind] || tweet.kind));
  const x = el('a', 'tw-x', 'X'); x.href = tweet.x_url; x.target = '_blank'; x.rel = 'noopener noreferrer';
  x.insertAdjacentHTML('beforeend', xIcon); x.setAttribute('aria-label', `${date} 트윗 X 원문 보기`);
  meta.append(x); article.append(meta);
  const context = tweet.quoted || tweet.parent;
  if (context?.text) {
    const box = el('div', 'tw-ctx'); box.append(el('small', null, tweet.quoted ? '인용한 글' : tweet.kind === 'self_reply' ? '앞 글' : '답글을 단 글'));
    const p = el('p'); linkify(p, context.text); box.append(p); article.append(box);
  }
  if (tweet.text) { const p = el('p', 'tw-text'); linkify(p, tweet.text); article.append(p); }
  const media = tweet.media.filter(item => item.url).slice(0, 4);
  if (media.length) {
    const box = el('div', `tw-media n${media.length}`);
    media.forEach((entry, index) => {
      const a = el('a'); a.href = tweet.x_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', `첨부 미디어 ${index + 1}, X에서 보기`);
      const img = el('img'); img.alt = entry.alt || ''; img.loading = 'lazy'; img.src = entry.url;
      img.addEventListener('error', () => { img.remove(); a.classList.add('broken'); }, { once: true });
      a.append(img);
      if (entry.type !== 'photo') a.append(el('span', 'play', entry.type === 'video' ? 'VIDEO' : 'GIF'));
      box.append(a);
    });
    article.append(box);
  }
  const chips = tweet.topics.filter(({ id }) => ctx.topicById.has(id)).slice(0, 3);
  const selected = tweet.topics.find(({ id }) => id === selectedTopic);
  if (selected && !chips.some(({ id }) => id === selectedTopic)) chips.push(selected);
  if (chips.length) {
    const row = el('div', 'tw-chips');
    chips.forEach(({ id, score }) => {
      const topic = ctx.topicById.get(id);
      const button = el('button', `chip${id === selectedTopic ? ' on' : ''}`); button.type = 'button';
      button.dataset.y = date.slice(0, 4); button.dataset.t = id;
      const swatch = el('i'); swatch.style.background = topic.color;
      button.append(swatch, topic.label, el('b', null, score.toFixed(2).replace(/^0/, '')));
      row.append(button);
    });
    article.append(row);
  }
  if (why) article.append(el('div', 'tw-why', why));
  return item;
}

export function tweetList(container, tweets, ctx, { why = new Map(), selectedTopic, group = null } = {}) {
  const fragment = document.createDocumentFragment();
  let previous = null;
  for (const tweet of tweets) {
    const key = group === 'year' ? tweet.date_kst.slice(0, 4) : group === 'month' ? tweet.date_kst.slice(5, 7) : null;
    if (key && key !== previous) {
      const separator = el('li', 'sep');
      const count = tweets.filter(item => (group === 'year' ? item.date_kst.slice(0, 4) : item.date_kst.slice(5, 7)) === key).length;
      separator.append(el('b', null, group === 'month' ? `${key}월` : key), el('span', null, `${count}개`));
      fragment.append(separator); previous = key;
    }
    fragment.append(tweetCard(tweet, ctx, { why: why.get(tweet.id), selectedTopic }));
  }
  container.replaceChildren(fragment);
}
