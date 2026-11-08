import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConversationMessage } from '../components/ConversationMessage';

describe('ConversationMessage', () => {
  it('renders reasoning summary Markdown without exposing its source markers', () => {
    const { container } = render(
      <ConversationMessage
        message={{
          role: 'thinking',
          message: '💭 ## Analysis\n\n- **Inspect** the code\n- Run `pnpm test`',
          timestamp: 1,
        }}
        providerName="Codex"
      />,
    );

    const thinking = container.querySelector('[data-role="thinking"]');
    expect(thinking).not.toBeNull();
    expect(
      within(thinking as HTMLElement).getByRole('heading', { name: 'Analysis' }),
    ).toBeVisible();
    expect(within(thinking as HTMLElement).getByText('Inspect').tagName).toBe('STRONG');
    expect(within(thinking as HTMLElement).getByText('pnpm test').tagName).toBe('CODE');
    expect(thinking).not.toHaveTextContent('##');
    expect(thinking).not.toHaveTextContent('**Inspect**');
    expect(screen.getByText('💭')).toHaveAttribute('aria-hidden', 'true');
  });
});
