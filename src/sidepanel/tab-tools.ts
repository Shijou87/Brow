export {
  tabsActivate,
  tabsCreate,
  tabsGetActive,
  tabsGetContent,
  tabsList,
  tabsUpdateUrl,
  type TabInfo,
} from './tab-tools/tabs';

export {
  tabsHighlight,
  tabsHover,
  tabsClick,
  tabsFillForm,
  tabsListInteractiveElements,
  tabsType,
  type FormFillField,
  type FormFillFieldResult,
  type FormFillMode,
  type InteractiveElementInfo,
} from './tab-tools/page-automation';

export {
  tabCaptureScreenshot,
  vlmQuery,
  type VLMConfig,
} from './tab-tools/screenshot-vlm';

export { httpFetch } from './tab-tools/http-fetch';

export {
  bookmarksGetAll,
  bookmarksSearch,
  historySearch,
  type BookmarkInfo,
  type HistoryItem,
} from './tab-tools/browser-data';

export {
  webmcpDiscover,
  webmcpInvoke,
} from './tab-tools/webmcp';
