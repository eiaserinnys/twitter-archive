export const X_POSTS_PER_REQUEST = 100;
const X_POST_PRICE_USD = 0.005;
const X_USER_PRICE_USD = 0.01;

export function estimateXLookupCostUsd(posts: number, users: number): number {
  return posts * X_POST_PRICE_USD + users * X_USER_PRICE_USD;
}
