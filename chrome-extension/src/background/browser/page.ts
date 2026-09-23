import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
} from './dom/service';
import { DOMElementNode, type DOMState } from './dom/views';
import { getAxTreeElements, mainRealm } from './dom/axtree';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState, URLNotAllowedError } from './views';
import { createLogger } from '@src/background/log';
import { ClickableElementProcessor } from './dom/clickable/service';
import { classifyFingerprint, isUrlAllowed } from './util';

const logger = createLogger('Page');

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _recentDialogs: string[] = [];
  private _fingerprints: string[] = [];
  private _acceptNextDialog = false;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _validWebPage = false;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
    // chrome://newtab/, chrome://newtab/extensions, https://chromewebstore.google.com/ are not valid web pages, can't be attached
    const lowerCaseUrl = url.trim().toLowerCase();
    this._validWebPage =
      (tabId &&
        lowerCaseUrl &&
        lowerCaseUrl.startsWith('http') &&
        !lowerCaseUrl.startsWith('https://chromewebstore.google.com')) ||
      false;
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  // drain dialog messages auto-handled since the last call (shown to the agent)
  takeRecentDialogs(): string[] {
    const drained = this._recentDialogs;
    this._recentDialogs = [];
    return drained;
  }

  // arm/disarm accepting the next confirm/prompt/beforeunload (click force:true)
  setDialogAccept(on: boolean): void {
    this._acceptNextDialog = on;
  }

  async attachPuppeteer(): Promise<boolean> {
    if (!this._validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    logger.info('attaching puppeteer', this._tabId);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(this._tabId),
      defaultViewport: null,
      protocol: 'cdp' as ProtocolType,
    });
    this._browser = browser;

    const [page] = await browser.pages();
    this._puppeteerPage = page;

    // JS dialogs freeze the page's JS thread until handled, so every later agent
    // action silently no-ops. alert offers no real choice — close it. confirm/
    // prompt/beforeunload default to the SAFE side (cancel) instead of auto-
    // approving a possibly irreversible step; the agent may retry with
    // force:true (setDialogAccept) after reading the buffered dialog text.
    page.on('dialog', dialog => {
      let accept = true;
      if (dialog.type() !== 'alert') {
        accept = this._acceptNextDialog;
        this._acceptNextDialog = false;
      }
      const entry = `${dialog.type()} (${accept ? 'accepted' : 'auto-cancelled'}): ${dialog.message()}`;
      this._recentDialogs.push(entry);
      if (this._recentDialogs.length > 5) {
        this._recentDialogs.shift();
      }
      logger.info('auto-handling dialog', entry);
      (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });

    // Add anti-detection scripts
    await this._addAntiDetectionScripts();
    await this._addTransientNoticeRecorder();

    return true;
  }

  /**
   * Record notices that appear and vanish before the agent looks again.
   *
   * Validation feedback is very often a toast that removes itself after a few
   * seconds. A model step takes far longer than that, so by the time the next
   * DOM snapshot is taken the message is gone and the agent has no idea why the
   * page refused to advance. A MutationObserver keeps the text in a small
   * buffer that survives the node.
   */
  private async _addTransientNoticeRecorder(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    await this._puppeteerPage.evaluateOnNewDocument(`
      (() => {
        const BUFFER = '__koniTransientNotices';
        if (window[BUFFER]) return;
        window[BUFFER] = [];

        const NOTICE_HINT = /(toast|snackbar|notification|message|alert|error|warning|validation|flash)/i;
        const looksLikeNotice = el => {
          if (!(el instanceof HTMLElement)) return false;
          const role = el.getAttribute('role') || '';
          if (role === 'alert' || role === 'status') return true;
          if (el.getAttribute('aria-live')) return true;
          return NOTICE_HINT.test(el.className || '') || NOTICE_HINT.test(el.id || '');
        };

        const record = el => {
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) return;
          const entry = { text: text.slice(0, 300), at: Date.now() };
          const last = window[BUFFER][window[BUFFER].length - 1];
          if (last && last.text === entry.text && entry.at - last.at < 1000) return;
          window[BUFFER].push(entry);
          if (window[BUFFER].length > 10) window[BUFFER].shift();
        };

        const observer = new MutationObserver(records => {
          for (const r of records) {
            r.addedNodes.forEach(n => {
              if (looksLikeNotice(n)) record(n);
              else if (n instanceof HTMLElement) {
                n.querySelectorAll && n.querySelectorAll('[role=alert],[role=status],[aria-live]')
                  .forEach(child => record(child));
              }
            });
          }
        });

        const start = () => observer.observe(document.body, { childList: true, subtree: true });
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
      })();
    `);
  }

  /**
   * Drain the notices recorded since the last call, newest last.
   */
  async takeTransientNotices(): Promise<string[]> {
    if (!this._puppeteerPage) {
      return [];
    }
    try {
      return await this._puppeteerPage.evaluate(() => {
        const buf = (window as unknown as Record<string, { text: string }[]>).__koniTransientNotices;
        if (!buf || !buf.length) return [];
        const out = buf.map(e => e.text);
        buf.length = 0;
        return out;
      });
    } catch {
      return [];
    }
  }

  /**
   * A cheap "did anything actually happen" signature: the address, how many
   * nodes exist, and what every form control currently holds. Clicking a native
   * select, or a button whose handler bailed out, leaves this identical.
   */
  async pageFingerprint(): Promise<string> {
    if (!this._puppeteerPage) {
      return '';
    }
    try {
      return await this._puppeteerPage.evaluate(() => {
        const controls = Array.from(document.querySelectorAll('input,select,textarea'))
          .map(el => {
            const c = el as HTMLInputElement;
            return c.type === 'checkbox' || c.type === 'radio' ? String(c.checked) : c.value || '';
          })
          .join('');
        return `${location.href}|${document.querySelectorAll('*').length}|${controls}`;
      });
    } catch {
      return '';
    }
  }

  /**
   * File a fingerprint and say what it means for the action that produced it.
   *
   * A click that leaves the page untouched is one failure mode; a click that
   * toggles something back to a state the page was already in is another, and
   * the second is invisible to a plain before/after comparison because the page
   * genuinely changed each time. Both end the same way — the agent repeats
   * itself until the step budget runs out.
   */
  noteFingerprint(fp: string): { unchanged: boolean; revisited: boolean } {
    return classifyFingerprint(this._fingerprints, fp);
  }

  resetFingerprints(): void {
    this._fingerprints = [];
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId);
    }
  }

  async removeHighlight(): Promise<void> {
    // Not gated on displayHighlights: switching the toggle off mid-run must still clear the
    // marks an earlier step drew.
    if (this._validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this.url(),
      showHighlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  /** Accessibility-tree observation; falls back to the DOM walk if CDP refuses. */
  async getAxTreeElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage || !this._puppeteerPage) {
      return null;
    }
    try {
      return await getAxTreeElements(this._puppeteerPage, showHighlightElements, this._config.viewportExpansion);
    } catch (error) {
      logger.warning('axtree observation failed, falling back to DOM walk:', error);
      return this.getClickableElements(showHighlightElements, focusElement);
    }
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this._validWebPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    const scrollInfo = await scrollableElement.evaluate(el => {
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    });

    return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
  }

  /**
   * Find the nearest scrollable ancestor of the given element
   * @param element The element to start searching from
   * @returns The nearest scrollable ancestor or null if none found
   */
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }

    // Check if the current element is scrollable
    const isScrollable = await element.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const canScrollVertically =
        style.overflowY === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'auto';

      return hasVerticalScrollbar && canScrollVertically;
    });

    if (isScrollable) {
      return element;
    }

    // Check parent elements
    let currentElement: ElementHandle<Element> | null = element;

    try {
      while (currentElement) {
        // Get the parent element (as an ElementHandle) of the current element
        const parentHandle = (await currentElement.evaluateHandle(
          (el: Element) => el.parentElement,
        )) as ElementHandle<Element> | null;

        const parentElement = parentHandle ? await parentHandle.asElement() : null;

        if (!parentElement) {
          // Reached the root without finding a scrollable ancestor
          currentElement = null;
          break;
        }

        const parentIsScrollable = await parentElement.evaluate((el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
          const canScrollVertically =
            ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

          return hasVerticalScrollbar && canScrollVertically;
        });

        if (parentIsScrollable) {
          // Found a scrollable ancestor – return it (the caller should dispose when finished)
          return parentElement;
        }

        // Move up the DOM tree – dispose the previous element handle before continuing
        if (currentElement !== element) {
          try {
            await currentElement.dispose();
          } catch (disposeErr) {
            logger.debug('Failed to dispose element handle:', disposeErr);
          }
        }

        currentElement = parentElement;
      }
    } catch (error) {
      // Error accessing parent, break out of loop
      logger.error('Error finding scrollable parent:', error);
    }

    // If no scrollable ancestor found, return the document body or documentElement
    try {
      const bodyElement = await this._puppeteerPage.$('body');
      if (bodyElement) {
        const bodyIsScrollable = await bodyElement.evaluate(el => {
          if (!(el instanceof HTMLElement)) return false;
          return el.scrollHeight > el.clientHeight;
        });
        if (bodyIsScrollable) {
          return bodyElement;
        }
      }

      // Last resort: return document element for page-level scrolling
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // Draw the numbered marks only when the user asked to see them. With the toggle off
      // nothing is painted onto the page, so there is no flash to clean up; the model still
      // gets the numbered axtree text and (if vision) the plain screenshot.
      const displayHighlights = this._config.displayHighlights;
      logger.info('observation mode', this._config.observationMode);
      const content =
        this._config.observationMode === 'axtree'
          ? await this.getAxTreeElements(displayHighlights, focusElement)
          : await this.getClickableElements(displayHighlights, focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        // Return last known good state if available
        return this._state;
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed
      const screenshot = useVision ? await this.takeScreenshot() : null;
      const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo();

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title()) || '';
      this._state.screenshot = screenshot;
      this._state.scrollY = scrollY;
      this._state.visualViewportHeight = visualViewportHeight;
      this._state.scrollHeight = scrollHeight;
      return this._state;
    } catch (error) {
      logger.error('Failed to update state:', error);
      // Return last known good state if available
      return this._state;
    }
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Leave the disable-animations style in place. Removing it re-enabled every element's
      // animation at once, which restarted entrance animations (a modal replayed its
      // slide-up on every step and looked like the page was reloading). The override is
      // injected once (guarded by its id) and stays for the run; it only affects rendering.
      // ponytail: persists until the page reloads; fine for an automated run.

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
      logger.info('navigateTo complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Navigation failed:', error);
      throw error;
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Page refresh failed:', error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate back:', error);
      throw error;
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate forward:', error);
      throw error;
    }
  }

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      const root = await this._wheelTargetScrollRoot();
      if (root) {
        await root.evaluate((el, yPercent) => {
          const scrollTop = (el.scrollHeight - el.clientHeight) * (yPercent / 100);
          el.scrollTo({ top: scrollTop, left: el.scrollLeft, behavior: 'smooth' });
        }, yPercent);
        return;
      }
      await this._puppeteerPage.evaluate(yPercent => {
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        window.scrollTo({
          top: scrollTop,
          left: window.scrollX,
          behavior: 'smooth',
        });
      }, yPercent);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate((el, yPercent) => {
        const scrollHeight = el.scrollHeight;
        const viewportHeight = el.clientHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        el.scrollTo({
          top: scrollTop,
          left: el.scrollLeft,
          behavior: 'smooth',
        });
      }, yPercent);
    }
  }

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(y => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, y);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }
      await scrollableElement.evaluate(el => {
        el.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      });
    }
  }

  /**
   * The container a mouse wheel at the viewport centre would scroll, or null
   * for the document itself. Document-level scroll actions use this so they
   * keep working inside modals/drawers with their own scroll container —
   * window.scrollTo only moves the page behind the overlay.
   */
  private async _wheelTargetScrollRoot(): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }
    const handle = await this._puppeteerPage.evaluateHandle(() => {
      let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      while (el && el !== document.body && el !== document.documentElement) {
        if (el instanceof HTMLElement) {
          const st = window.getComputedStyle(el);
          const scrollable =
            el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(`${st.overflowY} ${st.overflow}`);
          if (scrollable) {
            return el;
          }
        }
        el = el.parentElement;
      }
      return null;
    });
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return null;
    }
    return el as ElementHandle;
  }

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      const root = await this._wheelTargetScrollRoot();
      if (root) {
        await root.evaluate(el => el.scrollBy(0, -el.clientHeight));
        return;
      }
      // Scroll the whole page up by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, -(window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      const root = await this._wheelTargetScrollRoot();
      if (root) {
        await root.evaluate(el => el.scrollBy(0, el.clientHeight));
        return;
      }
      // Scroll the whole page down by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, (window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    // Models write "CTRL+A" / "Cmd+A" / "Opt" as often as the canonical names;
    // normalize the aliases before the lookup so a shortcut never dies on
    // 'Unknown key: "CTRL"' (seen 4x in one expense run while it tried to
    // select-all a field that appended text).
    const KEY_ALIASES: Record<string, string> = {
      ctrl: 'control',
      cmd: 'meta',
      command: 'meta',
      win: 'meta',
      opt: 'alt',
      option: 'alt',
      esc: 'escape',
      return: 'enter',
      del: 'delete',
    };
    const rawKey = key.trim().toLowerCase();
    const lowerKey = KEY_ALIASES[rawKey] ?? rawKey;
    const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

    if (isMac) {
      if (lowerKey === 'control' || lowerKey === 'ctrl') {
        return 'Meta' as KeyInput; // Use Command key on Mac
      }
      if (lowerKey === 'command' || lowerKey === 'cmd') {
        return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
      }
      if (lowerKey === 'option' || lowerKey === 'opt') {
        return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
      }
    }

    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Convert text to lowercase for consistent searching
      const lowerCaseText = text.toLowerCase();

      // Try different locator strategies to find all elements containing the text
      const selectors = [
        // Using text selector (equivalent to get_by_text) - for exact text match
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
      ];

      for (const selector of selectors) {
        try {
          // Use $$ to get all matching elements
          const elements = await this._puppeteerPage.$$(selector);

          if (elements.length > 0) {
            // Find visible elements and select the nth occurrence
            const visibleElements = [];

            for (const element of elements) {
              const isVisible = await element.evaluate(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              });

              if (isVisible) {
                visibleElements.push(element);
              }
            }

            // Check if we have enough visible elements for the requested nth occurrence
            if (visibleElements.length >= nth) {
              const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
              await this._scrollIntoViewIfNeeded(targetElement);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

              // Dispose of all element handles to prevent memory leaks
              for (const element of elements) {
                await element.dispose();
              }

              return true;
            }
          }

          // Dispose of all element handles to prevent memory leaks
          for (const element of elements) {
            await element.dispose();
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Native <select>: its options. Anything else: the option list an
      // accessibility tree would expose — a datalist on an <input>, the
      // listbox named by aria-controls/aria-owns, or role=option descendants
      // of the widget / its combobox container. (Custom dropdowns used to fail
      // flat with 'not a select element'.)
      const options = await elementHandle.evaluate(el => {
        if (el instanceof HTMLSelectElement) {
          return Array.from(el.options).map(option => ({
            index: option.index,
            text: option.text, // Not trimming to maintain exact match for selection
            value: option.value,
          }));
        }
        const scopes: Element[] = [];
        const list = (el as HTMLInputElement).list;
        if (list) scopes.push(list);
        for (const id of `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(
          /\s+/,
        )) {
          const target = id && document.getElementById(id);
          if (target) scopes.push(target);
        }
        scopes.push(el);
        const box = el.closest('[role="combobox"], [role="listbox"]');
        if (box?.parentElement) scopes.push(box.parentElement);
        const seen = new Set<Element>();
        const out: { index: number; text: string; value: string }[] = [];
        for (const scope of scopes) {
          for (const opt of Array.from(scope.querySelectorAll('option, [role="option"]'))) {
            if (seen.has(opt)) continue;
            seen.add(opt);
            const text = (opt.textContent ?? '').trim() || (opt as HTMLOptionElement).value || '';
            if (text) out.push({ index: out.length, text, value: (opt as HTMLOptionElement).value ?? text });
          }
        }
        if (out.length === 0) {
          throw new Error(
            'Element is not a native <select> and exposes no option list; click it to open its menu, then click the wanted option on the page',
          );
        }
        return out;
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(index: number, text: string): Promise<string> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            // Custom widget: same option discovery as getDropdownOptions, then
            // either commit the datalist value or click the matching option.
            const el = select as Element;
            const scopes: Element[] = [];
            const list = (el as HTMLInputElement).list;
            if (list) scopes.push(list);
            for (const id of `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(
              /\s+/,
            )) {
              const target = id && document.getElementById(id);
              if (target) scopes.push(target);
            }
            scopes.push(el);
            const box = el.closest('[role="combobox"], [role="listbox"]');
            if (box?.parentElement) scopes.push(box.parentElement);
            const candidates: Element[] = [];
            for (const scope of scopes) {
              for (const opt of Array.from(scope.querySelectorAll('option, [role="option"]'))) {
                if (!candidates.includes(opt)) candidates.push(opt);
              }
            }
            const label = (opt: Element): string =>
              (opt.textContent ?? '').trim() || (opt as HTMLOptionElement).value || '';
            // A model that reads "HKD" off a document will say "HKD", not
            // "HKD - Hong Kong Dollar". Exact label first, then the option's
            // value, then a code-prefix — the same latitude the scorer allows.
            const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
            const wanted = norm(optionText);
            const prefixes = (a: string, b: string) =>
              b !== '' && a.startsWith(b) && a.length > b.length && !/[a-z0-9]/.test(a[b.length]);
            const match =
              candidates.find(opt => norm(label(opt)) === wanted) ??
              candidates.find(opt => norm((opt as HTMLOptionElement).value ?? '') === wanted) ??
              candidates.find(opt => prefixes(norm(label(opt)), wanted));
            if (!match) {
              return {
                found: false,
                message: `Option "${optionText}" not found in element with index ${elementIndex}. Available options: "${candidates.map(label).join('", "')}"`,
              };
            }
            if (match instanceof HTMLOptionElement && list && 'value' in el) {
              (el as HTMLInputElement).value = match.value || match.text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              (match as HTMLElement).click();
            }
            return { found: true, message: `Selected option "${optionText}" on a non-native dropdown` };
          }

          const options = Array.from(select.options);
          const norm2 = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
          const wanted2 = norm2(optionText);
          const prefixes2 = (a: string, b: string) =>
            b !== '' && a.startsWith(b) && a.length > b.length && !/[a-z0-9]/.test(a[b.length]);
          const option =
            options.find(opt => norm2(opt.text) === wanted2) ??
            options.find(opt => norm2(opt.value) === wanted2) ??
            options.find(opt => prefixes2(norm2(opt.text), wanted2));

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      // throw new Error('Puppeteer page is not connected');
      logger.warning('Puppeteer is not connected');
      return null;
    }
    // axtree observation: the node is addressed by its backend id — adopt it
    // directly instead of rebuilding a css/xpath (which would not match the
    // synthetic role/name path such nodes carry).
    if (element.backendNodeId != null) {
      try {
        const handle = await mainRealm(this._puppeteerPage).adoptBackendNode(element.backendNodeId);
        const elementHandle = handle.asElement() as ElementHandle | null;
        if (elementHandle) {
          if (!(await elementHandle.isHidden())) {
            await this._scrollIntoViewIfNeeded(elementHandle);
          }
          return elementHandle;
        }
        await handle.dispose().catch(() => {});
      } catch (error) {
        logger.warning('backend node no longer resolvable (page changed?):', element.backendNodeId, error);
      }
      return null;
    }

    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        // throw new Error(`Could not find iframe with selector: ${cssSelector}`);
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        // throw new Error(`Could not access frame content for selector: ${cssSelector}`);
        logger.warning(`Could not access frame content for selector: ${cssSelector}`);
        return null;
      }
      currentFrame = frame;
      logger.info('currentFrame changed', currentFrame);
    }

    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);

    try {
      // Try CSS selector first
      let elementHandle: ElementHandle | null = await currentFrame.$(cssSelector);

      // If CSS selector failed, try XPath
      if (!elementHandle) {
        const xpath = element.xpath;
        if (xpath) {
          try {
            logger.info('Trying XPath selector:', xpath);
            const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
            const xpathSelector = `::-p-xpath(${fullXpath})`;
            elementHandle = await currentFrame.$(xpathSelector);
          } catch (xpathError) {
            logger.error('Failed to locate element using XPath:', xpathError);
          }
        }
      }

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle);
        }
        return elementHandle;
      }

      logger.info('elementHandle not located');
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  async inputTextElementNode(useVision: boolean, elementNode: DOMElementNode, text: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before typing
      // if (elementNode.highlightIndex != null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }

      // Get element properties to determine input method
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const isContentEditable = await element.evaluate(el => {
        if (el instanceof HTMLElement) {
          return el.isContentEditable;
        }
        return false;
      });
      const isReadOnly = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.readOnly;
        }
        return false;
      });
      const isDisabled = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.disabled;
        }
        return false;
      });

      // keyboard typing is silently ignored by segmented/native-widget inputs
      // (e.g. <input type="date"> expects locale-segment keys, not "2026-01-14")
      // — those need the direct value-set path below
      const inputType = tagName === 'input' ? await element.evaluate(el => (el as HTMLInputElement).type || '') : '';
      const needsValueSet = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(inputType);

      // Choose appropriate input method based on element properties
      // A textarea belongs on the typing path, not the direct-set one. Assigning
      // .value on a React-controlled field leaves React's own value tracker
      // untouched, so the synthetic input event is swallowed and the next
      // render restores the empty state — the field reads back blank however
      // many times the agent retypes it, which is exactly what every CRM
      // description did.
      if (
        (isContentEditable || tagName === 'input' || tagName === 'textarea') &&
        !isReadOnly &&
        !isDisabled &&
        !needsValueSet
      ) {
        // Clear content and set value directly
        await element.evaluate(el => {
          if (el instanceof HTMLElement) {
            el.textContent = '';
          }
          if ('value' in el) {
            (el as HTMLInputElement).value = '';
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Type the text with a small delay between keypresses
        await element.type(text, { delay: 50 });
      } else {
        // Use direct value setting for other types of elements
        await element.evaluate((el, value) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            // Through the prototype setter, so a framework that shadows .value
            // on the instance still registers the change.
            const proto =
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc?.set) {
              desc.set.call(el, value);
            } else {
              el.value = value;
            }
          } else if (el instanceof HTMLElement && el.isContentEditable) {
            el.textContent = value;
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);
      }

      // Read back what the field holds. Some widgets ignore the programmatic
      // clear and APPEND the typed text to the old value ("5076.505076.50" in
      // an expense run); that is the one failure we can recognise without
      // guessing — the field now holds the text plus more. Retry once with a
      // real select-all + delete, then fall back to a direct value set.
      // Anything else (masks that re-format "1196" to "1,196.00", pickers) is
      // left alone: a mismatch there is the widget's formatting, not a defect.
      if (tagName === 'input' || tagName === 'textarea') {
        const readBack = (): Promise<string> => element.evaluate(el => String((el as HTMLInputElement).value ?? ''));
        const appended = (held: string): boolean => held !== text && held.length > text.length && held.includes(text);
        // A field that reads back empty after a non-empty write is the other
        // recognisable failure: the write was reverted rather than reformatted.
        // Checking only for appended text let this one through silently.
        //
        // Not for the segmented widgets, though. A date input holds '' whenever
        // the string does not parse, which is its normal state here and not a
        // failure — retyping into one opens its picker, the page re-renders and
        // every cached element index behind it goes stale ("Element with index
        // 38 does not exist"). Those types took the direct-set path precisely
        // because typing does not work on them.
        const reverted = (held: string): boolean => !needsValueSet && text.length > 0 && held.length === 0;
        const failed = (held: string): boolean => appended(held) || reverted(held);
        let held = await readBack();
        if (failed(held)) {
          logger.warning(
            `input_text: field ${reverted(held) ? 'reverted to empty' : `appended (${JSON.stringify(held.slice(0, 60))})`}; retrying with select-all`,
          );
          await element.focus();
          const mod = this._convertKey('control'); // Meta on macOS
          await this._puppeteerPage.keyboard.down(mod);
          await this._puppeteerPage.keyboard.press('KeyA');
          await this._puppeteerPage.keyboard.up(mod);
          await this._puppeteerPage.keyboard.press('Backspace');
          await element.type(text, { delay: 50 });
          held = await readBack();
          if (failed(held)) {
            // ponytail: direct set as the last resort; a widget that also
            // rewrites on 'change' would need its own handler — none seen yet.
            await element.evaluate((el, value) => {
              const proto =
                el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc?.set) {
                desc.set.call(el, value);
              } else {
                (el as HTMLInputElement).value = value;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, text);
          }
        }
      }

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();
    let lastRect = await element.boundingBox();

    while (Date.now() - startTime < timeout) {
      // Wait a short time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get current position and size
      const currentRect = await element.boundingBox();

      // If element is no longer in DOM or not visible
      if (!currentRect) {
        break;
      }

      // Compare with previous position/size
      if (
        lastRect &&
        Math.abs(lastRect.x - currentRect.x) < 2 &&
        Math.abs(lastRect.y - currentRect.y) < 2 &&
        Math.abs(lastRect.width - currentRect.width) < 2 &&
        Math.abs(lastRect.height - currentRect.height) < 2
      ) {
        // Position is stable - wait a bit more to be sure and then return
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }

      // Update last position
      lastRect = currentRect;
    }

    // If we got here, either the element stabilized or we timed out
    logger.debug('Element stability check completed (timeout or stable)');
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const isVisible = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();

        // Check if element has size
        if (rect.width === 0 || rect.height === 0) return false;

        // Check if element is hidden
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return false;
        }

        return true;
      });

      if (isVisible) break;

      // Check timeout - log warning and return instead of throwing
      if (Date.now() - startTime > timeout) {
        logger.warning('Timed out while trying to scroll element into view, continuing anyway');
        break;
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);

      try {
        // First attempt: Use Puppeteer's click method with timeout
        await Promise.race([
          element.click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
        ]);
        await this._checkAndHandleNavigation();
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        // Second attempt: Use evaluate to perform a direct click
        logger.info('Failed to click element, trying again', error);
        try {
          await element.evaluate(el => (el as HTMLElement).click());
        } catch (secondError) {
          // if URLNotAllowedError, throw it
          if (secondError instanceof URLNotAllowedError) {
            throw secondError;
          }
          throw new Error(
            `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    // If there is no cached state, return an empty map
    if (this._cachedState === null) {
      return new Map();
    }
    // Otherwise return the cached state's selector map
    return this._cachedState.selectorMap;
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      console.warn('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkAndHandleNavigation(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Navigate to home page or about:blank
      const safeUrl = this._config.homePageUrl || 'about:blank';
      logger.info(`Redirecting to safe URL: ${safeUrl}`);

      try {
        await this._puppeteerPage.goto(safeUrl);
      } catch (error) {
        logger.error(`Failed to redirect to safe URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new URLNotAllowedError(errorMessage);
    }
  }
}
