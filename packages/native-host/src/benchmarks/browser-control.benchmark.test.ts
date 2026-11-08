import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { CdpSession, type PageSession } from '../cdp-backend/cdp-session.js';
import { readDevToolsActivePort } from '../cdp-backend/discover.js';
import { cdpPageClick, cdpPageEval, cdpPageWait } from '../cdp-backend/interaction-handlers.js';
import { cdpPageSnapshot } from '../cdp-backend/snapshot-handlers.js';
import { getPageRefRegistry } from '../cdp-backend/page-refs.js';
import { cdpObservedPageAction } from '../cdp-backend/composite-handlers.js';
import { resolveChromeExecutable } from '../managed-browser.js';

const ASYNC_DELAY_MS = 120;
const DELAYED_NAVIGATION_MS = 120;
const NETWORK_NAVIGATION_MS = 1600;
const BURST_INTERVAL_MS = 40;
const BURST_ITERATIONS = 6;
const SMALL_NODE_COUNT = 50;
const LARGE_NODE_COUNT = 2500;

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Protocol browser control benchmark</title>
  </head>
  <body>
    <main id="stage"></main>
    <script>
      const stage = document.querySelector('#stage');

      window.bench = {
        renderAsync(delay) {
          stage.innerHTML = '<button id="async-trigger">Start async update</button>';
          document.querySelector('#async-trigger').addEventListener('click', () => {
            setTimeout(() => {
              const ready = document.createElement('button');
              ready.id = 'async-ready';
              ready.textContent = 'Async result ready';
              stage.appendChild(ready);
            }, delay);
          });
        },

        renderBurst(interval, iterations) {
          stage.innerHTML = [
            '<button id="burst-trigger">Start mutation burst</button>',
            '<output id="burst-status" data-settled="false">0</output>',
          ].join('');
          document.querySelector('#burst-trigger').addEventListener('click', () => {
            const status = document.querySelector('#burst-status');
            let count = 0;
            const timer = setInterval(() => {
              count += 1;
              status.textContent = String(count);
              status.dataset.tick = String(count);
              if (count === iterations) {
                clearInterval(timer);
                status.dataset.settled = 'true';
              }
            }, interval);
          });
        },

        renderRows(count) {
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < count; index += 1) {
            const row = document.createElement(index % 20 === 0 ? 'button' : 'p');
            row.id = 'row-' + index;
            row.textContent =
              (index % 20 === 0 ? 'Row action ' : 'Row content ') +
              String(index).padStart(4, '0');
            fragment.appendChild(row);
          }
          stage.replaceChildren(fragment);
        },

        renderLargeAsync(count, delay) {
          const fragment = document.createDocumentFragment();
          const trigger = document.createElement('button');
          trigger.id = 'large-async-trigger';
          trigger.textContent = 'Load one more result';
          trigger.addEventListener('click', () => {
            setTimeout(() => {
              const ready = document.createElement('button');
              ready.id = 'large-async-ready';
              ready.textContent = 'Async result ready';
              stage.appendChild(ready);
            }, delay);
          });
          fragment.appendChild(trigger);
          for (let index = 0; index < count; index += 1) {
            const button = document.createElement('button');
            button.id = 'large-row-' + index;
            button.textContent = 'Existing row ' + String(index).padStart(4, '0');
            fragment.appendChild(button);
          }
          stage.replaceChildren(fragment);
        },

        mutateRow(index) {
          document.querySelector('#row-' + index).textContent = 'Changed row ' + index;
        },

        renderRef() {
          stage.innerHTML = '<button id="replace-target">Replace target</button>';
          document.querySelector('#replace-target').setAttribute(
            'onclick',
            "this.dataset.clicked='true'",
          );
        },

        replaceRef() {
          const current = document.querySelector('#replace-target');
          const replacement = current.cloneNode(true);
          replacement.removeAttribute('data-clicked');
          current.replaceWith(replacement);
        },

        currentRefClicked() {
          return document.querySelector('#replace-target').dataset.clicked === 'true';
        },

        renderDelayedNavigation(delay) {
          stage.innerHTML = '<button id="navigation-trigger">Open next page</button>';
          document.querySelector('#navigation-trigger').addEventListener('click', () => {
            setTimeout(() => {
              location.href = '/benchmark?navigation=' + Date.now();
            }, delay);
          });
        },

        renderNetworkNavigation(delay) {
          stage.innerHTML = '<button id="network-navigation-trigger">Search and open</button>';
          document.querySelector('#network-navigation-trigger').addEventListener('click', () => {
            fetch('/navigation-ready?delay=' + delay, { cache: 'no-store' }).then(() => {
              location.href = '/benchmark?network-navigation=' + Date.now();
            });
          });
        },
      };

      document.documentElement.dataset.benchmarkReady = 'true';
    </script>
  </body>
