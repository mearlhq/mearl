import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ElementPickerSelection } from '../../../content-script/elementCommentTypes';
import { SpmElementDetail } from '../SpmElementDetail';

it('shows DOM tracking configuration without requiring a captured event', () => {
  const selection = {
    text: 'Rate comment',
    spm: 'comment.comment_rate',
    page: { url: 'https://example.test/order', title: 'Order' },
    element: {
      tagName: 'button',
      id: 'comment-rate',
      selector: 'button#comment-rate',
      xpath: '/html/body/button',
      attributes: {
        'data-spm-click': 'locaid=comment_rate',
        'aria-label': 'Rate comment',
      },
      outerHTML:
        '<button id="comment-rate" data-spm-click="locaid=comment_rate">Rate comment</button>',
    },
  } as unknown as ElementPickerSelection;

  const { container } = render(<SpmElementDetail selection={selection} />);

  expect(container).toHaveTextContent('comment.comment_rate');
  expect(container).toHaveTextContent('locaid=comment_rate');
  expect(container).toHaveTextContent('Rate comment');
  expect(container).toHaveTextContent('button#comment-rate');
});
