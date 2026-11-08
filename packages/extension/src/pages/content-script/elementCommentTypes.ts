import type { ElementInfo } from './injected/collectElement';

export const ELEMENT_COMMENT_STYLE_PROPERTIES = [
  'color',
  'backgroundColor',
  'opacity',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'borderRadius',
  'borderColor',
  'borderWidth',
  'width',
  'height',
  'padding',
  'margin',
] as const;

export type ElementCommentStyleProperty = (typeof ELEMENT_COMMENT_STYLE_PROPERTIES)[number];
// 评论弹窗中可编辑的属性：CSS 样式之外还支持改写元素文本内容
export type ElementCommentChangeProperty = ElementCommentStyleProperty | 'textContent';
export type ElementCommentStyleChanges = Partial<Record<ElementCommentChangeProperty, string>>;

export interface ElementPickerPage {
  url: string;
  title: string;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface ElementPickerSelection {
  text: string;
  element: ElementInfo | null;
  page: ElementPickerPage;
  frame?: {
    url: string;
    title: string;
    viewport: {
      width: number;
      height: number;
    };
  };
}

export interface ElementCommentLabels {
  title: string;
  placeholder: string;
  edit: string;
  move: string;
  skip: string;
  add: string;
  styleChanges: string;
  valuePlaceholder: string;
  styleProperties: Record<ElementCommentChangeProperty, string>;
}

export interface ElementPickerOptions {
  traceMode?: boolean;
  commentMode?: boolean;
  continuousCommentMode?: boolean;
  commentLabels?: ElementCommentLabels;
  topPage?: ElementPickerPage;
}
