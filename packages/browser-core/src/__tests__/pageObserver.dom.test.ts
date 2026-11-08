// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePageObserverInPage, installPageObserverInPage } from '../pageObserver';

afterEach(() => {
  disposePageObserverInPage();
  vi.restoreAllMocks();
  readableElements.length = 0;
  document.body.innerHTML = '';
});

const readableElements: HTMLElement[] = [];

function makeReadable(element: HTMLElement) {
  const left = 10 + readableElements.length * 20;
  readableElements.push(element);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, 10, 10, 10));
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const target = this.startContainer as HTMLElement;
    return (readableElements.includes(target)
      ? [target.getBoundingClientRect()]
      : []) as unknown as DOMRectList;
  });
  vi.spyOn(document, 'elementFromPoint').mockImplementation(x => {
    return (
      readableElements.find(item => {
        const rect = item.getBoundingClientRect();
        return x >= rect.left && x <= rect.right;
      }) ?? null
    );
  });
}

async function observe(html: string, change: (element: HTMLElement) => void) {
  document.body.innerHTML = html;
  const checkpoint = installPageObserverInPage();
  const state = (globalThis as any).__MEARL_PAGE_OBSERVER__;
  const result = state.waitSince(checkpoint.version, checkpoint.focus, 10, 50, 1000);
  change(document.getElementById('control')!);
  return result;
}

