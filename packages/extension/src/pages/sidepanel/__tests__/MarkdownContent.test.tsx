import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../components/MarkdownContent';
import { parseChatVisualization } from '../components/ChatVisualization';

describe('MarkdownContent', () => {
  it('recognizes a complete visualization block between paragraphs', () => {
    const reference = '\uE200visualize\uE202{"path":"/output/chart.html","title":"Sales"}\uE201';
    expect(parseChatVisualization(reference)).toEqual({
      path: '/output/chart.html',
      title: 'Sales',
    });
    expect(parseChatVisualization(reference.slice(0, -1))).toBeNull();

    const { container } = render(
      <MarkdownContent visualizations>{`Before\n${reference}\nAfter`}</MarkdownContent>,
    );
    expect(container.querySelector('[data-chat-visualization]')).toBeInTheDocument();
    expect(container.querySelectorAll('p')[0]).toHaveTextContent('Before');
    expect(container.querySelectorAll('p')[2]).toHaveTextContent('After');
  });

  it('leaves visualization examples in code and regular Markdown as text', () => {
    const reference = '\uE200visualize\uE202{"path":"/output/chart.html"}\uE201';
    const { container, rerender } = render(<MarkdownContent>{reference}</MarkdownContent>);
    expect(container.querySelector('[data-chat-visualization]')).toBeNull();
    rerender(<MarkdownContent visualizations>{`\`\`\`\n${reference}\n\`\`\``}</MarkdownContent>);
    expect(container.querySelector('code')).toHaveTextContent(reference);
    expect(container.querySelector('[data-chat-visualization]')).toBeNull();
  });

  it('renders common Markdown blocks and inline formatting without raw HTML', () => {
    const { container } = render(
      <MarkdownContent>
        {`## Summary

**Bold** and \`inline\`

> quoted

1. first
2. second

[Open](https://example.com)

\`\`\`ts
const ready = true;
\`\`\`

snake_case_value

<script>alert('no')</script>`}
      </MarkdownContent>,
    );

    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText('inline').tagName).toBe('CODE');
    expect(screen.getByText('quoted').tagName).toBe('BLOCKQUOTE');
    expect(screen.getByRole('list')).toHaveTextContent('firstsecond');
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    const highlightedCode = container.querySelector('code.language-typescript');
    expect(highlightedCode).toHaveTextContent('const ready = true;');
    expect(highlightedCode?.querySelector('.token.keyword')).toHaveTextContent('const');
    expect(highlightedCode?.querySelector('.token.boolean')).toHaveTextContent('true');
    expect(screen.getByText('snake_case_value').tagName).toBe('P');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container).toHaveTextContent("<script>alert('no')</script>");
  });

  it('leaves unsafe Markdown links as text', () => {
    render(<MarkdownContent>{'[Unsafe](javascript:alert(1))'}</MarkdownContent>);

    expect(screen.queryByRole('link', { name: 'Unsafe' })).not.toBeInTheDocument();
    expect(screen.getByText('[Unsafe](javascript:alert(1))')).toBeInTheDocument();
  });

  it('keeps unknown fenced languages as plain escaped text', () => {
    const { container } = render(
      <MarkdownContent>{'```unknown\n<script>alert("no")</script>\n```'}</MarkdownContent>,
    );

    const code = container.querySelector('code');
    expect(code).toHaveTextContent('<script>alert("no")</script>');
    expect(code?.querySelector('.token')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders GFM-style tables', () => {
    render(
      <MarkdownContent>
        {`| Name | Description | Value |
| :--- | :---: | ---: |
| **Worker** | Escaped \\| pipe | 12 |
| Agent | \`a|b\` | 7 |
| Extra | columns | are | retained |

| not a table | still text |
| -- | invalid |`}
      </MarkdownContent>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(3);
    expect(screen.getByText('Worker').tagName).toBe('STRONG');
    expect(screen.getByText('Escaped | pipe')).toBeInTheDocument();
    expect(screen.getByText('a|b').tagName).toBe('CODE');
    expect(screen.getByText('are | retained')).toBeInTheDocument();
    expect(screen.getByText(/not a table/).closest('p')).toHaveTextContent(
      '| not a table | still text |',
    );
  });
});