</html>`;

type Direction = 'lower' | 'higher' | 'neutral';
type Aggregation = 'median' | 'mean';

interface MetricDefinition {
  unit: 'ms' | 'chars' | 'count' | 'ratio';
  direction: Direction;
  aggregation?: Aggregation;
}

interface MetricSummary extends MetricDefinition {
  aggregation: Aggregation;
  samples: number[];
  value: number;
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface TrialResult {
  [name: string]: number;
}

const METRICS: Record<string, MetricDefinition> = {
  'wait.async_element.overshoot_ms': { unit: 'ms', direction: 'lower' },
  'wait.mutation_burst.overshoot_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.small.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.large.full_elapsed_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.large.full_output_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.full_response_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.full_ref_count': { unit: 'count', direction: 'neutral' },
  'snapshot.large.default_elapsed_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.large.default_output_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.default_response_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.viewport_elapsed_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.large.viewport_output_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.viewport_response_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.viewport_ref_count': { unit: 'count', direction: 'neutral' },
  'snapshot.large.interactive_elapsed_ms': { unit: 'ms', direction: 'lower' },
  'snapshot.large.interactive_output_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.interactive_response_chars': { unit: 'chars', direction: 'neutral' },
  'snapshot.large.interactive_ref_count': { unit: 'count', direction: 'neutral' },
  'snapshot.single_mutation.full_refresh_ms': { unit: 'ms', direction: 'lower' },
  'ref.stale_detected_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'ref.stale_silent_failure_ratio': {
    unit: 'ratio',
    direction: 'lower',
    aggregation: 'mean',
  },
  'ref.recovery.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'ref.recovery.success_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'loop.legacy.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'loop.legacy.observation_chars': { unit: 'chars', direction: 'lower' },
  'loop.action_observe.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'loop.action_observe.observation_chars': { unit: 'chars', direction: 'lower' },
  'loop.action_observe.target_recall_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'navigation.page_act.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'navigation.page_act.observation_chars': { unit: 'chars', direction: 'lower' },
  'navigation.page_act.detected_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'navigation.page_act.loaded_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'navigation.network_page_act.elapsed_ms': { unit: 'ms', direction: 'lower' },
  'navigation.network_page_act.detected_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
  'navigation.network_page_act.loaded_ratio': {
    unit: 'ratio',
    direction: 'higher',
    aggregation: 'mean',
  },
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function quantile(sorted: number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index]!;
}

function summarize(samples: number[], definition: MetricDefinition): MetricSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const aggregation = definition.aggregation ?? 'median';

  return {
    ...definition,
    aggregation,
    samples: samples.map(round),
    value: round(aggregation === 'mean' ? mean : median),
    mean: round(mean),
    median: round(median),
    p95: round(quantile(sorted, 0.95)),
    min: round(sorted[0]!),
    max: round(sorted.at(-1)!),
  };
}

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/navigation-ready')) {
      const requestUrl = new URL(request.url, 'http://localhost');
      const delay = Number(requestUrl.searchParams.get('delay') ?? 0);
      setTimeout(() => {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      }, delay);
      return;
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(FIXTURE_HTML);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/benchmark` };
}

