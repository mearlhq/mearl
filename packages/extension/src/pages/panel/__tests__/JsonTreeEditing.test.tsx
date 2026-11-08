import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonTree } from '../components/json-tree/JsonTree';

afterEach(() => {
  document.querySelector('[data-json-color-picker]')?.remove();
});

describe('JsonTree 字段编辑', () => {
  it('十六进制色值前应展示颜色预览', () => {
    const { container } = render(
      <JsonTree data={{ full: '#919499', short: '#abc', alpha: '#10203080', label: 'plain' }} />,
    );

    expect(container.querySelector('[data-json-color-preview="#919499"]')).toHaveStyle({
      backgroundColor: '#919499',
    });
    expect(container.querySelector('[data-json-color-preview="#abc"]')).toHaveStyle({
      backgroundColor: '#abc',
    });
    expect(container.querySelector('[data-json-color-preview="#10203080"]')).toHaveStyle({
      backgroundColor: '#10203080',
    });
    expect(container.querySelectorAll('[data-json-color-preview]')).toHaveLength(3);
  });

  it('色块按需打开取色器并直接保存，色值文字仍可编辑', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ color: '#919499' }} editable onValueChange={onValueChange} />);

    const colorSwatch = screen.getByRole('button', { name: 'selectColor' });
    expect(document.querySelector('[data-json-color-picker]')).not.toBeInTheDocument();
    vi.spyOn(colorSwatch, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 136,
      bottom: 96,
      width: 16,
      height: 16,
      toJSON: () => ({}),
    });
    const pickerLayout = vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect');
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click');

    fireEvent.click(colorSwatch);
    const colorPicker = document.querySelector<HTMLInputElement>('[data-json-color-picker]')!;
    expect(colorPicker).toHaveValue('#919499');
    expect(colorPicker).toHaveStyle({
      left: '120px',
      top: '80px',
      width: '16px',
      height: '16px',
    });
    expect(pickerLayout).toHaveBeenCalledOnce();
    expect(pickerLayout.mock.invocationCallOrder[0]).toBeLessThan(
      pickerClick.mock.invocationCallOrder[0],
    );

    fireEvent.change(colorPicker, { target: { value: '#ff6600' } });
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(['color'], '#ff6600');
    expect(colorPicker).toBeInTheDocument();

    fireEvent.click(colorSwatch);
    expect(pickerClick).toHaveBeenCalledTimes(2);
    expect(pickerLayout).toHaveBeenCalledTimes(2);
    pickerLayout.mockRestore();
    pickerClick.mockRestore();

    fireEvent.click(screen.getByText('"#919499"'));
    expect(screen.getByRole('textbox')).toHaveValue('#919499');
  });

  it('带透明度的色值通过取色器修改时应保留透明度', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ color: '#1234' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'selectColor' }));
    const colorPicker = document.querySelector<HTMLInputElement>('[data-json-color-picker]')!;

    expect(colorPicker).toHaveValue('#112233');
    fireEvent.change(colorPicker, { target: { value: '#abcdef' } });

    expect(onValueChange).toHaveBeenCalledWith(['color'], '#abcdef44');
  });

  it('可编辑图片链接按住 Command 点击时应打开预览', () => {
    const imageUrl = '//example.com/preview.png';

    render(<JsonTree data={{ image: imageUrl }} editable onValueChange={vi.fn()} />);

    fireEvent.click(screen.getByTitle('commandClickToViewImage'), { metaKey: true });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('imagePreview')).toBeInTheDocument();
    expect(screen.getByAltText('Preview')).toHaveAttribute(
      'src',
      'https://example.com/preview.png',
    );
  });

  it('可编辑图片链接普通点击时应进入文本编辑', () => {
    const imageUrl = 'https://example.com/preview.png';

    render(<JsonTree data={{ image: imageUrl }} editable onValueChange={vi.fn()} />);

    fireEvent.click(screen.getByTitle('commandClickToViewImage'));

    expect(screen.getByRole('textbox')).toHaveValue(imageUrl);
    expect(screen.queryByText('imagePreview')).not.toBeInTheDocument();
  });

  it('图片预览中的右键保留浏览器默认行为，不触发 JSON 字段菜单', () => {
    render(
      <JsonTree
        data={{ image: 'https://example.com/preview.png' }}
        editable
        onValueChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('commandClickToViewImage'), { metaKey: true });
    const image = screen.getByAltText('Preview');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(image, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('copyValue')).not.toBeInTheDocument();
    expect(screen.queryByText('copyPath')).not.toBeInTheDocument();
  });

  it('字段值失焦时应确认编辑', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('"old"'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'new' } });
    fireEvent.blur(editor);

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(['keyword'], 'new');
  });

  it('字段值没有变化时失焦不应触发保存', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('"old"'));
    fireEvent.blur(screen.getByRole('textbox'));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('字段值解析后没有变化时失焦不应触发保存', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ count: 1 }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('1'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: '1.0' } });
    fireEvent.blur(editor);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('Escape 应取消编辑而不保存', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('"old"'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'new' } });
    act(() => {
      fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape' });
      fireEvent.blur(editor);
    });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('"old"')).toBeInTheDocument();
  });

  it('字段名编辑时 Escape 应取消而不保存', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTitle('renameKey'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'term' } });
    act(() => {
      fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape' });
      fireEvent.blur(editor);
    });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('keyword:')).toBeInTheDocument();
  });

  it('非法字段值失焦时应放弃编辑', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ count: 1 }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('1'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'invalid' } });
    fireEvent.blur(editor);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('字段名失焦时应确认重命名', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTitle('renameKey'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'term' } });
    fireEvent.blur(editor);

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith([], { term: 'old' });
  });

  it('字段名重复时不应覆盖已有字段', () => {
    const onValueChange = vi.fn();

    render(
      <JsonTree
        data={{ keyword: 'old', existing: 'value' }}
        editable
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getAllByTitle('renameKey')[0]);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'existing' } });
    fireEvent.blur(editor);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('输入法候选词确认的 Enter 不应保存字段', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByText('"old"'));

    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'ws' } });
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue('ws');

    act(() => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
      fireEvent.blur(editor);
    });

    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(['keyword'], 'ws');
  });

  it('query 场景在 key 中粘贴 key=value 应分别填充并保留 value 中的等号', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data="existing=1&more=2" editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTitle('addProperty'));
    const keyInput = screen.getByPlaceholderText('key');
    fireEvent.paste(keyInput, {
      clipboardData: { getData: () => 'defaultTab=travelPlan=detail' },
    });

    expect(keyInput).toHaveValue('defaultTab');
    expect(screen.getByPlaceholderText('value')).toHaveValue('travelPlan=detail');

    fireEvent.click(screen.getByTitle('confirm'));
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(['defaultTab'], 'travelPlan=detail');
  });

  it('普通对象在 key 中粘贴 key=value 不应拆分（仅 query 生效）', () => {
    const onValueChange = vi.fn();

    render(<JsonTree data={{}} editable onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTitle('addProperty'));
    const keyInput = screen.getByPlaceholderText('key');
    fireEvent.paste(keyInput, {
      clipboardData: { getData: () => 'defaultTab=travelPlan' },
    });

    expect(keyInput).toHaveValue('');
    expect(screen.getByPlaceholderText('value')).toHaveValue('');
  });

  it('新增和编辑开始、结束时应上报统一交互状态', () => {
    const onInteractionChange = vi.fn();

    render(
      <JsonTree
        data={{ keyword: 'old' }}
        editable
        onValueChange={vi.fn()}
        onInteractionChange={onInteractionChange}
      />,
    );

    fireEvent.click(screen.getByTitle('addProperty'));
    expect(onInteractionChange).toHaveBeenLastCalledWith({ type: 'add', path: [] });

    fireEvent.click(screen.getByTitle('cancel'));
    expect(onInteractionChange).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByText('"old"'));
    expect(onInteractionChange).toHaveBeenLastCalledWith({
      type: 'edit',
      path: ['keyword'],
    });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', code: 'Escape' });
    expect(onInteractionChange).toHaveBeenLastCalledWith(null);
  });

  it('开始编辑时应关闭已打开的新增表单', () => {
    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={vi.fn()} />);

    fireEvent.click(screen.getByTitle('addProperty'));
    expect(screen.getByPlaceholderText('key')).toBeInTheDocument();

    fireEvent.click(screen.getByText('"old"'));

    expect(screen.queryByPlaceholderText('key')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('old');
  });

  it('开始新增时应关闭正在编辑的字段', () => {
    render(<JsonTree data={{ keyword: 'old' }} editable onValueChange={vi.fn()} />);

    fireEvent.click(screen.getByText('"old"'));
    expect(screen.getByRole('textbox')).toHaveValue('old');

    fireEvent.click(screen.getByTitle('addProperty'));

    expect(screen.queryByDisplayValue('old')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('key')).toBeInTheDocument();
  });
});
