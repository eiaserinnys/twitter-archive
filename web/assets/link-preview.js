import { get } from './api.js';

const cache = new Map();
const queue = [];
let active = 0;
let observer;
const pending = new WeakMap();

function drain() {
  while (active < 4 && queue.length) {
    const { tweet, url, resolve } = queue.shift();
    active++;
    get('/api/link-preview', { tweet, url })
      .catch(() => null)
      .then(resolve)
      .finally(() => { active--; drain(); });
  }
}

function preview(tweet, url) {
  const key = JSON.stringify([tweet, url]);
  if (!cache.has(key)) {
    cache.set(key, new Promise(resolve => queue.push({ tweet, url, resolve })));
    drain();
  }
  return cache.get(key);
}

export function attachLinkPreview(item, article, tweet, url, el) {
  const anchor = document.createComment('link preview');
  article.append(anchor);
  pending.set(item, async () => {
    const data = await preview(tweet, url);
    if (data?.status !== 'ok' || !(data.title || data.image)) return;
    const card = el('a', 'tw-link');
    card.href = url; card.target = '_blank'; card.rel = 'noopener noreferrer';
    if (data.image) {
      const img = el('img'); img.src = data.image; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), { once: true });
      card.append(img);
    }
    const body = el('div', 'tw-link-body');
    body.append(el('span', 'label', data.site_name || new URL(url).hostname));
    if (data.title) body.append(el('strong', 'tw-link-title', data.title));
    if (data.description) body.append(el('p', 'tw-link-description', data.description));
    card.append(body);
    anchor.replaceWith(card);
  });
  observer ||= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const load = pending.get(entry.target);
      pending.delete(entry.target);
      load();
    }
  }, { rootMargin: '200px' });
  observer.observe(item);
}
