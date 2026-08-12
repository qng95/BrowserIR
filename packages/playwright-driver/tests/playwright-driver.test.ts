import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { BrowserIRRuntime, type ResolvedAction } from '@browserir/core';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  STANDARD_ELEMENT_POLICY,
  createPlaywrightBrowserDriver,
} from '../src/index.js';

let server: Server;
let origin: string;
let alternateOriginRequests = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.headers.host?.startsWith('localhost:')) {
      alternateOriginRequests += 1;
    }

    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Next</title><h1>Next screen</h1><p>Navigation worked.</p>');
      return;
    }

    if (request.url === '/redirect-external') {
      const host = request.headers.host ?? '';
      const alternateHost = host.startsWith('127.0.0.1:')
        ? host.replace('127.0.0.1:', 'localhost:')
        : host.replace('localhost:', '127.0.0.1:');
      response.writeHead(302, { location: `http://${alternateHost}/next` });
      response.end();
      return;
    }

    if (request.url === '/external-popup-source') {
      const host = request.headers.host ?? '';
      const alternateHost = host.startsWith('127.0.0.1:')
        ? host.replace('127.0.0.1:', 'localhost:')
        : host.replace('localhost:', '127.0.0.1:');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <title>External popup source</title>
        <button type="button" id="open-external">Open external details</button>
        <script>
          document.querySelector('#open-external').addEventListener('click', () => {
            window.open('http://${alternateHost}/next', '_blank');
          });
        </script>`);
      return;
    }

    if (request.url === '/semantic-context') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Semantic context</title></head>
          <body>
            <nav aria-label="Primary navigation">
              <a href="/customers/new" aria-description="Navigation action">New customer</a>
            </nav>
            <main aria-label="Customer workspace">
              <h1>Customers</h1>
              <a href="/customers/new" aria-description="Workspace action">New customer</a>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/title-stability') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Original document title</title></head>
          <body>
            <main>
              <button id="change-title" type="button">Change document title</button>
            </main>
            <script>
              document.querySelector('#change-title').addEventListener('click', () => {
                document.title = 'Changed document title';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/same-url-frames') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Same URL frame identities</title>
            <style>iframe { display: block; width: 500px; height: 160px; }</style>
          </head>
          <body>
            <iframe title="Purchasing workspace" src="/shared-frame"></iframe>
            <iframe title="Service workspace" src="/shared-frame"></iframe>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/shared-frame') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Shared frame</title></head>
          <body>
            <main aria-label="Invoice workspace">
              <button type="button">Submit invoice</button>
            </main>
            <script>
              document.querySelector('button').addEventListener('click', event => {
                const context = window.frameElement?.getAttribute('title') ?? 'Unknown workspace';
                event.currentTarget.textContent = context + ' submitted';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/many-controls') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Many controls</title></head>
          <body>
            <main aria-label="Large action workspace">
              ${Array.from(
                { length: 200 },
                (_, index) => `<button type="button">Action ${index + 1}</button>`,
              ).join('')}
              <output id="result">Idle</output>
            </main>
            <script>
              document.querySelectorAll('button').forEach((button) => {
                button.addEventListener('click', () => {
                  document.querySelector('#result').textContent = button.textContent + ' ran';
                });
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/standard-scan-cap') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Standard scan cap</title>
        ${'<div></div>'.repeat(STANDARD_ELEMENT_POLICY.maxScannedElements)}
        <button type="button">Control beyond bounded scan</button>`);
      return;
    }

    if (request.url === '/custom-interaction-cap') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Custom interaction cap</title></head>
          <body>
            <main aria-label="Custom action workspace">
              ${Array.from(
                { length: 202 },
                (_, index) => `<div class="custom-action">Custom action ${index + 1}</div>`,
              ).join('')}
            </main>
            <script>
              document.querySelectorAll('.custom-action').forEach((element) => {
                element.addEventListener('click', () => {});
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/custom-interaction-scan-cap') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Custom interaction scan cap</title></head>
          <body>
            <script>
              const fragment = document.createDocumentFragment();
              for (let index = 0; index < 25010; index += 1) {
                const decoy = document.createElement('span');
                decoy.hidden = true;
                fragment.append(decoy);
              }
              document.body.append(fragment);
              const action = document.createElement('div');
              action.textContent = 'Action beyond scan boundary';
              action.addEventListener('click', () => {});
              document.body.append(action);
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/semantic-analysis-cap') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Semantic analysis cap</title></head>
          <body>
            <main aria-label="Large form">
              ${Array.from(
                { length: 501 },
                (_, index) => `<input aria-label="Field ${index + 1}">`,
              ).join('')}
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/sensitive-custom-fields') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Sensitive custom fields</title>
            <style>[role="textbox"] { display: block; min-height: 20px; }</style>
          </head>
          <body>
            <main aria-label="Credential form">
              <input aria-label="One-time code" autocomplete="one-time-code" value="739201">
              <div role="textbox" contenteditable="true" aria-label="API key">sk-live-content-secret</div>
              <div role="textbox" aria-label="Password" aria-valuetext="custom-password-secret"></div>
              <input aria-label="Customer reference" value="CUST-42">
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url?.startsWith('/url-secrets?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>URL redaction</title><p>Safe page</p>');
      return;
    }

    if (request.url === '/oversized-capture') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Oversized capture</title></head>
          <body>
            <button style="display:block;width:4000px;height:3000px">Oversized target</button>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/skewed-controls') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Skewed controls</title></head>
          <body>
            <main aria-label="Skewed workspace">
              <button type="button" data-observe-delay="120">First action</button>
              <button type="button" data-observe-delay="60">Second action</button>
              <button type="button">Third action</button>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/observation-failure') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Observation failure</title></head>
          <body>
            <main aria-label="Failure workspace">
              <button type="button">Healthy action</button>
              <button type="button" data-observe-failure="true">Broken action</button>
              <button type="button">Another healthy action</button>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/custom-clickables') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Custom clickables</title>
            <style>
              .custom-row { padding: 8px; }
              .pointer-row { cursor: pointer; }
              #standard-shell { cursor: pointer; padding: 8px; }
            </style>
          </head>
          <body>
            <main aria-label="Dealership selector">
              <div id="dealership-list">
                <div id="react-dealership" class="custom-row" data-record-id="dealer:test-creation">
                  <span>Test Creation</span>
                </div>
                <div id="native-dealership" class="custom-row">Native Dealer</div>
                <div id="pointer-dealership" class="custom-row pointer-row">Pointer Dealer</div>
                <div id="ordinary-information">Ordinary information</div>
                <div id="standard-shell"><button type="button">Standard action</button></div>
                <div id="react-card" class="custom-row" aria-label="Dealer Prime record">
                  <span>Dealer Prime</span>
                  <button type="button">Card menu</button>
                </div>
              </div>
              <div id="cursor-only-information" style="cursor: pointer">Cursor-only information</div>
              <output id="result">No dealership selected</output>
            </main>
            <script>
              const result = document.querySelector('#result');
              const list = document.querySelector('#dealership-list');
              const reactRow = document.querySelector('#react-dealership');
              reactRow['__reactProps$browserirFixture'] = { onClick() {} };
              document.querySelector('#react-card')['__reactProps$browserirFixture'] = {
                onClick() {}
              };
              document.querySelector('#ordinary-information')['__reactProps$browserirFixture'] = {
                children: 'Ordinary information'
              };

              list.addEventListener('click', event => {
                const row = event.target.closest(
                  '#react-dealership,#pointer-dealership,#react-card'
                );
                if (row) {
                  result.textContent = row.textContent.trim() + ' selected';
                  if (row.id === 'react-dealership') {
                    const replacement = row.cloneNode(true);
                    replacement['__reactProps$browserirFixture'] = { onClick() {} };
                    row.replaceWith(replacement);
                  }
                }
              });
              document.querySelector('#native-dealership').addEventListener('click', event => {
                result.textContent = event.currentTarget.textContent.trim() + ' selected';
              });
              document.querySelector('button').addEventListener('click', event => {
                result.textContent = event.currentTarget.textContent.trim() + ' selected';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/listener-safety') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Listener safety</title></head>
          <body>
            <button id="protected-action" type="button">Protected action</button>
            <output id="result">Starting</output>
            <script>
              const action = document.querySelector('#protected-action');
              const result = document.querySelector('#result');
              Object.preventExtensions(action);
              try {
                action.addEventListener('click', () => {
                  result.textContent = 'Protected action ran';
                });
                result.textContent = 'Listener registered';
              } catch (error) {
                result.textContent = 'Listener registration failed';
              }
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/forged-targets') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Forged targets</title></head>
          <body>
            <button id="first-action" type="button">First protected action</button>
            <button id="second-action" type="button">Second protected action</button>
            <output id="result">No action ran</output>
            <script>
              const first = document.querySelector('#first-action');
              const second = document.querySelector('#second-action');
              const result = document.querySelector('#result');
              const forgedKey = Symbol.for('@browserir/playwright/opaque-target');
              Object.defineProperty(first, forgedKey, { value: 'target_1' });
              Object.defineProperty(second, forgedKey, { value: 'target_1' });
              first.addEventListener('click', () => {
                result.textContent = 'First protected action ran';
              });
              second.addEventListener('click', () => {
                result.textContent = 'Second protected action ran';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/custom-click-race') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Custom click race</title></head>
          <body>
            <div id="race-list">
              <div id="race-a">Race action A</div>
              <div id="race-b">Race action B</div>
            </div>
            <script>
              const list = document.querySelector('#race-list');
              const raceA = document.querySelector('#race-a');
              const raceB = document.querySelector('#race-b');
              raceA['__reactProps$browserirRace'] = { onClick() {} };
              raceB['__reactProps$browserirRace'] = { onClick() {} };
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/clickable-scope') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Clickable scope</title></head>
          <body>
            <main id="clickable-main" aria-label="Clickable workspace">
              <button type="button">Workspace action</button>
            </main>
            <script>
              document.querySelector('#clickable-main')['__reactProps$scopeFixture'] = {
                onClick() {}
              };
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/hostile-framework-getters') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Hostile framework getters</title></head>
          <body>
            <div id="safe-action">Safe custom action</div>
            <div id="react-getter">React getter text</div>
            <div id="onclick-getter">Onclick getter text</div>
            <script>
              document.querySelector('#safe-action')['__reactProps$safeFixture'] = {
                onClick() {}
              };
              Object.defineProperty(
                document.querySelector('#react-getter'),
                '__reactProps$hostileFixture',
                {
                  get() {
                    throw new Error('framework getter must not run');
                  }
                }
              );
              Object.defineProperty(document.querySelector('#onclick-getter'), 'onclick', {
                get() {
                  throw new Error('onclick getter must not run');
                }
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/standard-control-race') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Standard control race</title></head>
          <body>
            <div id="standard-race-list">
              <button type="button" data-browserir-standard-race>Standard race A</button>
              <button type="button" data-browserir-standard-race>Standard race B</button>
            </div>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/observation-race-source') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Observation race source</title></head>
          <body><button type="button">Old document action</button></body>
        </html>`);
      return;
    }

    if (request.url === '/observation-race-destination') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head><title>Observation race destination</title></head>
          <body>
            <button id="destination-action" type="button">Destination action</button>
            <output id="result">Destination idle</output>
            <script>
              document.querySelector('#destination-action').addEventListener('click', () => {
                document.querySelector('#result').textContent = 'Destination action ran';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/composite-phone-field') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Composite phone field</title>
            <style>
              .phone-widget {
                display: flex;
                gap: 4px;
                width: 240px;
              }
              #country-search { width: 64px; }
              #phone-input { flex: 1; }
            </style>
          </head>
          <body>
            <main>
              <form>
                <label id="phone-label">
                  <span>Phone Number *</span>
                  <span class="phone-widget">
                    <input id="country-search" type="text" aria-haspopup="listbox">
                    <span role="listbox" style="display:none">
                      <span role="option">Afghanistan (+93)</span>
                      <span role="option">Albania (+355)</span>
                    </span>
                    <input id="phone-input" type="tel" required>
                  </span>
                </label>
                <button type="submit">Create Customer</button>
              </form>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === '/occluded-controls') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Occluded controls</title>
            <style>
              #selector {
                position: relative;
                width: 280px;
                height: 90px;
              }
              #hidden-search,
              #hidden-row,
              #selector-cover {
                position: absolute;
                left: 0;
                width: 260px;
                box-sizing: border-box;
              }
              #hidden-search { top: 0; height: 34px; }
              #hidden-row { top: 42px; height: 34px; }
              #selector-cover {
                top: 0;
                height: 76px;
                z-index: 2;
              }
            </style>
          </head>
          <body>
            <div id="selector">
              <input id="hidden-search" aria-label="Hidden dealership search">
              <div id="hidden-row">Hidden dealership row</div>
              <button id="selector-cover" type="button">Open dealership selector</button>
            </div>
            <output id="result">No dealership selected</output>
            <script>
              const cover = document.querySelector('#selector-cover');
              const row = document.querySelector('#hidden-row');
              const result = document.querySelector('#result');
              cover.addEventListener('click', () => cover.remove());
              row.addEventListener('click', () => {
                result.textContent = 'Hidden dealership selected';
              });
            </script>
          </body>
        </html>`);
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>Driver test</title></head>
        <body>
          <main>
            <h1>Customer editor</h1>
            <p>Update the customer and save the record.</p>
            <label for="customer-name">Customer name</label>
            <input id="customer-name" value="Before">

            <label for="status">Status</label>
            <select id="status">
              <option value="lead">Lead</option>
              <option value="active">Active</option>
            </select>

            <label><input id="priority" type="checkbox"> Priority customer</label>
            <button id="save" type="button">Save customer</button>
            <button id="help" type="button">Help</button>
            <button id="popup" type="button">Open details tab</button>
            <a href="/next">Open next screen</a>
            <output id="result">Not saved</output>
            <div id="tooltip" hidden>Helpful details</div>
          </main>
          <script>
            document.querySelector('#save').addEventListener('click', () => {
              document.querySelector('#result').textContent =
                document.querySelector('#customer-name').value + ' saved';
            });
            document.querySelector('#save').addEventListener('contextmenu', event => {
              event.preventDefault();
              document.querySelector('#result').textContent = 'Context menu opened';
            });
            document.querySelector('#customer-name').addEventListener('keydown', event => {
              if (event.key === 'Enter') document.querySelector('#result').textContent = 'Enter pressed';
            });
            document.querySelector('#help').addEventListener('mouseenter', () => {
              document.querySelector('#tooltip').hidden = false;
            });
            document.querySelector('#popup').addEventListener('click', () => {
              window.open('/next', '_blank');
            });
          </script>
        </body>
      </html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

function action(value: unknown): ResolvedAction {
  return value as ResolvedAction;
}

async function instrumentElementHandleObservation() {
  type HandleObject = object;
  type Evaluate = (
    this: HandleObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<unknown>;
  type Dispose = (this: HandleObject) => Promise<void>;
  type HandlePrototype = {
    evaluate: Evaluate;
    dispose: Dispose;
  };

  const probeBrowser = await chromium.launch({ headless: true });
  const probePage = await probeBrowser.newPage();
  await probePage.setContent('<button type="button">Probe</button>');
  const probeHandle = await probePage.locator('button').elementHandle();
  if (!probeHandle) throw new Error('missing probe element handle');

  const prototype = Object.getPrototypeOf(probeHandle) as HandlePrototype;
  const originalEvaluate = prototype.evaluate;
  const originalDispose = prototype.dispose;
  const allocatedTargetHandles = new Set<HandleObject>();
  const disposedHandles = new Set<HandleObject>();

  prototype.evaluate = async function (
    this: HandleObject,
    pageFunction: unknown,
    argument?: unknown,
  ): Promise<unknown> {
    const source =
      typeof pageFunction === 'function'
        ? Function.prototype.toString.call(pageFunction)
        : String(pageFunction);
    const isFactRead =
      source.includes('function readElementFacts') ||
      (source.includes('semanticOwner') && source.includes('capabilities'));

    if (isFactRead) {
      const metadata = (await Reflect.apply(originalEvaluate, this, [
        (element: HTMLElement) => ({
          delay: Number(element.dataset['observeDelay'] ?? 0),
          failure: element.dataset['observeFailure'] === 'true',
        }),
        undefined,
      ])) as { delay: number; failure: boolean };
      if (metadata.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, metadata.delay));
      }
      if (metadata.failure) throw new Error('injected observation failure');
    }

    const result = await Reflect.apply(originalEvaluate, this, [pageFunction, argument]);
    if (
      source.includes('input.registry.get(element)') &&
      source.includes('input.nextId')
    ) {
      allocatedTargetHandles.add(this);
    }
    return result;
  };
  prototype.dispose = async function (this: HandleObject): Promise<void> {
    disposedHandles.add(this);
    await Reflect.apply(originalDispose, this, []);
  };

  return {
    allocatedTargetHandles,
    disposedHandles,
    async restore(): Promise<void> {
      prototype.evaluate = originalEvaluate;
      prototype.dispose = originalDispose;
      await probeBrowser.close();
    },
  };
}

async function instrumentLocatorSnapshotMutation() {
  type LocatorObject = object;
  type FrameObject = object;
  type Count = (this: LocatorObject) => Promise<number>;
  type ElementHandles = (this: LocatorObject) => Promise<object[]>;
  type EvaluateAll = (
    this: LocatorObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<unknown>;
  type LocatorPrototype = {
    count: Count;
    elementHandles: ElementHandles;
    evaluateAll: EvaluateAll;
  };
  type FrameEvaluateHandle = (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<object>;
  type FrameEvaluate = (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<unknown>;
  type FramePrototype = {
    evaluateHandle: FrameEvaluateHandle;
    evaluate: FrameEvaluate;
  };

  const probeBrowser = await chromium.launch({ headless: true });
  const probePage = await probeBrowser.newPage();
  await probePage.setContent('<button type="button">Probe</button>');
  const prototype = Object.getPrototypeOf(
    probePage.locator('button'),
  ) as LocatorPrototype;
  const originalCount = prototype.count;
  const originalElementHandles = prototype.elementHandles;
  const originalEvaluateAll = prototype.evaluateAll;
  const framePrototype = Object.getPrototypeOf(
    probePage.mainFrame(),
  ) as FramePrototype;
  const originalFrameEvaluateHandle = framePrototype.evaluateHandle;
  const originalFrameEvaluate = framePrototype.evaluate;
  let mutated = false;

  const mutateAfterSnapshot = async (locator: LocatorObject): Promise<void> => {
    if (mutated) return;
    const didMutate = (await Reflect.apply(originalEvaluateAll, locator, [
      (elements: Element[]) => {
        if (
          !elements.some((element) =>
            element.hasAttribute('data-browserir-standard-race'),
          )
        ) {
          return false;
        }
        const list = elements[0]?.ownerDocument.querySelector(
          '#standard-race-list',
        );
        if (list == null || list.querySelector('#standard-race-intruder')) {
          return false;
        }
        const intruder = elements[0]!.ownerDocument.createElement('button');
        intruder.id = 'standard-race-intruder';
        intruder.type = 'button';
        intruder.textContent = 'Injected standard control';
        list.prepend(intruder);
        return true;
      },
      undefined,
    ])) as boolean;
    if (didMutate) mutated = true;
  };

  prototype.count = async function (this: LocatorObject): Promise<number> {
    const result = await Reflect.apply(originalCount, this, []);
    await mutateAfterSnapshot(this);
    return result;
  };
  prototype.elementHandles = async function (
    this: LocatorObject,
  ): Promise<object[]> {
    const result = await Reflect.apply(originalElementHandles, this, []);
    await mutateAfterSnapshot(this);
    return result;
  };
  framePrototype.evaluateHandle = async function (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ): Promise<object> {
    const result = await Reflect.apply(originalFrameEvaluateHandle, this, [
      pageFunction,
      argument,
    ]);
    const options = argument as { selector?: unknown } | undefined;
    if (
      !mutated &&
      typeof options?.selector === 'string' &&
      options.selector.includes('button')
    ) {
      const didMutate = (await Reflect.apply(originalFrameEvaluate, this, [
        () => {
          const list = document.querySelector('#standard-race-list');
          if (list === null || list.querySelector('#standard-race-intruder')) {
            return false;
          }
          const intruder = document.createElement('button');
          intruder.id = 'standard-race-intruder';
          intruder.type = 'button';
          intruder.textContent = 'Injected standard control';
          list.prepend(intruder);
          return true;
        },
        undefined,
      ])) as boolean;
      if (didMutate) mutated = true;
    }
    return result;
  };

  return {
    async restore(): Promise<void> {
      prototype.count = originalCount;
      prototype.elementHandles = originalElementHandles;
      framePrototype.evaluateHandle = originalFrameEvaluateHandle;
      await probeBrowser.close();
    },
  };
}

async function instrumentCustomSnapshotMutation() {
  type FrameObject = object;
  type EvaluateHandle = (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<object>;
  type Evaluate = (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ) => Promise<unknown>;
  type FramePrototype = {
    evaluateHandle: EvaluateHandle;
    evaluate: Evaluate;
  };

  const probeBrowser = await chromium.launch({ headless: true });
  const probePage = await probeBrowser.newPage();
  const prototype = Object.getPrototypeOf(
    probePage.mainFrame(),
  ) as FramePrototype;
  const originalEvaluateHandle = prototype.evaluateHandle;
  const originalEvaluate = prototype.evaluate;
  let mutated = false;

  prototype.evaluateHandle = async function (
    this: FrameObject,
    pageFunction: unknown,
    argument?: unknown,
  ): Promise<object> {
    const result = await Reflect.apply(originalEvaluateHandle, this, [
      pageFunction,
      argument,
    ]);
    const options = argument as
      | { scanLimit?: unknown; retainLimit?: unknown }
      | undefined;
    if (
      !mutated &&
      typeof options?.scanLimit === 'number' &&
      typeof options.retainLimit === 'number'
    ) {
      mutated = true;
      await Reflect.apply(originalEvaluate, this, [
        () => {
          const list = document.querySelector('#race-list');
          if (list === null || list.querySelector('#race-intruder')) return;
          const intruder = document.createElement('div');
          intruder.id = 'race-intruder';
          intruder.textContent = 'Injected ordinary text';
          list.prepend(intruder);
        },
        undefined,
      ]);
    }
    return result;
  };

  return {
    async restore(): Promise<void> {
      prototype.evaluateHandle = originalEvaluateHandle;
      await probeBrowser.close();
    },
  };
}

async function instrumentTitleNavigation(destinationUrl: string) {
  type PageObject = object;
  type Title = (this: PageObject) => Promise<string>;
  type Goto = (
    this: PageObject,
    url: string,
    options?: { waitUntil?: 'domcontentloaded' },
  ) => Promise<unknown>;
  type PagePrototype = {
    title: Title;
    goto: Goto;
  };

  const probeBrowser = await chromium.launch({ headless: true });
  const probePage = await probeBrowser.newPage();
  const prototype = Object.getPrototypeOf(probePage) as PagePrototype;
  const originalTitle = prototype.title;
  const originalGoto = prototype.goto;
  let navigated = false;

  prototype.title = async function (this: PageObject): Promise<string> {
    const title = await Reflect.apply(originalTitle, this, []);
    if (!navigated && title === 'Observation race source') {
      navigated = true;
      await Reflect.apply(originalGoto, this, [
        destinationUrl,
        { waitUntil: 'domcontentloaded' },
      ]);
    }
    return title;
  };

  return {
    async restore(): Promise<void> {
      prototype.title = originalTitle;
      await probeBrowser.close();
    },
  };
}

describe('PlaywrightBrowserDriver', () => {
  it('enforces an optional context-level HTTP origin allowlist', async () => {
    const driver = createPlaywrightBrowserDriver({
      allowedOrigins: [origin],
      serviceWorkers: 'block',
    });
    const session = await driver.createSession();

    try {
      await expect(
        session.navigate({ pageId: session.initialPageId, url: `${origin}/next` }),
      ).resolves.toMatchObject({ title: 'Next' });
      const otherOrigin = origin.includes('127.0.0.1')
        ? origin.replace('127.0.0.1', 'localhost')
        : origin.replace('localhost', '127.0.0.1');
      await expect(
        session.navigate({ pageId: session.initialPageId, url: `${otherOrigin}/next` }),
      ).rejects.toThrow(/ERR_FAILED|blocked|aborted/i);
    } finally {
      await session.close();
    }
  });

  it('rejects malformed context-level allowed origins before launching Chromium', async () => {
    const driver = createPlaywrightBrowserDriver({ allowedOrigins: ['https://example.com/path'] });

    await expect(driver.createSession()).rejects.toThrow(/allowedOrigins.*origin/i);
  });

  it('applies the context-level origin policy to redirects, not only direct navigation', async () => {
    alternateOriginRequests = 0;
    const driver = createPlaywrightBrowserDriver({
      allowedOrigins: [origin],
      serviceWorkers: 'block',
    });
    const session = await driver.createSession();

    try {
      await expect(
        session.navigate({
          pageId: session.initialPageId,
          url: `${origin}/redirect-external`,
        }),
      ).rejects.toThrow(/ERR_FAILED|blocked|aborted/i);
      const page = (await session.pages()).find(
        (candidate) => candidate.pageId === session.initialPageId,
      );
      expect(page?.url).not.toContain('localhost');
      expect(alternateOriginRequests).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('applies the context-level origin policy to popup navigation dispatched by a click', async () => {
    alternateOriginRequests = 0;
    const driver = createPlaywrightBrowserDriver({
      allowedOrigins: [origin],
      serviceWorkers: 'block',
    });
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/external-popup-source`,
      });
      const target = observation.entities.find(
        (entity) => entity.name === 'Open external details',
      );
      if (target === undefined) throw new Error('missing external popup target');

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: target.target }),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(alternateOriginRequests).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('keeps a configured viewport profile fixed for the session and capture metadata', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 2,
    });

    try {
      const capture = await session.capture({
        pageId: session.initialPageId,
        kind: 'viewport',
      });

      expect(capture).toMatchObject({
        width: 1024,
        height: 768,
        deviceScaleFactor: 2,
      });
    } finally {
      await session.close();
    }
  });

  it('creates an isolated fixed-profile page and observes semantic controls without selectors', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const pages = await session.pages();
      expect(pages).toHaveLength(1);
      expect(pages[0]?.pageId).toBe(session.initialPageId);

      const observation = await session.navigate({ pageId: session.initialPageId, url: origin });
      expect(observation.entities.map((entity) => entity.name)).toEqual(
        expect.arrayContaining([
          'Customer name',
          'Status',
          'Priority customer',
          'Save customer',
          'Help',
          'Open details tab',
          'Open next screen',
        ]),
      );
      expect(observation.visibleText).toContain('Update the customer and save the record.');

      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain('#customer-name');
      expect(serialized).not.toContain('css=');
      expect(serialized).not.toContain('xpath=');
    } finally {
      await session.close();
    }
  });

  it('discovers evidence-backed custom click targets without promoting ordinary text or wrappers', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();

    try {
      const initial = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: created.revision,
        url: `${origin}/custom-clickables`,
        budget: { maxCharacters: 10_000 },
      });
      const entities = initial.view.structured.entities;
      const named = (name: string) => entities.filter((entity) => entity.name === name);

      expect.soft(named('Test Creation')).toHaveLength(1);
      expect.soft(named('Native Dealer')).toHaveLength(1);
      expect.soft(named('Pointer Dealer')).toHaveLength(1);
      expect.soft(named('Standard action')).toHaveLength(1);
      expect.soft(named('Dealer Prime record')).toHaveLength(1);
      expect.soft(named('Card menu')).toHaveLength(1);
      expect.soft(named('Ordinary information')).toHaveLength(0);
      expect.soft(named('Cursor-only information')).toHaveLength(0);
      expect.soft(
        entities.some((entity) => entity.name?.includes('Native Dealer Pointer Dealer')),
      ).toBe(false);

      const dealership = named('Test Creation')[0];
      if (!dealership) throw new Error('missing custom dealership target');
      const dealershipSnapshot = initial.snapshot.entities.find(
        (entity) => entity.name === 'Test Creation',
      );
      const nativeSnapshot = initial.snapshot.entities.find(
        (entity) => entity.name === 'Native Dealer',
      );
      const pointerSnapshot = initial.snapshot.entities.find(
        (entity) => entity.name === 'Pointer Dealer',
      );
      expect.soft(dealership.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'click',
            enabled: true,
            reason: 'react-click-handler',
            confidence: 0.98,
          }),
        ]),
      );
      expect.soft(dealership).toMatchObject({
        kind: 'control',
        name: 'Test Creation',
      });
      expect.soft(dealership.role).toBeUndefined();
      expect.soft(dealershipSnapshot?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sensor: 'playwright-dom-interaction',
            detail: 'react-click-handler',
            confidence: 0.98,
          }),
        ]),
      );
      expect.soft(nativeSnapshot?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sensor: 'playwright-dom-interaction',
            detail: 'dom-click-listener',
            confidence: 0.95,
          }),
        ]),
      );
      expect.soft(pointerSnapshot?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sensor: 'playwright-dom-interaction',
            detail: 'pointer-cue',
            confidence: 0.65,
          }),
        ]),
      );

      const stable = await runtime.observe({
        browserId: created.browserId,
        budget: { maxCharacters: 10_000 },
      });
      const stableDealership = stable.view.structured.entities.find(
        (entity) => entity.name === 'Test Creation',
      );
      if (!stableDealership) throw new Error('missing stable custom dealership target');
      expect.soft(stableDealership.ref.entityId).toBe(dealership.ref.entityId);

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: stable.view.revision,
        action: { kind: 'click', target: stableDealership.ref },
        budget: { maxCharacters: 10_000 },
      });

      expect(receipt.status).toBe('verified');
      expect(receipt.observation?.view.text).toContain('Test Creation selected');
      expect(
        receipt.observation?.view.structured.entities.find(
          (entity) => entity.name === 'Test Creation',
        )?.ref.entityId,
      ).toBe(dealership.ref.entityId);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('never prevents a site listener from registering when BrowserIR bookkeeping cannot annotate the element', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const initial = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/listener-safety`,
      });
      expect(initial.visibleText).toContain('Listener registered');

      const protectedAction = initial.entities.find(
        (entity) => entity.name === 'Protected action',
      );
      if (!protectedAction) throw new Error('missing protected action');
      const dispatched = await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: protectedAction.target }),
      });
      const after = await session.observe({ pageId: session.initialPageId });

      expect(dispatched).toEqual({ dispatched: true });
      expect(after.visibleText).toContain('Protected action ran');
    } finally {
      await session.close();
    }
  });

  it('keeps action targets private when a page forges BrowserIR symbol values', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const initial = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/forged-targets`,
      });
      const first = initial.entities.find(
        (entity) => entity.name === 'First protected action',
      );
      const second = initial.entities.find(
        (entity) => entity.name === 'Second protected action',
      );
      if (!first || !second) throw new Error('missing protected actions');

      expect(first.target.opaqueId).not.toBe(second.target.opaqueId);
      const dispatched = await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: second.target }),
      });
      const after = await session.observe({ pageId: session.initialPageId });

      expect(dispatched).toEqual({ dispatched: true });
      expect(after.visibleText).toContain('Second protected action ran');
      expect(after.visibleText).not.toContain('First protected action ran');
    } finally {
      await session.close();
    }
  });

  it('binds custom click evidence to the same DOM nodes even when discovery mutates the document', async () => {
    const instrumentation = await instrumentCustomSnapshotMutation();
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/custom-click-race`,
      });
      const interactionEntities = observation.entities.filter((entity) =>
        entity.evidence?.some(
          (evidence) => evidence.sensor === 'playwright-dom-interaction',
        ) ?? false,
      );
      const named = (name: string) =>
        interactionEntities.filter((entity) => entity.name === name);

      expect.soft(named('Race action A')).toHaveLength(1);
      expect.soft(named('Race action B')).toHaveLength(1);
      expect.soft(named('Injected ordinary text')).toHaveLength(0);
    } finally {
      await session.close();
      await instrumentation.restore();
    }
  });

  it('does not emit a clickable semantic scope twice under the same source identity', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/clickable-scope`,
      });
      const workspace = observation.entities.find(
        (entity) =>
          entity.kind === 'region' && entity.name === 'Clickable workspace',
      );
      if (!workspace) throw new Error('missing clickable workspace');
      const sameSource = observation.entities.filter(
        (entity) => entity.sourceId === workspace.sourceId,
      );
      const selfRelations = (observation.relations ?? []).filter(
        (relation) =>
          relation.fromSourceId === workspace.sourceId &&
          relation.toSourceId === workspace.sourceId,
      );

      expect(sameSource).toHaveLength(1);
      expect(selfRelations).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('inspects framework metadata without invoking page-defined getters', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/hostile-framework-getters`,
      });
      const interactionNames = observation.entities
        .filter(
          (entity) =>
            entity.evidence?.some(
              (evidence) => evidence.sensor === 'playwright-dom-interaction',
            ) ?? false,
        )
        .map((entity) => entity.name);

      expect(interactionNames).toContain('Safe custom action');
      expect(interactionNames).not.toContain('React getter text');
      expect(interactionNames).not.toContain('Onclick getter text');
    } finally {
      await session.close();
    }
  });

  it('binds standard controls to the locator snapshot when the DOM changes after enumeration', async () => {
    const instrumentation = await instrumentLocatorSnapshotMutation();
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/standard-control-race`,
      });
      const named = (name: string) =>
        observation.entities.filter((entity) => entity.name === name);

      expect.soft(named('Standard race A')).toHaveLength(1);
      expect.soft(named('Standard race B')).toHaveLength(1);
      expect.soft(named('Injected standard control')).toHaveLength(0);
    } finally {
      await session.close();
      await instrumentation.restore();
    }
  });

  it('retries an observation when the document navigates before targets are committed', async () => {
    const instrumentation = await instrumentTitleNavigation(
      `${origin}/observation-race-destination`,
    );
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/observation-race-source`,
      });
      const destination = observation.entities.find(
        (entity) => entity.name === 'Destination action',
      );

      expect(observation.url).toBe(`${origin}/observation-race-destination`);
      expect(observation.title).toBe('Observation race destination');
      expect(destination).toBeDefined();
      expect(
        observation.entities.some(
          (entity) => entity.name === 'Old document action',
        ),
      ).toBe(false);

      if (!destination) throw new Error('missing destination action');
      const dispatched = await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: destination.target }),
      });
      const after = await session.observe({ pageId: session.initialPageId });

      expect(dispatched).toEqual({ dispatched: true });
      expect(after.visibleText).toContain('Destination action ran');
    } finally {
      await session.close();
      await instrumentation.restore();
    }
  });

  it('represents composite phone fields and native validation without label pollution', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const initial = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/composite-phone-field`,
      });
      const countryCode = initial.entities.find(
        (entity) => entity.name === 'Phone Number * country code',
      );
      const phone = initial.entities.find(
        (entity) => entity.name === 'Phone Number *',
      );
      const submit = initial.entities.find(
        (entity) => entity.name === 'Create Customer',
      );

      expect.soft(countryCode).toBeDefined();
      expect.soft(phone).toBeDefined();
      expect.soft(
        initial.entities.some((entity) =>
          entity.name?.includes('Afghanistan (+93)'),
        ),
      ).toBe(false);
      expect.soft(countryCode?.identityKey).not.toBe(phone?.identityKey);
      expect.soft(countryCode?.target.opaqueId).not.toBe(
        phone?.target.opaqueId,
      );
      if (!submit) throw new Error('missing submit control');

      const dispatched = await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: submit.target }),
      });
      const rejected = await session.observe({
        pageId: session.initialPageId,
      });
      const invalidPhone = rejected.entities.find(
        (entity) => entity.name === 'Phone Number *',
      );

      expect(dispatched).toEqual({ dispatched: true });
      expect(invalidPhone?.state?.invalid).toBe(true);
      expect(invalidPhone?.state?.focused).toBe(true);
      expect(invalidPhone?.description).toMatch(
        /please fill (?:in|out) this field/i,
      );
    } finally {
      await session.close();
    }
  });

  it('excludes occluded controls until their covering selector is opened', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const closed = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/occluded-controls`,
      });
      const named = (observation: typeof closed, name: string) =>
        observation.entities.filter((entity) => entity.name === name);

      expect.soft(named(closed, 'Open dealership selector')).toHaveLength(1);
      expect.soft(named(closed, 'Hidden dealership search')).toHaveLength(0);
      expect.soft(named(closed, 'Hidden dealership row')).toHaveLength(0);
      expect.soft(closed.visibleText).not.toContain('Hidden dealership row');

      const open = named(closed, 'Open dealership selector')[0];
      if (!open) throw new Error('missing selector opener');
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: open.target }),
      });
      const expanded = await session.observe({ pageId: session.initialPageId });
      const row = named(expanded, 'Hidden dealership row')[0];

      expect.soft(named(expanded, 'Hidden dealership search')).toHaveLength(1);
      expect.soft(row).toBeDefined();
      expect.soft(expanded.visibleText).toContain('Hidden dealership row');
      if (!row) throw new Error('missing revealed dealership row');
      const dispatched = await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: row.target }),
      });
      const selected = await session.observe({ pageId: session.initialPageId });

      expect(dispatched).toEqual({ dispatched: true });
      expect(selected.visibleText).toContain('Hidden dealership selected');
    } finally {
      await session.close();
    }
  });

  it('distinguishes duplicate controls by semantic scope and emits source-addressed containment', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/semantic-context`,
      });
      const newCustomerLinks = observation.entities.filter(
        (entity) => entity.role === 'link' && entity.name === 'New customer',
      );
      const navigationLink = newCustomerLinks.find(
        (entity) => entity.description === 'Navigation action',
      );
      const workspaceLink = newCustomerLinks.find(
        (entity) => entity.description === 'Workspace action',
      );
      const navigationScope = observation.entities.find(
        (entity) => entity.role === 'navigation' && entity.name === 'Primary navigation',
      );
      const workspaceScope = observation.entities.find(
        (entity) => entity.role === 'main' && entity.name === 'Customer workspace',
      );
      const relations = (observation.relations ?? []) as unknown as Array<{
        fromSourceId: string;
        toSourceId: string;
        kind: string;
      }>;

      expect.soft(newCustomerLinks).toHaveLength(2);
      expect.soft(new Set(newCustomerLinks.map((entity) => entity.identityKey)).size).toBe(2);
      expect.soft(navigationScope).toBeDefined();
      expect.soft(workspaceScope).toBeDefined();
      expect.soft(relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromSourceId: navigationScope?.sourceId,
            toSourceId: navigationLink?.sourceId,
            kind: 'contains',
          }),
          expect.objectContaining({
            fromSourceId: workspaceScope?.sourceId,
            toSourceId: workspaceLink?.sourceId,
            kind: 'contains',
          }),
        ]),
      );

      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain('css=');
      expect(serialized).not.toContain('xpath=');
    } finally {
      await session.close();
    }
  });

  it('keeps unlabeled main and descendant identities stable when only document.title changes', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const before = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/title-stability`,
      });
      const mainBefore = before.entities.find((entity) => entity.role === 'main');
      const controlBefore = before.entities.find(
        (entity) => entity.name === 'Change document title',
      );
      if (!mainBefore || !controlBefore) throw new Error('missing title stability entities');

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: controlBefore.target }),
      });
      const after = await session.observe({ pageId: session.initialPageId });
      const mainAfter = after.entities.find((entity) => entity.role === 'main');
      const controlAfter = after.entities.find(
        (entity) => entity.name === 'Change document title',
      );

      expect(after.title).toBe('Changed document title');
      expect(mainAfter?.identityKey).toBe(mainBefore.identityKey);
      expect(controlAfter?.identityKey).toBe(controlBefore.identityKey);
    } finally {
      await session.close();
    }
  });

  it('namespaces identical controls in same-URL sibling frames while keeping each identity stable', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const first = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/same-url-frames`,
      });
      const second = await session.observe({ pageId: session.initialPageId });
      const submitButtons = (observation: typeof first) =>
        observation.entities
          .filter((entity) => entity.role === 'button' && entity.name === 'Submit invoice')
          .sort((left, right) => (left.geometry?.y ?? 0) - (right.geometry?.y ?? 0));
      const firstButtons = submitButtons(first);
      const secondButtons = submitButtons(second);

      expect.soft(firstButtons).toHaveLength(2);
      expect.soft(new Set(firstButtons.map((entity) => entity.identityKey)).size).toBe(2);
      expect(secondButtons.map((entity) => entity.identityKey)).toEqual(
        firstButtons.map((entity) => entity.identityKey),
      );
    } finally {
      await session.close();
    }
  });

  it('exposes same-URL sibling frame context in the model view and routes a canonical action to the intended frame', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();

    try {
      const first = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: `${origin}/same-url-frames`,
        budget: { maxCharacters: 5_000 },
      });
      const second = await runtime.observe({
        browserId: created.browserId,
        budget: { maxCharacters: 5_000 },
      });

      const contextNames = ['Purchasing workspace', 'Service workspace'];
      const contextDocuments = (result: typeof first) =>
        result.view.structured.entities.filter(
          (entity) => entity.kind === 'document' && contextNames.includes(entity.name ?? ''),
        );
      const buttonForContext = (result: typeof first, contextName: string) => {
        const entityById = new Map(
          result.view.structured.entities.map((entity) => [entity.ref.entityId, entity]),
        );
        const document = contextDocuments(result).find((entity) => entity.name === contextName);
        if (!document) throw new Error(`missing model-visible document for ${contextName}`);
        const scopeId = result.view.structured.relations.find(
          (relation) =>
            relation.kind === 'contains' &&
            relation.from.entityId === document.ref.entityId &&
            entityById.get(relation.to.entityId)?.kind === 'region',
        )?.to.entityId;
        const buttonId = result.view.structured.relations.find(
          (relation) =>
            relation.kind === 'contains' &&
            relation.from.entityId === scopeId &&
            entityById.get(relation.to.entityId)?.role === 'button',
        )?.to.entityId;
        const button = buttonId === undefined ? undefined : entityById.get(buttonId);
        if (!button) throw new Error(`missing contained button for ${contextName}`);
        return button;
      };

      expect.soft(contextDocuments(first).map((entity) => entity.name).sort()).toEqual(
        [...contextNames].sort(),
      );
      expect.soft(first.view.text).toContain('document role="document" name="Purchasing workspace"');
      expect.soft(first.view.text).toContain('document role="document" name="Service workspace"');
      expect.soft(second.view.revision).toBe(first.view.revision);
      expect.soft(second.delta).toMatchObject({
        pageChanged: false,
        added: [],
        removed: [],
        changed: [],
        addedRelations: [],
        removedRelations: [],
        invalidatedRefs: [],
      });
      expect.soft(
        contextDocuments(second).map((entity) => entity.ref.entityId).sort(),
      ).toEqual(contextDocuments(first).map((entity) => entity.ref.entityId).sort());

      const purchasingButton = buttonForContext(second, 'Purchasing workspace');
      const serviceButton = buttonForContext(second, 'Service workspace');
      expect.soft(serviceButton.ref.entityId).not.toBe(purchasingButton.ref.entityId);
      expect.soft(purchasingButton.ref.entityId).toBe(
        buttonForContext(first, 'Purchasing workspace').ref.entityId,
      );
      expect.soft(serviceButton.ref.entityId).toBe(
        buttonForContext(first, 'Service workspace').ref.entityId,
      );

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: second.view.revision,
        action: { kind: 'click', target: serviceButton.ref },
        budget: { maxCharacters: 5_000 },
      });

      expect(receipt.status).toBe('verified');
      expect(receipt.observation?.view.text).toContain('Service workspace submitted');
      expect(receipt.observation?.view.text).not.toContain('Purchasing workspace submitted');
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('reports frames omitted by the configured observation limit', async () => {
    const driver = createPlaywrightBrowserDriver({ maxFramesPerObservation: 2 });
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/same-url-frames`,
      });
      const frameDocuments = observation.entities.filter(
        (entity) => entity.kind === 'document',
      );

      expect(frameDocuments).toHaveLength(1);
      expect(observation.capturedOmissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'analysis',
            count: 1,
            reason: 'scan_cap',
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  it('observes a large control surface with stable targets and keeps late controls actionable', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const first = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/many-controls`,
      });
      const startedAt = performance.now();
      const second = await session.observe({ pageId: session.initialPageId });
      const elapsedMs = performance.now() - startedAt;
      const controls = (observation: typeof first) =>
        observation.entities.filter((entity) => entity.role === 'button');
      const firstSourceIds = controls(first).map((entity) => entity.sourceId);
      const secondControls = controls(second);

      expect(secondControls).toHaveLength(200);
      expect(secondControls.map((entity) => entity.sourceId)).toEqual(firstSourceIds);
      if (process.env['BROWSERIR_REPORT_OBSERVE_PERF'] === '1') {
        const samples = [elapsedMs];
        for (let sample = 1; sample < 5; sample += 1) {
          const sampleStartedAt = performance.now();
          await session.observe({ pageId: session.initialPageId });
          samples.push(performance.now() - sampleStartedAt);
        }
        samples.sort((left, right) => left - right);
        console.info(
          `Warm 200-control observation median: ${samples[2]!.toFixed(1)}ms ` +
            `(${samples.map((value) => value.toFixed(1)).join(', ')}ms)`,
        );
      }

      const last = secondControls.find((entity) => entity.name === 'Action 200');
      if (!last) throw new Error('missing late control');
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: last.target }),
      });
      const acted = await session.observe({ pageId: session.initialPageId });
      expect(acted.visibleText).toContain('Action 200 ran');
    } finally {
      await session.close();
    }
  }, 15_000);

  it('does not materialize standard controls beyond the bounded raw scan', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/standard-scan-cap`,
      });

      expect(
        observation.entities.some(
          (entity) => entity.name === 'Control beyond bounded scan',
        ),
      ).toBe(false);
      expect(observation.capturedOmissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'analysis',
            reason: 'scan_cap',
            exact: false,
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  it('reports role-less interaction candidates omitted by the per-frame retention cap', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();

    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: created.revision,
        url: `${origin}/custom-interaction-cap`,
        budget: { maxCharacters: 100_000 },
      });
      const customActions = observed.snapshot.entities.filter((entity) =>
        entity.name?.startsWith('Custom action '),
      );
      const omission = observed.view.structured.omissions.find(
        (candidate) =>
          candidate.kind === 'entities' && candidate.reason === 'scan_cap',
      );

      expect.soft(customActions).toHaveLength(200);
      expect.soft(omission).toMatchObject({ count: 2 });
      expect.soft(observed.view.text).toContain('[2 entities omitted: scan_cap]');
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('reports an inexact lower bound when the role-less interaction scan itself is capped', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();

    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: created.revision,
        url: `${origin}/custom-interaction-scan-cap`,
        budget: { maxCharacters: 100_000 },
      });
      const omission = observed.view.structured.omissions.find(
        (candidate) =>
          candidate.kind === 'analysis' &&
          candidate.reason === 'scan_cap' &&
          candidate.exact === false,
      );

      expect.soft(omission?.count).toBeGreaterThanOrEqual(1);
      expect.soft(observed.view.text).toMatch(
        /\[at least \d+ analysis omitted: scan_cap\]/,
      );
      expect.soft(observed.snapshot.entities).not.toContainEqual(
        expect.objectContaining({ name: 'Action beyond scan boundary' }),
      );
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('reports controls skipped by bounded semantic relationship analysis', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();

    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: created.revision,
        url: `${origin}/semantic-analysis-cap`,
        budget: { maxCharacters: 100_000 },
      });

      expect.soft(observed.view.structured.omissions).toContainEqual({
        kind: 'analysis',
        count: 1,
        reason: 'scan_cap',
      });
      expect.soft(observed.view.text).toContain(
        '[1 analysis omitted: scan_cap]',
      );
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  });

  it('redacts native and custom secret values without hiding ordinary business values', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observed = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/sensitive-custom-fields`,
      });
      const byName = new Map(
        observed.entities.map((entity) => [entity.name, entity]),
      );

      expect.soft(byName.get('One-time code')?.value).toBeUndefined();
      expect.soft(byName.get('API key')?.value).toBeUndefined();
      expect.soft(byName.has('Password')).toBe(true);
      expect.soft(byName.get('Password')?.value).toBeUndefined();
      expect.soft(byName.get('Password')?.state?.hasValue).toBe(true);
      expect.soft(byName.get('Customer reference')?.value).toBe('CUST-42');
      const serialized = JSON.stringify(observed);
      expect.soft(serialized).not.toContain('739201');
      expect.soft(serialized).not.toContain('sk-live-content-secret');
      expect.soft(serialized).not.toContain('custom-password-secret');
      expect.soft(serialized).toContain('CUST-42');
    } finally {
      await session.close();
    }
  });

  it('redacts credential-bearing URL components while preserving useful route context', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();
    const requested =
      `${origin}/url-secrets?code=authorization-secret&tab=customers` +
      '&X-Amz-Signature=signed-url-secret#access_token=fragment-secret&view=detail';

    try {
      const observed = await session.navigate({
        pageId: session.initialPageId,
        url: requested,
      });
      const pages = await session.pages();

      for (const modelUrl of [observed.url, pages[0]?.url]) {
        expect.soft(modelUrl).toBeDefined();
        expect.soft(modelUrl).not.toContain('authorization-secret');
        expect.soft(modelUrl).not.toContain('signed-url-secret');
        expect.soft(modelUrl).not.toContain('fragment-secret');
        expect.soft(modelUrl).toContain('tab=customers');
        expect.soft(modelUrl).toContain('view=detail');
        expect.soft(modelUrl).toContain('%5BREDACTED%5D');
      }
    } finally {
      await session.close();
    }
  });

  it('allocates cold target IDs in DOM order when concurrent fact reads finish out of order', async () => {
    const instrumentation = await instrumentElementHandleObservation();
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/skewed-controls`,
      });
      const controls = observation.entities.filter((entity) =>
        ['First action', 'Second action', 'Third action'].includes(entity.name ?? ''),
      );
      const targetNumbers = controls.map((entity) =>
        Number(entity.sourceId.replace(/^target_/, '')),
      );

      expect(controls.map((entity) => entity.name)).toEqual([
        'First action',
        'Second action',
        'Third action',
      ]);
      expect(targetNumbers).toEqual([...targetNumbers].sort((left, right) => left - right));
    } finally {
      await session.close();
      await instrumentation.restore();
    }
  });

  it('disposes target handles allocated by an observation batch that later fails', async () => {
    const instrumentation = await instrumentElementHandleObservation();
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      await expect(
        session.navigate({
          pageId: session.initialPageId,
          url: `${origin}/observation-failure`,
        }),
      ).rejects.toThrow('injected observation failure');

      expect(instrumentation.allocatedTargetHandles.size).toBeGreaterThan(0);
      expect(
        [...instrumentation.allocatedTargetHandles].every((handle) =>
          instrumentation.disposedHandles.has(handle),
        ),
      ).toBe(true);
    } finally {
      await session.close();
      await instrumentation.restore();
    }
  });

  it('executes typed actions against opaque targets and observes their effects', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      let observation = await session.navigate({ pageId: session.initialPageId, url: origin });
      const entity = (name: string) => {
        const match = observation.entities.find((candidate) => candidate.name === name);
        if (!match) throw new Error(`missing observed entity ${name}`);
        return match;
      };
      const customerIdentity = entity('Customer name').identityKey;

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'fill', target: entity('Customer name').target, value: 'Ada' }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'type', target: entity('Customer name').target, text: ' Motors' }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'select', target: entity('Status').target, values: ['active'] }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'check', target: entity('Priority customer').target, checked: true }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'press', target: entity('Customer name').target, key: 'Enter' }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'hover', target: entity('Help').target }),
      });
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'contextClick', target: entity('Save customer').target }),
      });
      expect(
        (await session.observe({ pageId: session.initialPageId })).visibleText,
      ).toContain('Context menu opened');
      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: entity('Save customer').target }),
      });

      observation = await session.observe({ pageId: session.initialPageId });
      expect(observation.visibleText).toContain('Ada Motors saved');
      expect(observation.visibleText).toContain('Helpful details');
      expect(entity('Customer name').value).toBe('Ada Motors');
      expect(entity('Customer name').identityKey).toBe(customerIdentity);
      expect(entity('Status').value).toBe('active');
      expect(entity('Priority customer').state?.checked).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('captures viewport and entity screenshots with stable metadata', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({ pageId: session.initialPageId, url: origin });
      const save = observation.entities.find((entity) => entity.name === 'Save customer');
      if (!save) throw new Error('missing save button');

      const viewport = await session.capture({ pageId: session.initialPageId, kind: 'viewport' });
      expect(viewport.mediaType).toBe('image/png');
      expect(viewport.data.byteLength).toBeGreaterThan(100);
      expect(viewport).toMatchObject({
        pageId: session.initialPageId,
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
      });

      const element = await session.capture({
        pageId: session.initialPageId,
        kind: 'entity',
        target: save.target,
      });
      expect(element.mediaType).toBe('image/png');
      expect(element.data.byteLength).toBeGreaterThan(100);
      expect(element.width).toBeGreaterThan(0);
      expect(element.height).toBeGreaterThan(0);
      expect(element.clip).toMatchObject({
        width: expect.any(Number),
        height: expect.any(Number),
      });
      expect(JSON.stringify(element)).not.toContain(save.target.opaqueId);
    } finally {
      await session.close();
    }
  });

  it('rejects an entity screenshot before capture when its physical area is oversized', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observed = await session.navigate({
        pageId: session.initialPageId,
        url: `${origin}/oversized-capture`,
      });
      const target = observed.entities.find(
        (entity) => entity.name === 'Oversized target',
      );
      if (target === undefined) throw new Error('missing oversized target');

      await expect(
        session.capture({
          pageId: session.initialPageId,
          kind: 'entity',
          target: target.target,
        }),
      ).rejects.toThrow(/physical-pixel limit/);
    } finally {
      await session.close();
    }
  });

  it('navigates links, tracks page state, and closes cleanly', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    const observation = await session.navigate({ pageId: session.initialPageId, url: origin });
    const link = observation.entities.find((entity) => entity.name === 'Open next screen');
    if (!link) throw new Error('missing navigation link');

    await session.act({
      pageId: session.initialPageId,
      action: action({ kind: 'click', target: link.target }),
    });
    const next = await session.observe({ pageId: session.initialPageId });
    expect(next.url).toBe(`${origin}/next`);
    expect(next.visibleText).toContain('Navigation worked.');

    await session.close();
    await expect(session.pages()).rejects.toThrow(/closed/i);
  });

  it('registers popup pages created by an observed opaque target', async () => {
    const driver = createPlaywrightBrowserDriver();
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({ pageId: session.initialPageId, url: origin });
      const popup = observation.entities.find((entity) => entity.name === 'Open details tab');
      if (!popup) throw new Error('missing popup button');

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: popup.target }),
      });

      await expect
        .poll(async () => (await session.pages()).length, { timeout: 5_000 })
        .toBe(2);
      const pages = await session.pages();
      expect(pages.some((page) => page.pageId !== session.initialPageId && page.url === `${origin}/next`)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('closes popups that exceed the configured per-session page limit', async () => {
    const driver = createPlaywrightBrowserDriver({ maxPagesPerSession: 2 });
    const session = await driver.createSession();

    try {
      const observation = await session.navigate({ pageId: session.initialPageId, url: origin });
      const popup = observation.entities.find((entity) => entity.name === 'Open details tab');
      if (!popup) throw new Error('missing popup button');

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: popup.target }),
      });
      await expect
        .poll(async () => (await session.pages()).length, { timeout: 5_000 })
        .toBe(2);

      await session.act({
        pageId: session.initialPageId,
        action: action({ kind: 'click', target: popup.target }),
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await session.pages()).toHaveLength(2);
    } finally {
      await session.close();
    }
  });
});
