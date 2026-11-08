import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createElementPicker } from '../elementPicker';
import { installElementCollectorBridge } from '../injected/collectElement';

const commentLabels = {
  title: 'Element comment',
  placeholder: 'Describe how this element should change…',
  edit: 'Edit element comment',
  move: 'Move comment panel',
  skip: 'Cancel',
  add: 'Add & continue',
  styleChanges: 'Style changes',
  valuePlaceholder: 'For example, 16px',
  styleProperties: {
    textContent: 'Text content',
    color: 'Text color',
    backgroundColor: 'Background',
    opacity: 'Opacity',
    fontFamily: 'Font',
    fontSize: 'Font size',
    fontWeight: 'Font weight',
    lineHeight: 'Line height',
    letterSpacing: 'Letter spacing',
    textAlign: 'Text align',
    margin: 'Margin',
    padding: 'Padding',
    borderRadius: 'Radius',
    borderColor: 'Border color',
    borderWidth: 'Border width',
    width: 'Width',
    height: 'Height',
  },
};

describe('elementPicker', () => {
  let postMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => installElementCollectorBridge());

  beforeEach(() => {
    document.title = 'Checkout';
    document.body.innerHTML =
      '<main><button id="submit" data-testid="submit-order">Submit order</button></main>';
    (chrome.runtime.sendMessage as unknown as Mock).mockReset().mockResolvedValue(undefined);
    postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(message => {
      window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
    });
  });

  afterEach(() => {
    postMessageSpy.mockRestore();
    vi.unstubAllGlobals();
    document.getElementById('mearl-element-comment-editor')?.remove();
    document
      .querySelectorAll('[data-mearl-element-comment-marker]')
      .forEach(marker => marker.remove());
  });

  it('returns structured element and page context for a picked node', async () => {
    const target = document.querySelector('#submit')!;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    createElementPicker().startElementPicker();
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    );

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKED',
        text: 'Submit order',
        page: {
          url: window.location.href,
          title: 'Checkout',
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
        element: expect.objectContaining({
          tagName: 'button',
          id: 'submit',
          selector: 'button#submit',
          attributes: expect.objectContaining({ 'data-testid': 'submit-order' }),
          textContent: 'Submit order',
        }),
      }),
    );
    expect(document.querySelector('#mearl-pick-highlight')).toBeNull();
  });

  it('picks an element from a touch tap without requiring touch movement', async () => {
    const target = document.querySelector('#submit')!;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    createElementPicker().startElementPicker();
    const touchend = new Event('touchend', { bubbles: true, cancelable: false });
    Object.defineProperty(touchend, 'changedTouches', {
      value: [{ clientX: 10, clientY: 20 }],
    });
    document.dispatchEvent(touchend);

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'mearl-content-script',
          type: 'ELEMENT_PICKED',
          text: 'Submit order',
          element: expect.objectContaining({ id: 'submit' }),
        }),
      ),
    );
    expect(document.querySelector('#mearl-pick-highlight')).toBeNull();
  });

  it('keeps top-page and iframe context separate for a picked node', async () => {
    const target = document.querySelector('#submit')!;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });
    const topPage = {
      url: 'https://example.com/checkout',
      title: 'Checkout shell',
      viewport: { width: 1280, height: 720 },
    };

    createElementPicker().startElementPicker({ topPage });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    );

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'mearl-content-script',
          type: 'ELEMENT_PICKED',
          page: topPage,
          frame: {
            url: window.location.href,
            title: 'Checkout',
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
          },
        }),
      ),
    );
  });

  it('exits comment mode when the page is right-clicked', async () => {
    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });

    const contextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(document.getElementById('mearl-pick-highlight')).toBeNull();
    expect(document.getElementById('mearl-pick-style')).toBeNull();
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        source: 'mearl-content-script',
        type: 'ELEMENT_PICK_CANCELLED',
      }),
    );

    const nextContextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(nextContextMenuEvent);
    expect(nextContextMenuEvent.defaultPrevented).toBe(false);
  });

  it('pauses and resumes a continuous picker without losing its options', () => {
    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });

    expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    picker.pauseElementPicker();
    expect(document.getElementById('mearl-pick-highlight')).toBeNull();

    picker.resumeElementPicker();
    expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    picker.stopElementPicker(false);
  });

  it('finishes a single-use comment picker after one confirmation', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({
      commentMode: true,
      continuousCommentMode: false,
      commentLabels: { ...commentLabels, add: 'Add' },
    });
    document.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 20,
      }),
    );

    const editor = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).not.toBeNull();
      return current!;
    });
    const shadow = editor.shadowRoot!;
    const comment = shadow.querySelector<HTMLTextAreaElement>('textarea')!;
    comment.value = 'Make the action clearer';
    comment.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    shadow.querySelector<HTMLButtonElement>('.composer-confirm')!.click();

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_COMMENT_CONFIRMED',
          comment: 'Make the action clearer',
        }),
      ),
    );
    expect(document.getElementById('mearl-element-comment-editor')).toBeNull();
    expect(document.getElementById('mearl-pick-highlight')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
      source: 'mearl-content-script',
      type: 'ELEMENT_PICKER_RESUMED',
    });
    picker.stopElementPicker(false);
  });

  it('only keeps picker surfaces and trace overlays visible in the active frame', () => {
    const target = document.querySelector('#submit')!;
    const onFrameActive = vi.fn();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    chrome.i18n = { getMessage: vi.fn(() => 'Tap to select') } as unknown as typeof chrome.i18n;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });
    const picker = createElementPicker({ onFrameActive });
    picker.startElementPicker({ traceMode: true });

    const hint = document.getElementById('mearl-pick-hint')!;
    expect(hint.style.visibility).toBe('hidden');
    expect(document.getElementById('mearl-pick-style')).toHaveTextContent(
      'top: calc(env(safe-area-inset-top, 0px) + 12px)',
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SHOW_COMPONENT_OVERLAY' }),
      '*',
    );

    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 20 }),
    );
    const highlight = document.getElementById('mearl-pick-highlight')!;
    expect(onFrameActive).toHaveBeenCalledOnce();
    expect(highlight.style.visibility).toBe('visible');
    expect(hint.style.visibility).toBe('visible');
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SHOW_COMPONENT_OVERLAY' }),
      '*',
    );

    picker.setPickerFrameActive(false);
    expect(highlight.style.visibility).toBe('hidden');
    expect(hint.style.visibility).toBe('hidden');
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HIDE_COMPONENT_OVERLAY' }),
      '*',
    );

    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 12, clientY: 22 }),
    );
    expect(onFrameActive).toHaveBeenCalledTimes(2);
    expect(highlight.style.visibility).toBe('visible');
    picker.stopElementPicker(false);
  });

  it('shows the comment editor beside the picked element and resumes after confirmation', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    target.style.fontSize = '14px';
    target.style.padding = '8px 12px';
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      right: 200,
      top: 100,
      bottom: 140,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }),
    );

    const host = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).not.toBeNull();
      return current!;
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      source: 'mearl-content-script',
      type: 'ELEMENT_PICKER_PAUSED',
    });
    const shadow = host.shadowRoot!;
    const card = shadow.querySelector<HTMLElement>('.card')!;
    expect(card.style.left).toBe('208px');
    expect(card.style.top).toBe('100px');
    expect(shadow.querySelector<HTMLElement>('.anchor')?.style.left).toBe('100px');

    const comment = shadow.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(comment.getAttribute('rows')).toBe('1');
    expect(card.dataset.expanded).toBe('false');
    shadow.querySelector<HTMLButtonElement>('.settings')!.click();
    expect(card.dataset.expanded).toBe('true');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 208,
      y: 100,
      left: 208,
      right: 524,
      top: 100,
      bottom: 500,
      width: 316,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const grip = shadow.querySelector<HTMLButtonElement>('.grip')!;
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        composed: true,
        clientX: 250,
        clientY: 120,
      }),
    );
    grip.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        composed: true,
        clientX: 300,
        clientY: 180,
      }),
    );
    grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    expect(card.style.left).toBe('258px');
    expect(card.style.top).toBe('160px');
    expect(shadow.querySelectorAll('.property-row')).toHaveLength(17);
    const fontSize = shadow.querySelector<HTMLInputElement>('input[data-property="fontSize"]')!;
    const padding = Array.from(
      shadow.querySelectorAll<HTMLInputElement>('input[data-property="padding"]'),
    );
    expect(comment.placeholder).toBe(commentLabels.placeholder);
    expect(fontSize.value).toBe('14');
    expect(fontSize.closest('.property-row')).toHaveTextContent('Font size');
    expect(fontSize.parentElement?.querySelector<HTMLSelectElement>('.unit-select')?.value).toBe(
      'px',
    );
    expect(padding.map(input => input.value)).toEqual(['8px', '12px', '8px', '12px']);
    expect(shadow.querySelector('select[data-property="fontWeight"]')).not.toBeNull();
    expect(shadow.querySelector('input[type="color"]')).not.toBeNull();
    comment.value = 'Make the primary action clearer';
    comment.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fontSize.value = '18';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(target.style.fontSize).toBe('18px');
    expect(target.style.getPropertyPriority('font-size')).toBe('important');
    const paddingValues = ['12px', '20px', '12px', '20px'];
    padding.forEach((input, index) => {
      input.value = paddingValues[index]!;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    expect(target.style.padding).toBe('12px 20px');
    const confirm = shadow.querySelector<HTMLButtonElement>('.footer-confirm')!;
    expect(confirm.disabled).toBe(false);
    const lineBreakEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    comment.dispatchEvent(lineBreakEvent);
    expect(lineBreakEvent.defaultPrevented).toBe(false);
    const saveEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    comment.dispatchEvent(saveEvent);
    expect(saveEvent.defaultPrevented).toBe(true);

    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'mearl-content-script',
          type: 'ELEMENT_COMMENT_CONFIRMED',
          comment: 'Make the primary action clearer',
          styleChanges: { fontSize: '18px', padding: '12px 20px' },
          element: expect.objectContaining({ selector: 'button#submit' }),
        }),
      ),
    );
    expect(document.getElementById('mearl-element-comment-editor')).toBeNull();
    expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      source: 'mearl-content-script',
      type: 'ELEMENT_PICKER_RESUMED',
    });
    expect(target.style.fontSize).toBe('18px');
    const firstConfirmation = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message)
      .find(message => (message as any)?.type === 'ELEMENT_COMMENT_CONFIRMED') as any;
    expect(firstConfirmation?.commentId).toEqual(expect.any(String));
    const marker = document.querySelector<HTMLElement>('[data-mearl-element-comment-marker]')!;
    expect(marker).not.toBeNull();
    marker.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click();

    const editHost = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).toBeTruthy();
      return current!;
    });
    const editShadow = editHost.shadowRoot!;
    const editedComment = editShadow.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(editedComment.value).toBe('Make the primary action clearer');
    editedComment.value = 'Make the primary action impossible to miss';
    editedComment.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    const editedFontSize = editShadow.querySelector<HTMLInputElement>(
      'input[data-property="fontSize"]',
    )!;
    editedFontSize.value = '20';
    editedFontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    editedFontSize.value = '18';
    editedFontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    const editedPadding = Array.from(
      editShadow.querySelectorAll<HTMLInputElement>('input[data-property="padding"]'),
    );
    editedPadding.forEach(input => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    editShadow.querySelector<HTMLButtonElement>('.composer-confirm')!.click();

    await vi.waitFor(() => {
      const confirmations = vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.map(([message]) => message as any)
        .filter(message => message?.type === 'ELEMENT_COMMENT_CONFIRMED');
      expect(confirmations).toHaveLength(2);
      expect(confirmations[1]).toEqual(
        expect.objectContaining({
          commentId: firstConfirmation?.commentId,
          comment: 'Make the primary action impossible to miss',
          styleChanges: { fontSize: '18px' },
        }),
      );
    });
    expect(target.style.padding).toBe('8px 12px');
    expect(document.querySelectorAll('[data-mearl-element-comment-marker]')).toHaveLength(1);
    picker.editElementComment(firstConfirmation.commentId);
    expect(document.getElementById('mearl-element-comment-editor')).not.toBeNull();
    const resumedBeforeRemoval = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.filter(([message]) => (message as any)?.type === 'ELEMENT_PICKER_RESUMED').length;
    picker.removeElementComment(firstConfirmation.commentId);
    expect(
      vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.filter(([message]) => (message as any)?.type === 'ELEMENT_PICKER_RESUMED'),
    ).toHaveLength(resumedBeforeRemoval + 1);
    expect(target.style.fontSize).toBe('14px');
    expect(target.style.getPropertyPriority('font-size')).toBe('');
    expect(target.style.padding).toBe('8px 12px');
    expect(document.querySelectorAll('[data-mearl-element-comment-marker]')).toHaveLength(0);
    expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    picker.stopElementPicker(false);
  });

  it('reuses a comment for the same element and restores its preview when clearing', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    target.style.fontSize = '14px';
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    const selectTarget = () =>
      document.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      );

    selectTarget();
    const firstEditor = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).toBeTruthy();
      return current!;
    });
    const firstShadow = firstEditor.shadowRoot!;
    firstShadow.querySelector<HTMLButtonElement>('.settings')!.click();
    const comment = firstShadow.querySelector<HTMLTextAreaElement>('textarea')!;
    comment.value = 'Increase the button size';
    comment.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    const fontSize = firstShadow.querySelector<HTMLInputElement>(
      'input[data-property="fontSize"]',
    )!;
    fontSize.value = '18';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    firstShadow.querySelector<HTMLButtonElement>('.footer-confirm')!.click();

    const firstConfirmation = await vi.waitFor(() => {
      const confirmation = vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.map(([message]) => message as any)
        .find(message => message?.type === 'ELEMENT_COMMENT_CONFIRMED');
      expect(confirmation).toBeTruthy();
      return confirmation!;
    });
    expect(target.style.fontSize).toBe('18px');
    expect(document.querySelectorAll('[data-mearl-element-comment-marker]')).toHaveLength(1);

    const pausedBeforeReselect = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.filter(([message]) => (message as any)?.type === 'ELEMENT_PICKER_PAUSED').length;
    selectTarget();
    expect(
      vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.filter(([message]) => (message as any)?.type === 'ELEMENT_PICKER_PAUSED'),
    ).toHaveLength(pausedBeforeReselect + 1);
    const secondEditor = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).toBeTruthy();
      expect(current).not.toBe(firstEditor);
      return current!;
    });
    const secondComment = secondEditor.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(secondComment.value).toBe('Increase the button size');
    secondComment.value = 'Increase the button size slightly';
    secondComment.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    secondEditor.shadowRoot!.querySelector<HTMLButtonElement>('.composer-confirm')!.click();

    await vi.waitFor(() => {
      const confirmations = vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.map(([message]) => message as any)
        .filter(message => message?.type === 'ELEMENT_COMMENT_CONFIRMED');
      expect(confirmations).toHaveLength(2);
      expect(confirmations[1]?.commentId).toBe(firstConfirmation.commentId);
    });
    expect(document.querySelectorAll('[data-mearl-element-comment-marker]')).toHaveLength(1);

    picker.clearElementComments();

    expect(target.style.fontSize).toBe('14px');
    expect(target.style.getPropertyPriority('font-size')).toBe('');
    expect(document.querySelectorAll('[data-mearl-element-comment-marker]')).toHaveLength(0);
    picker.stopElementPicker(false);
  });

  it('switches between confirmed comments from the chat pill and page markers', async () => {
    document.body.innerHTML =
      '<main><button id="primary">Primary</button><button id="secondary">Secondary</button></main>';
    const primary = document.querySelector('#primary') as HTMLButtonElement;
    const secondary = document.querySelector('#secondary') as HTMLButtonElement;
    let pointTarget: Element = primary;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => pointTarget),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });

    const addComment = async (target: Element, value: string) => {
      pointTarget = target;
      document.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      );
      const editor = await vi.waitFor(() => {
        const current = document.getElementById('mearl-element-comment-editor');
        expect(current).toBeTruthy();
        return current!;
      });
      const textarea = editor.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = value;
      textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      await vi.waitFor(() => expect(editor.isConnected).toBe(false));
    };

    await addComment(primary, 'First annotation');
    await addComment(secondary, 'Second annotation');
    const confirmations = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message as any)
      .filter(message => message?.type === 'ELEMENT_COMMENT_CONFIRMED');
    const firstId = confirmations[0]?.commentId as string;
    const secondId = confirmations[1]?.commentId as string;

    picker.editElementComment(firstId);
    const firstEditor = document.getElementById('mearl-element-comment-editor')!;
    expect(firstEditor.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'First annotation',
    );
    firstEditor.shadowRoot!.querySelector<HTMLButtonElement>('.settings')!.click();
    const fontSize = firstEditor.shadowRoot!.querySelector<HTMLInputElement>(
      'input[data-property="fontSize"]',
    )!;
    fontSize.value = '24';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(primary.style.fontSize).toBe('24px');

    picker.editElementComment(secondId);
    const secondEditor = document.getElementById('mearl-element-comment-editor')!;
    expect(secondEditor).not.toBe(firstEditor);
    expect(secondEditor.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'Second annotation',
    );
    expect(primary.style.fontSize).toBe('');
    expect(
      document.querySelector(`[data-mearl-element-comment-marker="${firstId}"]`),
    ).not.toBeNull();
    secondEditor.shadowRoot!.querySelector<HTMLButtonElement>('.settings')!.click();

    const firstMarker = document.querySelector<HTMLElement>(
      `[data-mearl-element-comment-marker="${firstId}"]`,
    )!;
    const markerButton = firstMarker.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
    markerButton.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    markerButton.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
    );

    await vi.waitFor(() => {
      const switchedEditor = document.getElementById('mearl-element-comment-editor');
      expect(
        switchedEditor?.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea')?.value,
      ).toBe('First annotation');
    });
    picker.stopElementPicker(false);
  });

  it('drops a collapsed selection when a pointer gesture starts elsewhere on the page', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    );

    const host = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor');
      expect(current).toBeTruthy();
      return current!;
    });
    const settings = host.shadowRoot!.querySelector<HTMLButtonElement>('.settings')!;
    settings.click();
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: 300,
        clientY: 300,
      }),
    );
    expect(host.isConnected).toBe(true);
    document.body.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: 300,
        clientY: 300,
      }),
    );
    settings.click();
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: 300,
        clientY: 300,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: 300,
        clientY: 300,
      }),
    );

    await vi.waitFor(() => {
      expect(host.isConnected).toBe(false);
      expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ELEMENT_PICK_CANCELLED' }),
    );
    picker.stopElementPicker(false);
  });

  it('restores the original inline styles when the live preview is canceled', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    target.style.fontSize = '14px';
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    );

    const shadow = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor')?.shadowRoot;
      expect(current).toBeTruthy();
      return current!;
    });
    shadow.querySelector<HTMLButtonElement>('.settings')!.click();
    const fontSize = shadow.querySelector<HTMLInputElement>('input[data-property="fontSize"]')!;
    fontSize.value = '20';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(target.style.fontSize).toBe('20px');

    fontSize.value = '14';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(target.style.fontSize).toBe('14px');
    expect(shadow.querySelector<HTMLButtonElement>('.footer-confirm')?.disabled).toBe(true);

    fontSize.value = '20';
    fontSize.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    shadow.querySelector<HTMLButtonElement>('.cancel')!.click();

    expect(target.style.fontSize).toBe('14px');
    expect(target.style.getPropertyPriority('font-size')).toBe('');
    expect(document.getElementById('mearl-element-comment-editor')).toBeNull();
    expect(document.getElementById('mearl-pick-highlight')).not.toBeNull();
    picker.stopElementPicker(false);
  });

  it('previews the element text edit and restores the original text when removed', async () => {
    const target = document.querySelector('#submit') as HTMLButtonElement;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
    );

    const shadow = await vi.waitFor(() => {
      const current = document.getElementById('mearl-element-comment-editor')?.shadowRoot;
      expect(current).toBeTruthy();
      return current!;
    });
    shadow.querySelector<HTMLButtonElement>('.settings')!.click();
    const text = shadow.querySelector<HTMLInputElement>('input[data-property="textContent"]')!;
    expect(text.value).toBe('Submit order');
    expect(text.closest('.property-row')).toHaveTextContent('Text content');
    text.value = 'Place order';
    text.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(target.textContent).toBe('Place order');

    text.value = 'Submit order';
    text.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(target.textContent).toBe('Submit order');
    expect(shadow.querySelector<HTMLButtonElement>('.footer-confirm')?.disabled).toBe(true);

    text.value = 'Place order';
    text.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    shadow.querySelector<HTMLButtonElement>('.footer-confirm')!.click();

    const confirmation = await vi.waitFor(() => {
      const message = vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.map(([msg]) => msg as any)
        .find(msg => msg?.type === 'ELEMENT_COMMENT_CONFIRMED');
      expect(message).toBeTruthy();
      return message!;
    });
    expect(confirmation.styleChanges).toEqual({ textContent: 'Place order' });
    expect(target.textContent).toBe('Place order');

    picker.removeElementComment(confirmation.commentId);
    expect(target.textContent).toBe('Submit order');
    picker.stopElementPicker(false);
  });

  it('keeps the editor floating near the element in a narrow emulated viewport', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const target = document.querySelector('#submit') as HTMLButtonElement;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 300,
      y: 760,
      left: 300,
      right: 380,
      top: 760,
      bottom: 800,
      width: 80,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    const picker = createElementPicker();
    picker.startElementPicker({ commentMode: true, commentLabels });
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 340, clientY: 780 }),
    );

    await vi.waitFor(() =>
      expect(
        document
          .getElementById('mearl-element-comment-editor')
          ?.shadowRoot?.querySelector<HTMLElement>('.card'),
      ).toBeTruthy(),
    );
    const card = document
      .getElementById('mearl-element-comment-editor')!
      .shadowRoot!.querySelector<HTMLElement>('.card')!;
    expect(card.dataset.layout).toBeUndefined();
    expect(card.style.width).toBe('316px');
    expect(card.style.left).toBe('66px');
    expect(card.style.top).toBe('702px');
    picker.stopElementPicker(false);
  });
});
