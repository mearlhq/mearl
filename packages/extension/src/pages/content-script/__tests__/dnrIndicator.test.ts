import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDnrIndicatorManager, type DnrIndicatorMode } from '../dnrIndicator';

describe('DNR indicator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reconciles rules that arrive before the stored display mode', () => {
    let resolveMode: ((mode: DnrIndicatorMode) => void) | undefined;
    const indicator = createDnrIndicatorManager({
      getIndicatorMode: callback => {
        resolveMode = callback;
      },
      sendMessage: vi.fn(),
      getMessage: key => key,
    });

    indicator.updateDnrIndicator([{ label: 'User-Agent Override' }]);
    expect(document.body.children).toHaveLength(1);

    resolveMode?.('off');
    expect(document.body.children).toHaveLength(0);
  });

  it('sends the matching quick-disable action for settings overrides and DNR rules', () => {
    const sendMessage = vi.fn();
    const indicator = createDnrIndicatorManager({
      getIndicatorMode: callback => callback('number'),
      sendMessage,
      getMessage: key => key,
    });

    indicator.updateDnrIndicator([
      {
        label: 'User-Agent Override',
        canDisable: true,
        disableTarget: 'userAgent',
      },
      { label: 'Redirect', canDisable: true, ruleId: 42 },
    ]);

    const buttons = document.body.children[0].shadowRoot!.querySelectorAll('.disable-btn');
    expect(buttons).toHaveLength(2);

    (buttons[0] as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      action: 'disableDnrOverride',
      override: 'userAgent',
    });

    (buttons[1] as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      action: 'disableDnrRule',
      ruleId: 42,
    });
  });
});