describe('page observer text updates', () => {
  it.each(['equivalent', 'different-text', 'hidden', 'ambiguous', 'removed', 'mixed'])(
    'only resolves a recorded text effect through an equivalent readable replacement: %s',
    async kind => {
      document.body.innerHTML = '<span id="control">1</span>';
      const original = document.getElementById('control')!;
      makeReadable(original);
      const checkpoint = installPageObserverInPage();
      original.textContent = '2';
      await new Promise(resolve => setTimeout(resolve, 0));
      const replacement = original.cloneNode(true) as HTMLElement;
      if (kind === 'different-text') replacement.textContent = '3';
      if (kind === 'hidden') replacement.hidden = true;
      if (kind === 'mixed') replacement.innerHTML = '2<input aria-label="New field">';
      if (kind === 'removed') original.remove();
      else {
        original.replaceWith(replacement);
        makeReadable(replacement);
      }
      if (kind === 'ambiguous') document.body.appendChild(replacement.cloneNode(true));
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
        checkpoint.version, checkpoint.focus, 10, 50, 1000,
      );
      expect(result.fullSnapshotRecommended).toBe(kind !== 'equivalent');
      if (kind === 'equivalent') {
        expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
        expect(result.snapshotReasons).toEqual([]);
      }
    },
  );
  it.each(['characterData', 'childList'])(
    'returns a readable plain text value for %s without treating it as a control',
    async kind => {
      const result = await observe('<span id="control">1</span>', element => {
        makeReadable(element);
        if (kind === 'characterData') element.firstChild!.textContent = '2';
        else element.textContent = '2';
      });
      expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
      expect(result.effects.interactives).toEqual([]);
      expect(result.fullSnapshotRecommended).toBe(false);
    },
  );

  it.each(['characterData', 'childList'])('returns a changed button label for %s', async kind => {
    const result = await observe('<button id="control"><span>Save</span></button>', button => {
      if (kind === 'characterData') button.firstChild!.firstChild!.textContent = 'Saved';
      else button.firstChild!.textContent = 'Saved';
    });
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        change: 'updated',
        node: expect.objectContaining({ selector: '#control', name: 'Saved' }),
      }),
    ]);
    expect(result.snapshotReasons).toEqual([]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('returns complete text changes in ARIA controls and notifications', async () => {
    for (const role of ['button', 'status']) {
      const result = await observe(`<div id="control" role="${role}">Pending</div>`, element => {
        element.textContent = 'Complete';
      });
      const effects =
        role === 'button' ? result.effects.interactives : result.effects.notifications;
      expect(effects).toEqual([
        expect.objectContaining({
          change: 'updated',
          node: expect.objectContaining({ name: 'Complete' }),
        }),
      ]);
      expect(result.fullSnapshotRecommended).toBe(false);
      disposePageObserverInPage();
    }
  });

  it.each([
    '<span id="control">Old</span>',
    '<button id="control" aria-label="Save">Old</button>',
    '<button hidden id="control">Old</button>',
    '<button><span hidden id="control">Old</span></button>',
  ])('keeps a fallback when the effect cannot represent the text: %s', async html => {
    const result = await observe(html, element => {
      element.firstChild!.textContent = 'New';
    });
    expect(result.fullSnapshotRecommended).toBe(true);
    expect(result.snapshotReasons).toContain('unclassified-structure');
  });

  it('keeps long labels and mixed structural changes outside text-only classification', async () => {
    const long = await observe('<button id="control">Old</button>', button => {
      button.textContent = 'x'.repeat(200);
    });
    expect(long.fullSnapshotRecommended).toBe(true);
    disposePageObserverInPage();
    const mixed = await observe('<button id="control">Old</button>', button => {
      button.innerHTML = '<span>New</span><input aria-label="Extra field">';
    });
    expect(mixed.fullSnapshotRecommended).toBe(true);
  });

  it('retains overflow when classified text changes exceed the observation budget', async () => {
    const result = await observe('<button id="control">Old</button>', button => {
      for (let i = 0; i < 600; i += 1) button.firstChild!.textContent = String(i);
    });
    expect(result.overflow).toBe(true);
    expect(result.fullSnapshotRecommended).toBe(true);
    expect(result.snapshotReasons).toContain('observation-overflow');
  });

  it.each([
    { tag: 'button', count: 13, limit: 12 },
    { tag: 'div role="status"', count: 9, limit: 8 },
  ])(
    'reports overflow when distinct text updates exceed the final effect limit: $tag',
    async ({ tag, count, limit }) => {
      const elementName = tag.split(' ')[0];
      document.body.innerHTML = Array.from(
        { length: count },
        (_, index) => `<${tag} id="control-${index}">Old</${elementName}>`,
      ).join('');
      const checkpoint = installPageObserverInPage();
      for (let index = 0; index < count; index += 1) {
        document.getElementById(`control-${index}`)!.textContent = `New ${index}`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
        checkpoint.version,
        checkpoint.focus,
        10,
        50,
        1000,
      );
      const effects =
        elementName === 'button' ? result.effects.interactives : result.effects.notifications;
      expect(effects).toHaveLength(limit);
      expect(result.overflow).toBe(true);
      expect(result.fullSnapshotRecommended).toBe(true);
      expect(result.snapshotReasons).toContain('observation-overflow');
    },
  );

  it('keeps the latest text of a notification that appeared during the action', async () => {
    const checkpoint = installPageObserverInPage();
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.textContent = 'Loading';
    document.body.appendChild(status);
    await new Promise(resolve => setTimeout(resolve, 0));
    status.textContent = 'Complete';
    const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
      checkpoint.version,
      checkpoint.focus,
      10,
      50,
      1000,
    );
    expect(result.effects.notifications).toEqual([
      expect.objectContaining({
        change: 'appeared',
        node: expect.objectContaining({ name: 'Complete' }),
      }),
    ]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('coalesces repeated text updates to one control without reporting distinct-effect overflow', async () => {
    document.body.innerHTML = '<button id="control">Old</button>';
    const checkpoint = installPageObserverInPage();
    for (let index = 0; index < 13; index += 1) {
      document.getElementById('control')!.textContent = `New ${index}`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
      checkpoint.version,
      checkpoint.focus,
      10,
      50,
      1000,
    );
    expect(result.effects.interactives).toHaveLength(1);
    expect(result.effects.interactives[0].node.name).toBe('New 12');
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('coalesces plain text to the latest value across mutation batches', async () => {
    document.body.innerHTML = '<span id="control">0</span>';
    const element = document.getElementById('control')!;
    makeReadable(element);
    const checkpoint = installPageObserverInPage();
    for (let index = 1; index <= 13; index += 1) {
      element.textContent = String(index);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
      checkpoint.version,
      checkpoint.focus,
      10,
      50,
      1000,
    );
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '13' }]);
    expect(result.overflow).toBe(false);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it.each(['same-batch', 'separate-batches'])(
    'bounds distinct plain text updates and retains overflow fallback for %s',
    async kind => {
      document.body.innerHTML = Array.from(
        { length: 10 },
        (_, i) => `<span id="value-${i}">0</span>`,
      ).join('');
      for (const element of document.querySelectorAll<HTMLElement>('span')) makeReadable(element);
      const checkpoint = installPageObserverInPage();
      for (const element of document.querySelectorAll('span')) {
        element.textContent = '1';
        if (kind === 'separate-batches') await new Promise(resolve => setTimeout(resolve, 0));
      }
      const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
        checkpoint.version,
        checkpoint.focus,
        10,
        50,
        1000,
      );
      expect(result.effects.texts).toHaveLength(8);
      expect(result.overflow).toBe(true);
      expect(result.fullSnapshotRecommended).toBe(true);
      expect(result.snapshotReasons).toContain('observation-overflow');
    },
  );

  it.each(['hidden', 'offscreen', 'covered', 'long', 'ambiguous', 'named-control', 'script'])(
    'keeps the snapshot fallback for unreadable or unsupported text: %s',
    async kind => {
      const html =
        kind === 'named-control'
          ? '<button aria-label="Save"><span id="control">Old</span></button>'
          : kind === 'script'
            ? '<script id="control" type="application/json">"Old"</script>'
            : '<span id="control">Old</span>';
      const result = await observe(html, element => {
        makeReadable(element);
        if (kind === 'hidden') element.hidden = true;
        if (kind === 'offscreen')
          vi.mocked(element.getBoundingClientRect).mockReturnValue(new DOMRect(-40, 10, 10, 10));
        if (kind === 'covered') vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
        if (kind === 'ambiguous') {
          const duplicate = document.createElement('span');
          duplicate.id = 'control';
          document.body.appendChild(duplicate);
        }
        element.firstChild!.textContent = kind === 'long' ? 'x'.repeat(161) : 'New';
      });
      expect(result.effects.texts).toBeUndefined();
      expect(result.fullSnapshotRecommended).toBe(true);
    },
  );

  it.each(['removed', 'hidden', 'covered'])(
    'does not return a text observation that became %s before settling',
    async kind => {
      document.body.innerHTML = '<span id="control">1</span>';
      const element = document.getElementById('control')!;
      makeReadable(element);
      const checkpoint = installPageObserverInPage();
      element.textContent = '2';
      await new Promise(resolve => setTimeout(resolve, 0));
      if (kind === 'removed') element.remove();
      if (kind === 'hidden') element.hidden = true;
      if (kind === 'covered') vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
      const result = await (globalThis as any).__MEARL_PAGE_OBSERVER__.waitSince(
        checkpoint.version,
        checkpoint.focus,
        10,
        50,
        1000,
      );
      expect(result.effects.texts).toBeUndefined();
      expect(result.fullSnapshotRecommended).toBe(true);
    },
  );

  it('retains structural fallback alongside a readable text update', async () => {
    const result = await observe('<span id="control">1</span>', element => {
      makeReadable(element);
      element.textContent = '2';
      document.body.appendChild(document.createElement('img'));
    });
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
    expect(result.fullSnapshotRecommended).toBe(true);
    expect(result.snapshotReasons).toContain('unclassified-structure');
  });

  it('keeps native control effects separate from plain text', async () => {
    const result = await observe(
      '<span id="control">1</span><button id="save">Save</button>',
      element => {
        makeReadable(element);
        element.textContent = '2';
        document.getElementById('save')!.textContent = 'Saved';
      },
    );
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
    expect(result.effects.interactives).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ selector: '#save', name: 'Saved' }),
      }),
    ]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('reports an empty current value when the text element retains a readable box', async () => {
    const result = await observe('<span id="control">1</span>', element => {
      makeReadable(element);
      element.textContent = '';
    });
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '' }]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('reads pointer-transparent text when its own ancestor receives the hit', async () => {
    const result = await observe(
      '<span id="control" style="pointer-events:none">1</span>',
      element => {
        makeReadable(element);
        vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
        element.textContent = '2';
      },
    );
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });

  it('retains fallback when layout inspection fails', async () => {
    const result = await observe('<span id="control">1</span>', element => {
      makeReadable(element);
      vi.mocked(document.elementFromPoint).mockImplementation(() => {
        throw new Error('unavailable');
      });
      element.textContent = '2';
    });
    expect(result.effects.texts).toBeUndefined();
    expect(result.fullSnapshotRecommended).toBe(true);
  });

  it.each(['offscreen', 'partially-offscreen', 'clipped', 'empty-range', 'too-many-lines'])(
    'does not treat the element box as proof that all its text is readable: %s',
    async kind => {
      const result = await observe('<span id="control">1</span>', element => {
        makeReadable(element);
        const rects =
          kind === 'offscreen'
            ? [new DOMRect(-9999, 10, 30, 10)]
            : kind === 'partially-offscreen'
              ? [new DOMRect(-5, 10, 30, 10)]
              : kind === 'clipped'
                ? [new DOMRect(10, 10, 30, 10)]
                : kind === 'too-many-lines'
                  ? Array.from({ length: 9 }, () => new DOMRect(10, 10, 10, 10))
                  : [];
        if (kind === 'clipped') element.style.overflowX = 'hidden';
        vi.mocked(Range.prototype.getClientRects).mockReturnValue(rects as unknown as DOMRectList);
        element.textContent = '123456';
      });
      expect(result.effects.texts).toBeUndefined();
      expect(result.fullSnapshotRecommended).toBe(true);
    },
  );

  it.each(['disc', 'circle', 'square'])('does not expose CSS-masked text: %s', async security => {
    const result = await observe('<span id="control">1</span>', element => {
      makeReadable(element);
      // Happy DOM omits this Chromium-only CSS property; model its computed value explicitly.
      const style = getComputedStyle(element);
      const readProperty = style.getPropertyValue.bind(style);
      vi.spyOn(style, 'getPropertyValue').mockImplementation(name =>
        name === '-webkit-text-security' ? security : readProperty(name),
      );
      element.textContent = '123456';
    });
    expect(result.effects.texts).toBeUndefined();
    expect(result.fullSnapshotRecommended).toBe(true);
  });

  it('retains readable wrapped text when every text rectangle passes the checks', async () => {
    const result = await observe('<span id="control">1</span>', element => {
      makeReadable(element);
      vi.mocked(Range.prototype.getClientRects).mockReturnValue([
        new DOMRect(10, 10, 10, 5),
        new DOMRect(10, 15, 10, 5),
      ] as unknown as DOMRectList);
      element.textContent = '2';
    });
    expect(result.effects.texts).toEqual([{ selector: '#control', text: '2' }]);
    expect(result.fullSnapshotRecommended).toBe(false);
  });
});
