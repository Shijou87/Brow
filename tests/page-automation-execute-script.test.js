const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  tabsClick,
  tabsFillForm,
  tabsKey,
  tabsType,
  waitForTabSettled,
} = require('../.tmp-page-automation-injection-test/sidepanel/tab-tools/page-automation.js');
const injectedRuntimeBundleSource = fs.readFileSync(
  path.join(__dirname, '..', '.tmp-page-automation-injection-test', 'page-automation-runtime.js'),
  'utf8',
);

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.isContentEditable = false;
    this.innerText = '';
    this.textContent = '';
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.isConnected = true;
    this.dispatchedEvents = [];
    this._rect = {
      left: 100,
      top: 100,
      right: 300,
      bottom: 140,
      width: 200,
      height: 40,
    };
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(' ');
      },
      remove: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.delete(name);
        this.className = [...current].join(' ');
      },
      toggle: (name, force) => {
        const hasName = this.className.split(/\s+/).includes(name);
        const shouldAdd = force === undefined ? !hasName : Boolean(force);
        if (shouldAdd) this.classList.add(name);
        else this.classList.remove(name);
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  getBoundingClientRect() {
    return this._rect;
  }

  getClientRects() {
    return [this._rect];
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  contains(node) {
    return node === this;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView() {}

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector) {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.classList?.contains(className)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event);
    return true;
  }
}

class FakeInputElement extends FakeElement {
  constructor(ownerDocument) {
    super('input', ownerDocument);
    this.type = 'text';
    this.value = '';
    this.disabled = false;
    this.readOnly = false;
    this.form = null;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.defaultView = null;
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    this._queryResults = [];
  }

  querySelectorAll() {
    return this._queryResults;
  }

  querySelector() {
    return this._queryResults[0] ?? null;
  }

  elementFromPoint() {
    return this.activeElement ?? this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    const searchRoots = [this.body, this.documentElement];
    for (const root of searchRoots) {
      if (root.id === id) return root;
      const matches = root.querySelectorAll('.__unused__');
      void matches;
      const stack = [...root.children];
      while (stack.length > 0) {
        const node = stack.shift();
        if (node.id === id) return node;
        stack.push(...node.children);
      }
    }
    return null;
  }

  addEventListener() {}

  removeEventListener() {}
}

function createInjectedRuntimeContext() {
  const document = new FakeDocument();
  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    screenX: 0,
    screenY: 0,
    screenLeft: 0,
    screenTop: 0,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        cursor: 'text',
      };
    },
    setTimeout(callback) {
      callback();
      return 0;
    },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      callback(0);
      return 0;
    },
  };
  document.defaultView = window;

  const activeInput = new FakeInputElement(document);
  activeInput.value = 'existing';
  document.activeElement = activeInput;
  document._queryResults = [activeInput];

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  class FakeTextAreaElement extends FakeElement {
    constructor(ownerDocument) {
      super('textarea', ownerDocument);
      this.value = '';
      this.disabled = false;
      this.readOnly = false;
      this.form = null;
    }
  }

  class FakeButtonElement extends FakeElement {
    constructor(ownerDocument) {
      super('button', ownerDocument);
      this.type = 'button';
      this.disabled = false;
    }
  }

  class FakeAnchorElement extends FakeElement {
    constructor(ownerDocument) {
      super('a', ownerDocument);
      this.href = '';
    }
  }

  class FakeSelectElement extends FakeElement {
    constructor(ownerDocument) {
      super('select', ownerDocument);
      this.options = [];
      this.selectedOptions = [];
      this.disabled = false;
      this.form = null;
    }
  }

  window.HTMLInputElement = FakeInputElement;
  window.HTMLTextAreaElement = FakeTextAreaElement;
  window.HTMLButtonElement = FakeButtonElement;
  window.HTMLAnchorElement = FakeAnchorElement;
  window.HTMLSelectElement = FakeSelectElement;

  const context = {
    console,
    document,
    window,
    performance: { now: () => 0 },
    Event: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    DragEvent: FakeEvent,
    DataTransfer: class {},
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLButtonElement: FakeButtonElement,
    HTMLAnchorElement: FakeAnchorElement,
    HTMLSelectElement: FakeSelectElement,
    Element: FakeElement,
    Node: class {},
    chrome: {
      runtime: {
        getURL(path) {
          return path;
        },
      },
    },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  };
  context.globalThis = context;
  context.self = context;
  window.window = window;
  return context;
}