async function waitForChrome(
  userDataDir: string,
  chrome: ChildProcess,
  timeoutMs = 15000,
): Promise<{ port: number; browserWsPath: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready (${chrome.exitCode})`);
    }
    const activePort = readDevToolsActivePort(userDataDir);
    if (activePort) return activePort;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Chrome CDP did not become ready within ${timeoutMs}ms`);
}

async function waitForBenchmarkPage(session: CdpSession, timeoutMs = 10000): Promise<PageSession> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const page = await session.getPageSession();
      const ready = await cdpPageEval(page, {
        expression: "document.documentElement.dataset.benchmarkReady === 'true'",
      });
      if (ready.result === true) return page;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Benchmark page did not become ready: ${String(lastError)}`);
}

async function stopChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null) return;
  chrome.kill('SIGTERM');
  await Promise.race([
    once(chrome, 'exit'),
    new Promise(resolveDelay => setTimeout(resolveDelay, 2000)),
  ]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
}

async function evaluate<T>(session: PageSession, expression: string): Promise<T> {
  const response = await cdpPageEval(session, { expression });
  return response.result as T;
}

function findRef(snapshot: string, accessibleName: string): string {
  const escaped = accessibleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(new RegExp(`(@e\\d+) \\[button "${escaped}"\\]`));
  if (!match) throw new Error(`No snapshot ref found for button "${accessibleName}"`);
  return match[1]!;
}

async function timed<T>(operation: () => Promise<T>): Promise<{ elapsed: number; result: T }> {
  const start = performance.now();
  const result = await operation();
  return { elapsed: performance.now() - start, result };
}

async function runTrial(
  cdpSession: CdpSession,
  session: PageSession,
  tabId: number,
): Promise<TrialResult> {
  const metrics: TrialResult = {};

  await evaluate(session, `window.bench.renderAsync(${ASYNC_DELAY_MS})`);
  await cdpPageClick(session, { selector: '#async-trigger' });
  const asyncWait = await timed(() =>
    cdpPageWait(session, {
      condition: "!!document.querySelector('#async-ready')",
      timeout: 3000,
    }),
  );
  metrics['wait.async_element.overshoot_ms'] = Math.max(0, asyncWait.elapsed - ASYNC_DELAY_MS);

  await evaluate(session, `window.bench.renderBurst(${BURST_INTERVAL_MS}, ${BURST_ITERATIONS})`);
  await cdpPageClick(session, { selector: '#burst-trigger' });
  const burstWait = await timed(() =>
    cdpPageWait(session, {
      condition: "document.querySelector('#burst-status')?.dataset.settled === 'true'",
      timeout: 3000,
    }),
  );
  const burstDuration = BURST_INTERVAL_MS * BURST_ITERATIONS;
  metrics['wait.mutation_burst.overshoot_ms'] = Math.max(0, burstWait.elapsed - burstDuration);

  await evaluate(session, `window.bench.renderRows(${SMALL_NODE_COUNT})`);
  const smallSnapshot = await timed(() => cdpPageSnapshot(session, { maxChars: 0 }));
  metrics['snapshot.small.elapsed_ms'] = smallSnapshot.elapsed;
  const scopedSnapshot = await cdpPageSnapshot(session, {
    rootSelector: '#stage',
    maxChars: 0,
  });
  expect(scopedSnapshot.snapshot).toContain('Row action 0000');
  expect(scopedSnapshot.snapshot).toContain(
    `Row content ${String(SMALL_NODE_COUNT - 1).padStart(4, '0')}`,
  );

  await evaluate(session, `window.bench.renderRows(${LARGE_NODE_COUNT})`);
  const largeSnapshot = await timed(() => cdpPageSnapshot(session, { maxChars: 0 }));
  metrics['snapshot.large.full_elapsed_ms'] = largeSnapshot.elapsed;
  metrics['snapshot.large.full_output_chars'] = largeSnapshot.result.snapshot.length;
  metrics['snapshot.large.full_response_chars'] = JSON.stringify(largeSnapshot.result).length;
  metrics['snapshot.large.full_ref_count'] = getPageRefRegistry(session).size;

  const defaultSnapshot = await timed(() => cdpPageSnapshot(session, {}));
  metrics['snapshot.large.default_elapsed_ms'] = defaultSnapshot.elapsed;
  metrics['snapshot.large.default_output_chars'] = defaultSnapshot.result.snapshot.length;
  metrics['snapshot.large.default_response_chars'] = JSON.stringify(defaultSnapshot.result).length;

  const viewportSnapshot = await timed(() =>
    cdpPageSnapshot(session, { mode: 'viewport', maxChars: 0 }),
  );
  metrics['snapshot.large.viewport_elapsed_ms'] = viewportSnapshot.elapsed;
  metrics['snapshot.large.viewport_output_chars'] = viewportSnapshot.result.snapshot.length;
  metrics['snapshot.large.viewport_response_chars'] = JSON.stringify(
    viewportSnapshot.result,
  ).length;
  metrics['snapshot.large.viewport_ref_count'] = getPageRefRegistry(session).size;

  const interactiveSnapshot = await timed(() =>
    cdpPageSnapshot(session, { mode: 'interactive', maxChars: 0 }),
  );
  metrics['snapshot.large.interactive_elapsed_ms'] = interactiveSnapshot.elapsed;
  metrics['snapshot.large.interactive_output_chars'] = interactiveSnapshot.result.snapshot.length;
  metrics['snapshot.large.interactive_response_chars'] = JSON.stringify(
    interactiveSnapshot.result,
  ).length;
  metrics['snapshot.large.interactive_ref_count'] = getPageRefRegistry(session).size;

  await evaluate(session, `window.bench.mutateRow(${Math.floor(LARGE_NODE_COUNT / 2)})`);
  const singleMutationSnapshot = await timed(() => cdpPageSnapshot(session, { maxChars: 0 }));
  metrics['snapshot.single_mutation.full_refresh_ms'] = singleMutationSnapshot.elapsed;

  await evaluate(session, 'window.bench.renderRef()');
  const refSnapshot = await cdpPageSnapshot(session, { maxChars: 0 });
  const staleRef = findRef(refSnapshot.snapshot, 'Replace target');
  await evaluate(session, 'window.bench.replaceRef()');
  let staleDetected = 0;
  let staleReportedSuccess = false;
  try {
    await cdpPageClick(session, { selector: staleRef });
    staleReportedSuccess = true;
  } catch {
    staleDetected = 1;
  }
  const staleAffectedCurrentNode = await evaluate<boolean>(
    session,
    'window.bench.currentRefClicked()',
  );
  metrics['ref.stale_detected_ratio'] = staleDetected;
  metrics['ref.stale_silent_failure_ratio'] =
    staleReportedSuccess && !staleAffectedCurrentNode ? 1 : 0;

  const recovery = await timed(async () => {
    const freshSnapshot = await cdpPageSnapshot(session, { maxChars: 0 });
    const freshRef = findRef(freshSnapshot.snapshot, 'Replace target');
    await cdpPageClick(session, { selector: freshRef });
  });
  const recoverySucceeded = await evaluate<boolean>(session, 'window.bench.currentRefClicked()');
  metrics['ref.recovery.elapsed_ms'] = recovery.elapsed;
  metrics['ref.recovery.success_ratio'] = recoverySucceeded ? 1 : 0;

  await evaluate(session, `window.bench.renderLargeAsync(${LARGE_NODE_COUNT}, ${ASYNC_DELAY_MS})`);
  const legacyLoop = await timed(async () => {
    await cdpPageClick(session, { selector: '#large-async-trigger' });
    await cdpPageWait(session, {
      condition: "!!document.querySelector('#large-async-ready')",
      timeout: 3000,
    });
    return cdpPageSnapshot(session, { maxChars: 0 });
  });
  metrics['loop.legacy.elapsed_ms'] = legacyLoop.elapsed;
  metrics['loop.legacy.observation_chars'] = legacyLoop.result.snapshot.length;

  await evaluate(session, `window.bench.renderLargeAsync(${LARGE_NODE_COUNT}, ${ASYNC_DELAY_MS})`);
  const actionObserveLoop = await timed(() =>
    cdpObservedPageAction(cdpSession, 'page_click', {
      tabId,
      selector: '#large-async-trigger',
      observe: { quietMs: 100, firstChangeTimeoutMs: 500, timeoutMs: 3000 },
    }),
  );
  const observation = actionObserveLoop.result.observation;
  const targetRecalled =
    observation.mode === 'delta' &&
    observation.effects.interactives.some(
      (effect: any) => effect.node.name === 'Async result ready',
    );
  metrics['loop.action_observe.elapsed_ms'] = actionObserveLoop.elapsed;
  metrics['loop.action_observe.observation_chars'] = JSON.stringify(observation).length;
  metrics['loop.action_observe.target_recall_ratio'] = targetRecalled ? 1 : 0;

  await evaluate(session, `window.bench.renderDelayedNavigation(${DELAYED_NAVIGATION_MS})`);
  const navigationLoop = await timed(() =>
    cdpObservedPageAction(cdpSession, 'page_click', {
      tabId,
      selector: '#navigation-trigger',
      observe: {
        quietMs: 100,
        firstChangeTimeoutMs: 500,
        timeoutMs: 3000,
        navigationGraceMs: 1000,
        navigationTimeoutMs: 10000,
      },
    }),
  );
  const navigationObservation = navigationLoop.result.observation;
  metrics['navigation.page_act.elapsed_ms'] = navigationLoop.elapsed;
  metrics['navigation.page_act.observation_chars'] = JSON.stringify(navigationObservation).length;
  metrics['navigation.page_act.detected_ratio'] =
    navigationObservation.mode === 'navigation' ? 1 : 0;
  metrics['navigation.page_act.loaded_ratio'] =
    navigationObservation.mode === 'navigation' && navigationObservation.loaded ? 1 : 0;

  await evaluate(session, `window.bench.renderNetworkNavigation(${NETWORK_NAVIGATION_MS})`);
  const networkNavigationLoop = await timed(() =>
    cdpObservedPageAction(cdpSession, 'page_click', {
      tabId,
      selector: '#network-navigation-trigger',
    }),
  );
  const networkNavigationObservation = networkNavigationLoop.result.observation;
  metrics['navigation.network_page_act.elapsed_ms'] = networkNavigationLoop.elapsed;
  metrics['navigation.network_page_act.detected_ratio'] =
    networkNavigationObservation.mode === 'navigation' ? 1 : 0;
  metrics['navigation.network_page_act.loaded_ratio'] =
    networkNavigationObservation.mode === 'navigation' && networkNavigationObservation.loaded
      ? 1
      : 0;

  expect(recoverySucceeded).toBe(true);
  expect(actionObserveLoop.result.action.success).toBe(true);
  expect(targetRecalled).toBe(true);
  expect(navigationObservation.mode).toBe('navigation');
  expect(navigationObservation.loaded).toBe(true);
  expect(networkNavigationObservation.mode).toBe('navigation');
  expect(networkNavigationObservation.loaded).toBe(true);
  return metrics;
}

function gitMetadata(): { commit: string; dirty: boolean; patchHash: string } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    const patch = execFileSync('git', ['diff', 'HEAD', '--binary']);
    return {
      commit,
      dirty: status !== '',
      patchHash: createHash('sha256').update(patch).digest('hex'),
    };
  } catch {
    return { commit: 'unknown', dirty: true, patchHash: 'unknown' };
  }
}

const runBenchmark = process.env.MEARL_RUN_BROWSER_BENCHMARK === '1';

describe.runIf(runBenchmark)('browser control benchmark', () => {
  it('records the current native CDP control baseline', async () => {
    const trials = Number(process.env.MEARL_BROWSER_BENCHMARK_TRIALS ?? 7);
    const warmups = Number(process.env.MEARL_BROWSER_BENCHMARK_WARMUPS ?? 1);
    const outputPath = resolve(
      process.env.MEARL_BROWSER_BENCHMARK_OUTPUT ??
        'benchmarks/browser-control/results/latest.json',
    );
    const { server, url } = await startFixtureServer();
    const userDataDir = mkdtempSync(join(tmpdir(), 'mearl-browser-benchmark-'));
    const chromeArgs = [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,720',
      ...(platform() === 'linux' ? ['--no-sandbox'] : []),
      url,
    ];
    const chrome = spawn(resolveChromeExecutable(), chromeArgs, {
      stdio: 'ignore',
      windowsHide: true,
    });
    let cdpSession: CdpSession | undefined;

    try {
      const activePort = await waitForChrome(userDataDir, chrome);
      cdpSession = new CdpSession({ port: activePort.port, userDataDir });
      const initialPageSession = await waitForBenchmarkPage(cdpSession);
      const tabId = await cdpSession.registerTarget(initialPageSession.targetId);
      const pageSession = await cdpSession.getPageSession(tabId);
      const browserVersion = await (
        await cdpSession.getBrowserClient()
      ).sendCommand('Browser.getVersion', {});

      for (let index = 0; index < warmups; index += 1) {
        await runTrial(cdpSession, pageSession, tabId);
      }

      const trialResults: TrialResult[] = [];
      for (let index = 0; index < trials; index += 1) {
        trialResults.push(await runTrial(cdpSession, pageSession, tabId));
      }

      const metrics: Record<string, MetricSummary> = {};
      for (const [name, definition] of Object.entries(METRICS)) {
        metrics[name] = summarize(
          trialResults.map(result => result[name]!),
          definition,
        );
      }

      const legacyElapsed = metrics['loop.legacy.elapsed_ms'].value;
      const observedElapsed = metrics['loop.action_observe.elapsed_ms'].value;
      const legacyChars = metrics['loop.legacy.observation_chars'].value;
      const observedChars = metrics['loop.action_observe.observation_chars'].value;
      const report = {
        schemaVersion: 1,
        benchmark: 'mearl-browser-control',
        implementation: 'native-host-cdp',
        generatedAt: new Date().toISOString(),
        git: gitMetadata(),
        environment: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? 'unknown',
          cpuCount: cpus().length,
          totalMemoryBytes: totalmem(),
          node: process.version,
          chrome: browserVersion.product,
          protocolVersion: browserVersion.protocolVersion,
        },
        config: {
          trials,
          warmups,
          viewport: { width: 1280, height: 720 },
          asyncDelayMs: ASYNC_DELAY_MS,
          delayedNavigationMs: DELAYED_NAVIGATION_MS,
          networkNavigationMs: NETWORK_NAVIGATION_MS,
          burstIntervalMs: BURST_INTERVAL_MS,
          burstIterations: BURST_ITERATIONS,
          smallNodeCount: SMALL_NODE_COUNT,
          largeNodeCount: LARGE_NODE_COUNT,
        },
        comparisons: {
          actionObserveVsLegacy: {
            elapsedReductionPercent: round((1 - observedElapsed / legacyElapsed) * 100),
            observationReductionPercent: round((1 - observedChars / legacyChars) * 100),
          },
        },
        metrics,
      };

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Browser control benchmark written to ${outputPath}`);
    } finally {
      cdpSession?.close();
      server.close();
      await stopChrome(chrome);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 180000);
});
