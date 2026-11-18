/**
 * One switch for upstream's promotions that do not apply here: the desktop and
 * mobile apps (not shipped), the app download page, and demo videos that play
 * upstream's own recordings. Off. The code stays so upstream merges stay clean;
 * __tests__/strip-guard.test.ts fails if a promo is rendered while this is off.
 */
export const SHOW_UPSTREAM_PROMOS = false;
