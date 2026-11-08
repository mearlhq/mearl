import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JsonTree } from '../JsonTree';

describe.each([
  { label: '根节点', path: [] as string[] },
  { label: '嵌套节点', path: ['payload'] },
])('JsonTree $label 前缀写回', ({ path }) => {
  const wrap = (value: string) => (path.length ? { payload: value } : value);

  it('字段重命名保留所在对象的前缀', () => {
    const onValueChange = vi.fn();
    render(
      <JsonTree
        data={wrap('callback{"count":1}')}
        editable
        onValueChange={onValueChange}
        expandedPaths={{ '': true, payload: true }}
        onToggleExpand={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByTitle('renameKey').at(-1)!);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'total' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onValueChange).toHaveBeenCalledWith(path, 'callback{"total":1}');
  });

  it('数组插入保留数组字符串的前缀', () => {
    const onValueChange = vi.fn();
    render(<JsonTree data={wrap('callback[1,2]')} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTitle('addElement'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'number' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '3' } });
    fireEvent.click(screen.getByTitle('confirm'));

    expect(onValueChange).toHaveBeenCalledWith(path, 'callback[1,2,3]');
  });

  it('整块弹窗编辑保留当前节点的前缀', async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <JsonTree data={wrap('callback{"count":1}')} editable onValueChange={onValueChange} />,
    );

    fireEvent.contextMenu(container.querySelector(`[data-json-path="${path.join('.')}"]`)!);
    fireEvent.click(screen.getByText('editInModal'));
    const editor = await screen.findByRole('textbox');
    fireEvent.change(editor, { target: { value: '{"count":2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(onValueChange).toHaveBeenCalledWith(path, 'callback{"count":2}');
  });
});
