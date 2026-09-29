let visitorPreview = sessionStorage.getItem('visitor-preview') === '1';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || payload?.error || `HTTP ${status}`);
    this.status = status;
    this.code = payload?.error;
  }
}

export function isPreview() { return visitorPreview; }
export function setPreview(on) {
  visitorPreview = on;
  sessionStorage.setItem('visitor-preview', on ? '1' : '0');
}

async function request(method, path, { params = {}, body, read = method === 'GET' } = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  if (read && visitorPreview) url.searchParams.set('as', 'visitor');
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const get = (path, params) => request('GET', path, { params });
export const write = (method, path, body) => request(method, path, { body });
export const search = body => request('POST', '/api/search', { body, read: true });
