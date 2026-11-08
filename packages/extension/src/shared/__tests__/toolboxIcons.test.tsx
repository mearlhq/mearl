import { fireEvent, render } from '@testing-library/react';
import { Wrench } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ToolboxIcon } from '../toolboxIcons';

describe('ToolboxIcon', () => {
  it('renders built-in components, names and an unknown-name fallback', () => {
    const { container, rerender } = render(<ToolboxIcon icon="wrench" className="w-4 h-4" />);
    expect(container.querySelector('svg')).toHaveClass('lucide-wrench', 'w-4', 'h-4');
    rerender(<ToolboxIcon icon={Wrench} />);
    expect(container.querySelector('svg')).toHaveClass('lucide-wrench');
    rerender(<ToolboxIcon icon="unlisted" />);
    expect(container.querySelector('svg')).toHaveClass('lucide-blocks');
  });
  it('renders SVG as image data without inserting its markup into the extension', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path fill="blue"/></svg>';
    const { container } = render(<ToolboxIcon icon={svg} className="w-4 h-4" />);
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', `data:image/svg+xml,${encodeURIComponent(svg)}`);
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg, script, [onload]')).toBeNull();
  });
  it('falls back after an image failure and loads a replacement URL', () => {
    const { container, rerender } = render(<ToolboxIcon icon="https://example.com/broken.png" />);
    expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveClass('lucide-blocks');
    rerender(<ToolboxIcon icon="https://example.com/new.svg" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/new.svg');
  });
  it('renders currentColor SVGs as masks inheriting the surrounding theme and interaction color', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor"><path d="M1 1h5"/></svg>';
    const { container } = render(<ToolboxIcon icon={svg} className="h-4 w-4" />);
    const mask = container.querySelector('span')!;
    expect(mask).toHaveClass('bg-current', 'h-4', 'w-4');
    expect(mask.style.maskImage).toContain('data:image/svg+xml,');
    expect(mask.style.maskSize).toBe('contain');
    expect(container.querySelector('img')).toHaveClass('hidden');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('svg')).toHaveClass('lucide-blocks');
  });
  it('uses the fallback for unsafe and malformed image sources', () => {
    const { container } = render(<ToolboxIcon icon="javascript:alert(1)" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveClass('lucide-blocks');
  });
});
