/** Bounded presentation only: all members remain selectable across pages. */
export const FAMILY_PAGE_SIZE = 100;
export const FAMILY_GRAPH_EXPANSION_LIMIT = 200;
export function familyPage<T>(members: readonly T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(members.length / FAMILY_PAGE_SIZE));
  const page = Number.isFinite(requestedPage) ? Math.max(0, Math.min(pages - 1, Math.floor(requestedPage))) : 0;
  return { page, pages, total: members.length, items: members.slice(page * FAMILY_PAGE_SIZE, (page + 1) * FAMILY_PAGE_SIZE) };
}
