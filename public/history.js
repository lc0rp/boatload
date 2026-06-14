export const HISTORY_PAGE_SIZE = 10;

export function mergedHistoryItems(card) {
  const events = (card.events || []).map((event) => ({
    at: event.created_at,
    speaker: event.actor,
    text: event.summary
  }));
  const comments = (card.comments || []).map((comment) => ({
    at: comment.created_at,
    speaker: comment.author,
    text: comment.body
  }));
  return [...events, ...comments].sort((a, b) => new Date(a.at) - new Date(b.at));
}

export function historyPageCount(totalItems, pageSize = HISTORY_PAGE_SIZE) {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function clampHistoryPage(page, totalItems, pageSize = HISTORY_PAGE_SIZE) {
  const count = historyPageCount(totalItems, pageSize);
  const parsed = Number.parseInt(page ?? count, 10);
  return Math.min(count, Math.max(1, Number.isNaN(parsed) ? count : parsed));
}

export function latestHistoryPage(totalItems, pageSize = HISTORY_PAGE_SIZE) {
  return historyPageCount(totalItems, pageSize);
}

export function historyPageItems(items, page, pageSize = HISTORY_PAGE_SIZE) {
  const safePage = clampHistoryPage(page, items.length, pageSize);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
