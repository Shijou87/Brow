export interface BookmarkInfo {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  dateAdded?: number;
  children?: BookmarkInfo[];
}

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]): BookmarkInfo[] {
  const result: BookmarkInfo[] = [];
  for (const node of nodes) {
    result.push({
      id: node.id,
      title: node.title,
      url: node.url,
      parentId: node.parentId,
      dateAdded: node.dateAdded,
    });
    if (node.children) {
      result.push(...flattenBookmarks(node.children));
    }
  }
  return result;
}

export async function bookmarksGetAll(): Promise<BookmarkInfo[]> {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarks(tree);
}

export async function bookmarksSearch(query: string): Promise<BookmarkInfo[]> {
  const results = await chrome.bookmarks.search(query);
  return results.map((bookmark) => ({
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    parentId: bookmark.parentId,
    dateAdded: bookmark.dateAdded,
  }));
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime?: number;
  visitCount?: number;
}

export async function historySearch(
  query: string,
  maxResults = 50,
  startTime?: number,
): Promise<HistoryItem[]> {
  const results = await chrome.history.search({
    text: query,
    maxResults,
    startTime: startTime ?? 0,
  });
  return results.map((item) => ({
    id: item.id ?? '',
    url: item.url ?? '',
    title: item.title ?? '',
    lastVisitTime: item.lastVisitTime,
    visitCount: item.visitCount,
  }));
}