function createFillFormRuntimeContext() {
  const context = createInjectedRuntimeContext();
  const { document, window } = context;

  const username = new FakeInputElement(document);
  username.id = 'user-name';
  username.setAttribute('placeholder', 'Username');
  username._rect = {
    left: 120,
    top: 120,
    right: 320,
    bottom: 160,
    width: 200,
    height: 40,
  };

  const password = new FakeInputElement(document);
  password.id = 'password';
  password.type = 'password';
  password.setAttribute('placeholder', 'Password');
  password._rect = {
    left: 120,
    top: 180,
    right: 320,
    bottom: 220,
    width: 200,
    height: 40,
  };

  document.body.appendChild(username);
  document.body.appendChild(password);
  document.activeElement = username;
  window.__browBrowserSnapshotState__ = {
    currentSnapshotId: 's1',
    snapshotOrder: ['s1'],
    snapshots: {
      s1: {
        nodesByRef: {
          e11: username,
          e13: password,
        },
      },
    },
  };

  return {
    context,
    username,
    password,
  };
}

function createTextareaRuntimeContext() {
  const context = createInjectedRuntimeContext();
  const { document, window } = context;

  const textarea = new window.HTMLTextAreaElement(document);
  textarea.id = 'notes';
  textarea.setAttribute('placeholder', 'Notes');
  textarea._rect = {
    left: 120,
    top: 120,
    right: 420,
    bottom: 260,
    width: 300,
    height: 140,
  };

  document.body.appendChild(textarea);
  document.activeElement = textarea;
  document._queryResults = [textarea];
  window.__browBrowserSnapshotState__ = {
    currentSnapshotId: 's2',
    snapshotOrder: ['s2'],
    snapshots: {
      s2: {
        nodesByRef: {
          e21: textarea,
        },
      },
    },
  };

  return {
    context,
    textarea,
  };
}

test('serialized injected key handler stays self-contained when re-evaluated in page context', async () => {
  let lastContext;

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1 };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1 }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          lastContext = createInjectedRuntimeContext();
          vm.runInNewContext(injectedRuntimeBundleSource, lastContext);
          return [{ result: undefined }];
        }

        const injected = vm.runInNewContext(`(${func.toString()})`, lastContext);
        const result = await injected(...args);
        return [{ result }];
      },
    },
  };

  const result = await tabsKey(1, { text: 'abc' });

  assert.equal(result.ok, true);
  assert.equal(lastContext.document.activeElement.value, 'existingabc');
});

test('serialized injected key handler animates appended text in an active textarea', async () => {
  let runtime;

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1 };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1 }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          runtime = createTextareaRuntimeContext();
          runtime.textarea.value = 'hello';
          vm.runInNewContext(injectedRuntimeBundleSource, runtime.context);
          return [{ result: undefined }];
        }

        const injected = vm.runInNewContext(`(${func.toString()})`, runtime.context);
        const result = await injected(...args);
        return [{ result }];
      },
    },
  };

  const result = await tabsKey(1, { text: ' world' });

  assert.equal(result.ok, true);
  assert.equal(runtime.textarea.value, 'hello world');
  assert.equal(
    runtime.textarea.dispatchedEvents.filter((event) => event.type === 'input').length,
    ' world'.length,
  );
  assert.equal(
    runtime.textarea.dispatchedEvents.filter((event) => event.type === 'change').length,
    1,
  );
});

test('serialized injected fillForm handler fills ref-backed text fields in page context', async () => {
  let runtime;

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1 };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1 }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          runtime = createFillFormRuntimeContext();
          vm.runInNewContext(injectedRuntimeBundleSource, runtime.context);
          return [{ result: undefined }];
        }

        const injected = vm.runInNewContext(`(${func.toString()})`, runtime.context);
        const result = await injected(...args);
        return [{ result }];
      },
    },
  };

  const result = await tabsFillForm(1, [
    { selector: 'brow-ref://s1/e11', value: 'standard_user' },
    { selector: 'brow-ref://s1/e13', value: 'secret_sauce' },
  ], false);

  assert.equal(result.ok, true);
  assert.equal(runtime.username.value, 'standard_user');
  assert.equal(runtime.password.value, 'secret_sauce');
  assert.equal(
    runtime.username.dispatchedEvents.filter((event) => event.type === 'input').length,
    'standard_user'.length,
  );
  assert.equal(
    runtime.password.dispatchedEvents.filter((event) => event.type === 'input').length,
    'secret_sauce'.length,
  );
  assert.equal(
    runtime.username.dispatchedEvents.filter((event) => event.type === 'change').length,
    1,
  );
  assert.equal(
    runtime.password.dispatchedEvents.filter((event) => event.type === 'change').length,
    1,
  );
});

