import { describe, expect, it } from 'vitest';

import {
  createPageClickResult,
  describePageClickDispatchAttempt,
  resolvePageClickDispatchPolicy,
} from '../domClicking';

describe('resolvePageClickDispatchPolicy', () => {
  it('uses trusted mouse input for a visible desktop page', () => {
    expect(resolvePageClickDispatchPolicy(undefined, 'visible', false)).toEqual({
      clickMode: 'mouse',
      stateAwareControls: true,
    });
  });

  it('uses trusted touch input when mobile emulation is enabled', () => {
    expect(resolvePageClickDispatchPolicy('auto', 'visible', true)).toEqual({
      clickMode: 'touch',
      stateAwareControls: true,
    });
  });

  it('uses the DOM fallback when the page is hidden', () => {
    expect(resolvePageClickDispatchPolicy(undefined, 'hidden', true)).toEqual({
      clickMode: 'dom',
      stateAwareControls: true,
      fallbackReason: 'page-hidden',
    });
  });

  it('keeps an explicit DOM click on a hidden page', () => {
    expect(resolvePageClickDispatchPolicy('dom', 'hidden', true)).toEqual({
      clickMode: 'dom',
      stateAwareControls: true,
    });
  });

  it('preserves an explicit trusted-input mode on a hidden page', () => {
    expect(resolvePageClickDispatchPolicy('mouse', 'hidden', true)).toEqual({
      clickMode: 'mouse',
      stateAwareControls: false,
    });
  });
});

describe('createPageClickResult', () => {
  it('omits repeated target descriptions for a direct click', () => {
    expect(
      createPageClickResult(
        { kind: 'ref', selector: '@e2', role: 'clickable', name: '' },
        { tag: 'div', text: '', dispatchMode: 'dom' },
      ),
    ).toEqual({
      clicked: true,
      requestedTarget: { kind: 'ref', selector: '@e2', role: 'clickable' },
      tag: 'div',
      text: '',
      dispatchMode: 'dom',
    });
  });

  it('separates the resolved source node from the dispatch and hit targets', () => {
    expect(
      createPageClickResult(
        { kind: 'ref', selector: '@e4', role: 'StaticText', name: '搜索机票' },
        {
          tag: 'div',
          text: '今日购票至高减¥10',
          sourceTarget: { tag: 'div', text: '搜索机票 今日购票至高减¥10' },
          strategy: 'single-child-descendant',
          distance: 2,
          hitTarget: { tag: 'div', text: '搜索机票', selector: '.search-label' },
          actionableAncestorCandidates: [
            {
              selector: '.search-card',
              tag: 'div',
              text: '搜索机票 今日购票至高减¥10',
              distance: 1,
              reason: 'containing-block',
            },
          ],
        },
      ),
    ).toMatchObject({
      requestedTarget: { name: '搜索机票' },
      resolvedTarget: {
        tag: 'div',
        text: '搜索机票 今日购票至高减¥10',
        strategy: 'single-child-descendant',
        distance: 2,
      },
      dispatchTarget: { tag: 'div', text: '今日购票至高减¥10' },
      hitTarget: { tag: 'div', text: '搜索机票', selector: '.search-label' },
      actionableAncestorCandidates: [expect.objectContaining({ selector: '.search-card' })],
    });
  });
});

describe('describePageClickDispatchAttempt', () => {
  it('omits repeated target fields while preserving meaningful differences', () => {
    expect(
      describePageClickDispatchAttempt({
        tag: 'button',
        text: '下一步',
        sourceTarget: { tag: 'span', text: '下一步' },
        strategy: 'actionable-ancestor',
        distance: 1,
        hitTarget: { tag: 'button', text: '下一步' },
        coordinates: {
          coordinateSpace: 'outer-viewport',
          outerPoint: { x: 100, y: 200 },
        },
        actionableAncestorCandidates: [
          {
            selector: '.footer',
            tag: 'div',
            text: '很长的候选容器文案',
            distance: 2,
            reason: 'containing-block',
          },
        ],
        dispatchMode: 'trusted-input',
        pointerType: 'mouse',
      }),
    ).toEqual({
      resolvedTarget: {
        tag: 'span',
        text: '下一步',
        strategy: 'actionable-ancestor',
        distance: 1,
      },
      dispatchTarget: { tag: 'button', text: '下一步' },
      coordinates: {
        coordinateSpace: 'outer-viewport',
        outerPoint: { x: 100, y: 200 },
      },
      actionableAncestorCandidates: [
        { selector: '.footer', distance: 2, reason: 'containing-block' },
      ],
      dispatchMode: 'trusted-input',
      pointerType: 'mouse',
    });
  });

  it('keeps only one target description for a direct hit', () => {
    expect(
      describePageClickDispatchAttempt({
        tag: 'div',
        text: '确认',
        hitTarget: { tag: 'div', text: '确认' },
        dispatchMode: 'trusted-input',
        pointerType: 'touch',
      }),
    ).toEqual({
      resolvedTarget: { tag: 'div', text: '确认' },
      dispatchMode: 'trusted-input',
      pointerType: 'touch',
    });
  });
});
