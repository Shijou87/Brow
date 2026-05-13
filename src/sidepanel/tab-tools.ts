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
  browserClick,
  browserDownloadWait,
  browserDrag,
  browserFillForm,
  browserFormSnapshot,
  browserHandleDialog,
  browserHover,
  browserKey,
  browserResolveRef,
  browserScroll,
  browserSnapshot,
  browserType,
  browserUploadFile,
  browserWaitFor,
  tabsDrag,
  tabsListInteractiveElements,
  tabsHandleDialog,
  tabsKey,
  tabsScroll,
  tabsType,
  tabsUploadFile,
  waitForTabSettled,
  type BrowserActionOptions,
  type BrowserActionResult,
  type BrowserClickPoint,
  type BrowserDragOptions,
  type BrowserFormFillField,
  type BrowserRefResolution,
  type FormFillField,
  type FormFillFieldResult,
  type FormFillMode,
  type InteractiveElementInfo,
} from './tab-tools/page-automation';

export {
  cropImageDataUrlToViewportRect,
  tabCaptureScreenshot,
  tabCaptureScreenshotRegion,
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