test('serialized injected type handler animates text input through per-character input events', async () => {
  let runtime;

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1 };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1 }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          runtime = createFillFormRuntimeContext();
          vm.runInNewContext(injectedRuntimeBundleSource, runtime.context);
          return [{ result: undefined }];
        }

        const injected = vm.runInNewContext(`(${func.toString()})`, runtime.context);
        const result = await injected(...args);
        return [{ result }];
      },
    },
  };

  const result = await tabsType(1, 'brow-ref://s1/e11', 'fast');

  assert.equal(result.ok, true);
  assert.equal(runtime.username.value, 'fast');
  assert.equal(
    runtime.username.dispatchedEvents.filter((event) => event.type === 'input').length,
    'fast'.length,
  );
  assert.equal(
    runtime.username.dispatchedEvents.filter((event) => event.type === 'change').length,
    1,
  );
});

test('serialized injected type handler animates textarea text through per-character input events', async () => {
  let runtime;

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1 };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1 }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, func, args }) {
        if (files) {
          runtime = createTextareaRuntimeContext();
          vm.runInNewContext(injectedRuntimeBundleSource, runtime.context);
          return [{ result: undefined }];
        }

        const injected = vm.runInNewContext(`(${func.toString()})`, runtime.context);
        const result = await injected(...args);
        return [{ result }];
      },
    },
  };

  const result = await tabsType(1, 'brow-ref://s2/e21', 'fast note');

  assert.equal(result.ok, true);
  assert.equal(runtime.textarea.value, 'fast note');
  assert.equal(
    runtime.textarea.dispatchedEvents.filter((event) => event.type === 'input').length,
    'fast note'.length,
  );
  assert.equal(
    runtime.textarea.dispatchedEvents.filter((event) => event.type === 'change').length,
    1,
  );
});

test('tabsClick does not wait forever when page click execution stays blocked', async () => {
  const blocked = createDeferred();

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1, status: 'complete' };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1, status: 'complete' }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files, args }) {
        if (files) return [{ result: undefined }];
        if (args?.[0]?.kind === 'click') {
          return blocked.promise;
        }
        return [{
          result: {
            ok: true,
            readyState: 'complete',
            quietMs: 180,
            durationMs: 0,
          },
        }];
      },
    },
  };

  try {
    const outcome = await Promise.race([
      tabsClick(1, '#tbodyid a').then((result) => ({ kind: 'result', result })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 1800)),
    ]);

    assert.notEqual(outcome.kind, 'timeout');
    assert.equal(outcome.result.ok, false);
    assert.match(outcome.result.error ?? '', /timed out|dialog|blocked/i);
  } finally {
    blocked.resolve([{ result: { ok: true } }]);
  }
});

test('waitForTabSettled returns a timeout error when the settling probe stays blocked', async () => {
  const blocked = createDeferred();

  global.chrome = {
    tabs: {
      async get() {
        return { id: 1, active: true, windowId: 1, status: 'complete' };
      },
      async update(tabId, options) {
        return { id: tabId, active: options?.active ?? true, windowId: 1 };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1, status: 'complete' }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ files }) {
        if (files) return [{ result: undefined }];
        return blocked.promise;
      },
    },
  };

  try {
    const outcome = await Promise.race([
      waitForTabSettled(1, 200).then((result) => ({ kind: 'result', result })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 1200)),
    ]);

    assert.notEqual(outcome.kind, 'timeout');
    assert.equal(outcome.result.ok, false);
    assert.match(outcome.result.error ?? '', /timed out|dialog|blocked/i);
  } finally {
    blocked.resolve([{ result: { ok: true, readyState: 'complete', quietMs: 0, durationMs: 0 } }]);
  }
});
