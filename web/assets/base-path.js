export const basePath = document.querySelector('meta[name="base-path"]')?.content || '';
export const withBase = path => `${basePath}${path}`;
