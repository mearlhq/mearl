import {
  ELEMENT_COMMENT_STYLE_PROPERTIES,
  type ElementCommentChangeProperty,
  type ElementCommentLabels,
  type ElementCommentStyleChanges,
  type ElementCommentStyleProperty,
  type ElementPickerSelection,
} from './elementCommentTypes';
import { canEditElementText, readElementText, writeElementText } from './elementCommentText';
import { isElementCommentMarker } from './elementCommentMarker';

interface ElementCommentOverlayOptions {
  target: Element;
  selection: ElementPickerSelection;
  labels: ElementCommentLabels;
  initialComment?: string;
  initialStyleChanges?: ElementCommentStyleChanges;
  onCancel: () => void;
  onConfirm: (comment: string, styleChanges: ElementCommentStyleChanges) => void;
  onSkip: () => void;
}

export interface ElementCommentOverlay {
  destroy: () => void;
}

interface ViewportBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

const HOST_ID = 'mearl-element-comment-editor';
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const CARD_WIDTH = 316;
const COLLAPSED_FALLBACK_HEIGHT = 50;
const EXPANDED_FALLBACK_HEIGHT = 448;
const GROUP_START_PROPERTIES = new Set<ElementCommentStyleProperty>([
  // 文本内容行固定在面板顶部，color 作为首个样式属性需要分隔线
  'color',
  'fontFamily',
  'borderRadius',
  'width',
  'padding',
]);
const UNIT_PROPERTIES = new Set<ElementCommentStyleProperty>([
  'fontSize',
  'letterSpacing',
  'borderRadius',
  'borderWidth',
  'width',
  'height',
]);
const SELECT_PROPERTY_VALUES: Partial<Record<ElementCommentStyleProperty, string[]>> = {
  fontFamily: [
    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'Arial, sans-serif',
    'Georgia, serif',
    'ui-monospace, SFMono-Regular, Menlo, monospace',
  ],
  fontWeight: ['normal', '100', '200', '300', '400', '500', '600', '700', '800', '900', 'bold'],
  textAlign: ['start', 'left', 'center', 'right', 'justify'],
};

function viewportBounds(): ViewportBounds {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function elementLabel(selection: ElementPickerSelection): string {
  return (
    selection.element?.selector ||
    selection.element?.tagName ||
    selection.text ||
    selection.page.title ||
    selection.page.url
  );
}

function cssPropertyName(property: ElementCommentStyleProperty): string {
  return property.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
}

function expandBoxValue(value: string): [string, string, string, string] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ['', '', '', ''];
  if (parts.length === 1) return [parts[0]!, parts[0]!, parts[0]!, parts[0]!];
  if (parts.length === 2) return [parts[0]!, parts[1]!, parts[0]!, parts[1]!];
  if (parts.length === 3) return [parts[0]!, parts[1]!, parts[2]!, parts[1]!];
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

function compactBoxValue(values: string[]): string {
  const [top, right, bottom, left] = values.map(value => value.trim());
  if (!top || !right || !bottom || !left) return values.map(value => value.trim()).join(' ');
  if (top === right && top === bottom && top === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

function button(className: string, label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.title = label;
  element.setAttribute('aria-label', label);
  return element;
}

function svgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const data of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

function slidersIcon(): SVGSVGElement {
  return svgIcon([
    'M4 7h3m4 0h9M7 7a2 2 0 1 0 4 0 2 2 0 1 0-4 0Z',
    'M4 17h9m4 0h3m-7 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0Z',
  ]);
}

function checkIcon(): SVGSVGElement {
  return svgIcon(['m5 12 4 4L19 6']);
}

function colorToHex(value: string): string | null {
  const trimmed = value.trim();
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(trimmed);
  if (shortHex) {
    return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`;
  }
  const hex = /^#[\da-f]{6}$/i.exec(trimmed);
  if (hex) return hex[0];
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(
    trimmed,
  );
  if (!rgb) return null;
  return `#${rgb
    .slice(1, 4)
    .map(channel =>
      clamp(Math.round(Number(channel)), 0, 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function showElementCommentOverlay({
  target,
  selection,
  labels,
  initialComment = '',
  initialStyleChanges = {},
  onCancel,
  onConfirm,
  onSkip,
}: ElementCommentOverlayOptions): ElementCommentOverlay {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
    'pointer-events: none',
    'width: 100vw',
    'height: 100vh',
  ].join(';');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host {
      color-scheme: light;
      --panel-bg: #f8f9fa;
      --panel-bg-strong: #ffffff;
      --panel-toolbar: #f3f3f3;
      --panel-hover: #f0f1f3;
      --panel-border: #e1e4e8;
      --panel-text: #2c2c2c;
      --panel-text-secondary: #6e6e6e;
      --panel-accent: #2a57c9;
      --panel-accent-soft: rgba(42, 87, 201, 0.1);
      --panel-scrollbar: #d1d5db;
      --panel-shadow: rgba(15, 23, 42, 0.2);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        color-scheme: dark;
        --panel-bg: #1a1a1a;
        --panel-bg-strong: #0f0f0f;
        --panel-toolbar: #1f1f1f;
        --panel-hover: #262626;
        --panel-border: #30363d;
        --panel-text: #e4e4e7;
        --panel-text-secondary: #a1a1aa;
        --panel-accent: #58a6ff;
        --panel-accent-soft: rgba(88, 166, 255, 0.12);
        --panel-scrollbar: #3b3b3b;
        --panel-shadow: rgba(0, 0, 0, 0.4);
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    button, textarea, input { font: inherit; }
    .anchor {
      position: absolute;
      pointer-events: none;
      border: 2px solid var(--panel-accent);
      border-radius: 4px;
      background: var(--panel-accent-soft);
      box-shadow: 0 0 0 1px var(--panel-bg-strong);
    }
    .card {
      position: absolute;
      display: flex;
      flex-direction: column;
      width: ${CARD_WIDTH}px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      overflow: hidden;
      border: 1px solid var(--panel-border);
      border-radius: 24px;
      background: var(--panel-bg);
      color: var(--panel-text);
      box-shadow: 0 12px 32px var(--panel-shadow), 0 2px 6px rgba(0, 0, 0, 0.12);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.4;
      pointer-events: auto;
      transition: border-radius 140ms ease, box-shadow 140ms ease;
    }
    .card[data-expanded="true"] {
      border-radius: 16px;
      box-shadow: 0 14px 38px var(--panel-shadow), 0 2px 8px rgba(0, 0, 0, 0.14);
    }
    .composer {
      display: flex;
      flex: none;
      align-items: center;
      min-height: 48px;
      gap: 5px;
      padding: 6px 7px;
    }
    .icon-button {
      display: grid;
      flex: none;
      width: 34px;
      height: 34px;
      place-items: center;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--panel-text-secondary);
      cursor: pointer;
      outline: none;
    }
    .icon-button:hover, .icon-button:focus-visible { background: var(--panel-hover); color: var(--panel-text); }
    .settings[aria-expanded="true"] { background: var(--panel-accent-soft); color: var(--panel-accent); }
    .icon-button svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.8;
    }
    .comment {
      display: block;
      flex: 1;
      width: 100%;
      min-width: 0;
      height: 28px;
      min-height: 28px;
      max-height: 76px;
      overflow: hidden;
      resize: none;
      border: 0;
      outline: 0;
      padding: 4px 0;
      background: transparent;
      color: var(--panel-text);
      font-size: 13px;
      line-height: 20px;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .comment::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .comment::placeholder { color: var(--panel-text-secondary); opacity: 0.7; }
    .composer-confirm {
      background: #2563eb;
      color: #ffffff;
    }
    .composer-confirm:hover, .composer-confirm:focus-visible { background: #1d4ed8; color: #ffffff; }
    .card[data-expanded="true"] .composer-confirm { display: none; }
    .icon-button:disabled {
      background: var(--panel-hover);
      color: var(--panel-text-secondary);
      opacity: 0.48;
      cursor: default;
    }
    .expanded-content { display: none; min-height: 0; flex-direction: column; }
    .card[data-expanded="true"] .expanded-content { display: flex; }
    .element-bar {
      display: flex;
      flex: none;
      align-items: center;
      min-height: 34px;
      padding: 0 13px;
      border-top: 1px solid var(--panel-border);
      border-bottom: 1px solid var(--panel-border);
      background: var(--panel-toolbar);
    }
    .element-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: var(--panel-text);
      font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .grip {
      display: grid;
      grid-template-columns: repeat(2, 3px);
      gap: 3px;
      border: 0;
      border-radius: 5px;
      padding: 4px;
      background: transparent;
      cursor: grab;
      opacity: 0.62;
      touch-action: none;
    }
    .grip:hover, .grip:focus-visible { background: var(--panel-hover); opacity: 1; outline: 0; }
    .grip:active, .card[data-dragging="true"] .grip { cursor: grabbing; }
    .grip i { width: 3px; height: 3px; border-radius: 50%; background: var(--panel-text-secondary); }
    .property-panel {
      min-height: 0;
      max-height: min(340px, calc(100vh - 154px));
      overflow: auto;
      overscroll-behavior: contain;
      padding: 5px 10px 7px;
      scrollbar-color: var(--panel-scrollbar) transparent;
      scrollbar-width: thin;
    }
    .property-row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      align-items: center;
      min-height: 35px;
      gap: 6px;
    }
    .property-row.group-start {
      margin-top: 4px;
      padding-top: 5px;
      border-top: 1px solid var(--panel-border);
    }
    .property-label {
      overflow: hidden;
      color: var(--panel-text-secondary);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .value-shell {
      display: flex;
      min-width: 0;
      height: 28px;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--panel-border);
      border-radius: 7px;
      background: var(--panel-bg-strong);
      padding: 0 8px;
    }
    .value-shell:focus-within { border-color: var(--panel-accent); box-shadow: 0 0 0 1px var(--panel-accent-soft); }
    .value-shell[data-dirty="true"] { border-color: var(--panel-accent); background: var(--panel-accent-soft); }
    .property-input, .property-select {
      width: 100%;
      min-width: 0;
      border: 0;
      outline: 0;
      padding: 0;
      background: transparent;
      color: var(--panel-text);
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .property-input::placeholder { color: var(--panel-text-secondary); opacity: 0.55; }
    .property-select {
      height: 100%;
      cursor: pointer;
      color-scheme: inherit;
    }
    .unit-select {
      flex: none;
      width: 34px;
      border: 0;
      outline: 0;
      padding: 0;
      background: transparent;
      color: var(--panel-text-secondary);
      cursor: pointer;
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-align: right;
    }
    .unit-select[hidden] { display: none; }
    .box-shell {
      display: grid;
      min-width: 0;
      height: 28px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      overflow: hidden;
      border: 1px solid var(--panel-border);
      border-radius: 7px;
      background: var(--panel-bg-strong);
    }
    .box-shell:focus-within { border-color: var(--panel-accent); box-shadow: 0 0 0 1px var(--panel-accent-soft); }
    .box-shell[data-dirty="true"] { border-color: var(--panel-accent); background: var(--panel-accent-soft); }
    .box-input {
      width: 100%;
      min-width: 0;
      border: 0;
      border-left: 1px solid var(--panel-border);
      outline: 0;
      padding: 0 3px;
      background: transparent;
      color: var(--panel-text);
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-align: center;
    }
    .box-input:first-child { border-left: 0; }
    .color-picker {
      flex: none;
      width: 20px;
      height: 20px;
      overflow: hidden;
      border: 1px solid var(--panel-border);
      border-radius: 5px;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }
    .color-picker::-webkit-color-swatch-wrapper { padding: 0; }
    .color-picker::-webkit-color-swatch { border: 0; border-radius: 4px; }
    .footer {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: space-between;
      min-height: 46px;
      padding: 6px 8px 6px 10px;
      border-top: 1px solid var(--panel-border);
      background: var(--panel-toolbar);
    }
    .cancel {
      min-height: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 0 9px;
      background: transparent;
      color: var(--panel-text-secondary);
      cursor: pointer;
      font-size: 11px;
    }
    .cancel:hover, .cancel:focus-visible { border-color: var(--panel-accent); background: var(--panel-hover); color: var(--panel-text); outline: 0; }
    .footer-confirm { background: #2563eb; color: #ffffff; }
    .footer-confirm:hover, .footer-confirm:focus-visible { background: #1d4ed8; color: #ffffff; }
    @media (max-width: 420px), (pointer: coarse) {
      .composer { min-height: 50px; }
      .property-panel { padding-right: 9px; padding-left: 9px; }
      .property-row { grid-template-columns: 88px minmax(0, 1fr); min-height: 37px; }
      .value-shell, .box-shell { height: 30px; }
    }
    @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
  `;

  const anchor = document.createElement('div');
  anchor.className = 'anchor';

  const card = document.createElement('section');
  card.className = 'card';
  card.dataset.expanded = 'false';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', labels.title);

  const composer = document.createElement('div');
  composer.className = 'composer';
  const settings = button('icon-button settings', labels.styleChanges);
  settings.setAttribute('aria-expanded', 'false');
  settings.append(slidersIcon());
  const comment = document.createElement('textarea');
  comment.className = 'comment';
  comment.rows = 1;
  comment.value = initialComment;
  comment.placeholder = labels.placeholder;
  comment.setAttribute('aria-label', labels.placeholder);
  const composerConfirm = button('icon-button composer-confirm confirm', labels.add);
  composerConfirm.disabled = true;
  composerConfirm.append(checkIcon());
  composer.append(settings, comment, composerConfirm);

  const expandedContent = document.createElement('div');
  expandedContent.className = 'expanded-content';
  const elementBar = document.createElement('div');
  elementBar.className = 'element-bar';
  const elementName = document.createElement('span');
  elementName.className = 'element-name';
  elementName.textContent = selection.element?.tagName || 'element';
  elementName.title = elementLabel(selection);
  const grip = button('grip', labels.move);
  for (let index = 0; index < 6; index += 1) grip.append(document.createElement('i'));
  elementBar.append(elementName, grip);

  const propertyPanel = document.createElement('div');
  propertyPanel.className = 'property-panel';
  expandedContent.append(elementBar, propertyPanel);

  const footer = document.createElement('div');
  footer.className = 'footer';
  const skip = button('cancel', labels.skip);
  skip.textContent = labels.skip;
  const footerConfirm = button('icon-button footer-confirm confirm', labels.add);
  footerConfirm.disabled = true;
  footerConfirm.append(checkIcon());
  footer.append(skip, footerConfirm);
  expandedContent.append(footer);

  card.append(composer, expandedContent);
  shadow.append(style, anchor, card);
  document.documentElement.appendChild(host);

  let destroyed = false;
  let expanded = false;
  let positionFrame = 0;
  let manualPosition: { left: number; top: number } | null = null;
  let keepPreview = false;
  const requestedProperties = new Set<ElementCommentChangeProperty>();
  const initiallyRequestedProperties = new Set(
    Object.keys(initialStyleChanges) as ElementCommentChangeProperty[],
  );
  const initialStyleValues = new Map<ElementCommentChangeProperty, string>();
  const styleValueReaders = new Map<ElementCommentChangeProperty, () => string>();
  const liveStyle = window.getComputedStyle(target);
  const styledTarget =
    target instanceof HTMLElement || target instanceof SVGElement ? target : null;
  const textEditable = canEditElementText(target);
  const originalText = readElementText(target);
  const originalInlineStyles = new Map(
    ELEMENT_COMMENT_STYLE_PROPERTIES.map(property => {
      const name = cssPropertyName(property);
      return [
        property,
        {
          value: styledTarget?.style.getPropertyValue(name) || '',
          priority: styledTarget?.style.getPropertyPriority(name) || '',
        },
      ] as const;
    }),
  );

  const initialStyleValue = (property: ElementCommentStyleProperty): string =>
    liveStyle.getPropertyValue(cssPropertyName(property)).trim() ||
    selection.element?.computedStyle?.[property] ||
    '';

  const styleChanges = (): ElementCommentStyleChanges =>
    Object.fromEntries(
      Array.from(requestedProperties)
        .map(property => [property, styleValueReaders.get(property)?.().trim() || ''])
        .filter((entry): entry is [ElementCommentChangeProperty, string] => Boolean(entry[1])),
    );

  const updateConfirm = () => {
    const disabled = !comment.value.trim() && Object.keys(styleChanges()).length === 0;
    composerConfirm.disabled = disabled;
    footerConfirm.disabled = disabled;
  };

  const schedulePosition = () => {
    if (destroyed || positionFrame) return;
    positionFrame = requestAnimationFrame(position);
  };

  const restorePreviewProperty = (property: ElementCommentChangeProperty) => {
    if (property === 'textContent') {
      if (textEditable) writeElementText(target, originalText);
      return;
    }
    if (!styledTarget) return;
    const name = cssPropertyName(property);
    const original = originalInlineStyles.get(property);
    if (original?.value) styledTarget.style.setProperty(name, original.value, original.priority);
    else styledTarget.style.removeProperty(name);
  };

  const applyPreview = (property: ElementCommentChangeProperty) => {
    if (property === 'textContent') {
      if (textEditable) {
        const value = styleValueReaders.get(property)?.().trim();
        if (value) writeElementText(target, value);
        else writeElementText(target, originalText);
        schedulePosition();
      }
      return;
    }
    if (!styledTarget) return;
    const value = styleValueReaders.get(property)?.().trim();
    if (value) styledTarget.style.setProperty(cssPropertyName(property), value, 'important');
    else restorePreviewProperty(property);
    schedulePosition();
  };

  const markDirty = (property: ElementCommentChangeProperty, shell: HTMLElement) => {
    const currentValue = styleValueReaders.get(property)?.().trim() || '';
    if (currentValue === initialStyleValues.get(property)) {
      if (initiallyRequestedProperties.has(property)) {
        requestedProperties.add(property);
        shell.dataset.dirty = 'true';
      } else {
        requestedProperties.delete(property);
        shell.removeAttribute('data-dirty');
      }
      restorePreviewProperty(property);
      updateConfirm();
      return;
    }
    requestedProperties.add(property);
    shell.dataset.dirty = 'true';
    applyPreview(property);
    updateConfirm();
  };

  // 文本内容行：直接改写元素可见文字，可安全写入时实时预览
  {
    const row = document.createElement('label');
    row.className = 'property-row';
    row.dataset.property = 'textContent';
    const propertyLabel = document.createElement('span');
    propertyLabel.className = 'property-label';
    propertyLabel.textContent = labels.styleProperties.textContent;
    propertyLabel.title = labels.styleProperties.textContent;
    const shell = document.createElement('span');
    shell.className = 'value-shell';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'property-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.property = 'textContent';
    input.setAttribute('aria-label', labels.styleProperties.textContent);
    const initialText = initialStyleChanges.textContent ?? originalText.slice(0, 500);
    initialStyleValues.set('textContent', initialText.trim());
    input.value = initialText;
    input.addEventListener('input', () => markDirty('textContent', shell));
    shell.append(input);
    styleValueReaders.set('textContent', () => input.value);
    if (initialStyleChanges.textContent) {
      requestedProperties.add('textContent');
      shell.dataset.dirty = 'true';
    }
    row.append(propertyLabel, shell);
    propertyPanel.append(row);
  }

  for (const property of ELEMENT_COMMENT_STYLE_PROPERTIES) {
    const row = document.createElement('label');
    row.className = `property-row${GROUP_START_PROPERTIES.has(property) ? ' group-start' : ''}`;
    row.dataset.property = property;
    const propertyLabel = document.createElement('span');
    propertyLabel.className = 'property-label';
    propertyLabel.textContent = labels.styleProperties[property];
    propertyLabel.title = labels.styleProperties[property];
    const initialValue = initialStyleChanges[property] || initialStyleValue(property);
    initialStyleValues.set(property, initialValue);

    if (property === 'margin' || property === 'padding') {
      const shell = document.createElement('span');
      shell.className = 'box-shell';
      const edgeInputs = expandBoxValue(initialValue).map((value, index) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'box-input';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.dataset.property = property;
        input.dataset.edge = ['top', 'right', 'bottom', 'left'][index];
        input.value = value;
        input.placeholder = '0';
        input.setAttribute(
          'aria-label',
          `${labels.styleProperties[property]} · ${['↑', '→', '↓', '←'][index]}`,
        );
        input.addEventListener('input', () => markDirty(property, shell));
        shell.append(input);
        return input;
      });
      styleValueReaders.set(property, () => compactBoxValue(edgeInputs.map(input => input.value)));
      if (initialStyleChanges[property]) {
        requestedProperties.add(property);
        shell.dataset.dirty = 'true';
      }
      row.append(propertyLabel, shell);
      propertyPanel.append(row);
      continue;
    }

    const shell = document.createElement('span');
    shell.className = 'value-shell';

    const selectValues = SELECT_PROPERTY_VALUES[property];
    if (selectValues) {
      const select = document.createElement('select');
      select.className = 'property-select';
      select.dataset.property = property;
      select.setAttribute('aria-label', labels.styleProperties[property]);
      for (const value of Array.from(new Set([initialValue, ...selectValues])).filter(Boolean)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
      }
      select.value = initialValue || select.options[0]?.value || '';
      select.addEventListener('change', () => markDirty(property, shell));
      shell.append(select);
      styleValueReaders.set(property, () => select.value);
      if (initialStyleChanges[property]) {
        requestedProperties.add(property);
        shell.dataset.dirty = 'true';
      }
      row.append(propertyLabel, shell);
      propertyPanel.append(row);
      continue;
    }

    const input = document.createElement('input');
    input.type = property === 'opacity' ? 'number' : 'text';
    input.className = 'property-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.property = property;
    input.setAttribute('aria-label', labels.styleProperties[property]);
    if (property === 'opacity') {
      input.min = '0';
      input.max = '1';
      input.step = '0.05';
      input.inputMode = 'decimal';
    }
    const unitMatch = UNIT_PROPERTIES.has(property)
      ? /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|vw|vh)$/.exec(initialValue)
      : null;
    input.value = unitMatch?.[1] || initialValue;
    input.placeholder = labels.valuePlaceholder;
    input.addEventListener('input', () => markDirty(property, shell));

    if (property === 'color' || property === 'backgroundColor' || property === 'borderColor') {
      const colorPicker = document.createElement('input');
      colorPicker.type = 'color';
      colorPicker.className = 'color-picker';
      colorPicker.value = colorToHex(input.value) || '#000000';
      colorPicker.setAttribute('aria-label', labels.styleProperties[property]);
      colorPicker.addEventListener('input', () => {
        input.value = colorPicker.value;
        markDirty(property, shell);
      });
      input.addEventListener('input', () => {
        const color = colorToHex(input.value);
        if (color) colorPicker.value = color;
      });
      shell.append(colorPicker);
    }

    shell.append(input);

    if (UNIT_PROPERTIES.has(property)) {
      const unit = document.createElement('select');
      unit.className = 'unit-select';
      unit.setAttribute('aria-label', labels.styleProperties[property]);
      for (const value of ['px', 'rem', 'em', '%', 'vw', 'vh']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        unit.append(option);
      }
      unit.value = unitMatch?.[2] || 'px';
      unit.addEventListener('change', () => markDirty(property, shell));
      const updateUnitVisibility = () => {
        unit.hidden = !/^-?(?:\d+\.?\d*|\.\d+)$/.test(input.value.trim());
      };
      input.addEventListener('input', updateUnitVisibility);
      updateUnitVisibility();
      shell.append(unit);
      styleValueReaders.set(property, () => {
        const value = input.value.trim();
        return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? `${value}${unit.value}` : value;
      });
    } else {
      styleValueReaders.set(property, () => input.value);
    }

    if (initialStyleChanges[property]) {
      requestedProperties.add(property);
      shell.dataset.dirty = 'true';
    }

    row.append(propertyLabel, shell);
    propertyPanel.append(row);
  }

  const position = () => {
    positionFrame = 0;
    if (destroyed) return;
    const bounds = viewportBounds();
    const viewportRight = bounds.left + bounds.width;
    const viewportBottom = bounds.top + bounds.height;
    const targetRect = target.isConnected
      ? target.getBoundingClientRect()
      : selection.element?.rect;

    if (targetRect) {
      anchor.style.display = 'block';
      anchor.style.left = `${targetRect.left}px`;
      anchor.style.top = `${targetRect.top}px`;
      anchor.style.width = `${Math.max(0, targetRect.width)}px`;
      anchor.style.height = `${Math.max(0, targetRect.height)}px`;
    } else {
      anchor.style.display = 'none';
    }

    card.style.width = `${Math.min(CARD_WIDTH, bounds.width - VIEWPORT_MARGIN * 2)}px`;
    card.style.maxHeight = `${Math.max(160, bounds.height - VIEWPORT_MARGIN * 2)}px`;
    const cardRect = card.getBoundingClientRect();
    const cardWidth = cardRect.width || Math.min(CARD_WIDTH, bounds.width - 16);
    const fallbackHeight = expanded ? EXPANDED_FALLBACK_HEIGHT : COLLAPSED_FALLBACK_HEIGHT;
    const cardHeight = Math.min(
      cardRect.height || card.scrollHeight || fallbackHeight,
      bounds.height - 16,
    );
    const rect = targetRect || {
      left: bounds.left + bounds.width / 2,
      right: bounds.left + bounds.width / 2,
      top: bounds.top + bounds.height / 2,
      bottom: bounds.top + bounds.height / 2,
    };
    const minLeft = bounds.left + VIEWPORT_MARGIN;
    const maxLeft = viewportRight - cardWidth - VIEWPORT_MARGIN;
    const minTop = bounds.top + VIEWPORT_MARGIN;
    const maxTop = viewportBottom - cardHeight - VIEWPORT_MARGIN;
    if (manualPosition) {
      manualPosition = {
        left: clamp(manualPosition.left, minLeft, maxLeft),
        top: clamp(manualPosition.top, minTop, maxTop),
      };
      card.style.left = `${manualPosition.left}px`;
      card.style.top = `${manualPosition.top}px`;
      return;
    }
    const candidates = [
      {
        left: rect.right + ANCHOR_GAP,
        top: rect.top,
        fits: rect.right + ANCHOR_GAP <= maxLeft,
      },
      {
        left: rect.left - cardWidth - ANCHOR_GAP,
        top: rect.top,
        fits: rect.left - cardWidth - ANCHOR_GAP >= minLeft,
      },
      {
        left: rect.left,
        top: rect.bottom + ANCHOR_GAP,
        fits: rect.bottom + ANCHOR_GAP <= maxTop,
      },
      {
        left: rect.left,
        top: rect.top - cardHeight - ANCHOR_GAP,
        fits: rect.top - cardHeight - ANCHOR_GAP >= minTop,
      },
    ];
    const preferred = candidates.find(candidate => candidate.fits) || candidates[2]!;
    card.style.left = `${clamp(preferred.left, minLeft, maxLeft)}px`;
    card.style.top = `${clamp(preferred.top, minTop, maxTop)}px`;
  };

  const setExpanded = (nextExpanded: boolean) => {
    expanded = nextExpanded;
    card.dataset.expanded = String(expanded);
    settings.setAttribute('aria-expanded', String(expanded));
    schedulePosition();
  };

  const beginDrag = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = viewportBounds();
    const cardRect = card.getBoundingClientRect();
    const cardWidth = cardRect.width || Math.min(CARD_WIDTH, bounds.width - 16);
    const cardHeight = Math.min(
      cardRect.height || card.scrollHeight || EXPANDED_FALLBACK_HEIGHT,
      bounds.height - 16,
    );
    const startLeft = cardRect.left || Number.parseFloat(card.style.left) || VIEWPORT_MARGIN;
    const startTop = cardRect.top || Number.parseFloat(card.style.top) || VIEWPORT_MARGIN;
    const offsetX = event.clientX - startLeft;
    const offsetY = event.clientY - startTop;
    card.dataset.dragging = 'true';
    try {
      grip.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events do not always have an active pointer to capture.
    }

    const move = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const nextBounds = viewportBounds();
      manualPosition = {
        left: clamp(
          moveEvent.clientX - offsetX,
          nextBounds.left + VIEWPORT_MARGIN,
          nextBounds.left + nextBounds.width - cardWidth - VIEWPORT_MARGIN,
        ),
        top: clamp(
          moveEvent.clientY - offsetY,
          nextBounds.top + VIEWPORT_MARGIN,
          nextBounds.top + nextBounds.height - cardHeight - VIEWPORT_MARGIN,
        ),
      };
      card.style.left = `${manualPosition.left}px`;
      card.style.top = `${manualPosition.top}px`;
    };
    const end = (endEvent: PointerEvent) => {
      try {
        grip.releasePointerCapture?.(endEvent.pointerId);
      } catch {
        // The browser may release capture before pointercancel is delivered.
      }
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      delete card.dataset.dragging;
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };

  const resizeComment = () => {
    comment.style.height = '28px';
    const contentHeight = Math.max(comment.scrollHeight, 28);
    comment.style.height = `${Math.min(contentHeight, 76)}px`;
    comment.style.overflowY = contentHeight > 76 ? 'auto' : 'hidden';
    schedulePosition();
  };

  const handleOutsidePointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    if (path.some(node => node instanceof Element && isElementCommentMarker(node))) {
      skipCurrent();
      return;
    }
    if (expanded || path.includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    destroy();
    const finishGesture = (finishEvent: PointerEvent) => {
      finishEvent.preventDefault();
      finishEvent.stopImmediatePropagation();
      document.removeEventListener('pointerup', finishGesture, true);
      document.removeEventListener('pointercancel', finishGesture, true);
      const blockClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
      };
      document.addEventListener('click', blockClick, { capture: true, once: true });
      setTimeout(() => {
        document.removeEventListener('click', blockClick, true);
        onSkip();
      }, 0);
    };
    document.addEventListener('pointerup', finishGesture, true);
    document.addEventListener('pointercancel', finishGesture, true);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (!keepPreview) {
      for (const property of requestedProperties) restorePreviewProperty(property);
    }
    if (positionFrame) cancelAnimationFrame(positionFrame);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('orientationchange', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    resizeObserver?.disconnect();
    host.remove();
  };

  const cancel = () => {
    destroy();
    onCancel();
  };
  const skipCurrent = () => {
    destroy();
    onSkip();
  };
  const confirmCurrent = () => {
    const nextComment = comment.value.trim();
    const nextStyles = styleChanges();
    if (!nextComment && Object.keys(nextStyles).length === 0) return;
    keepPreview = true;
    destroy();
    onConfirm(nextComment, nextStyles);
  };

  comment.addEventListener('input', () => {
    resizeComment();
    updateConfirm();
  });
  settings.addEventListener('click', () => setExpanded(!expanded));
  grip.addEventListener('pointerdown', beginDrag);
  skip.addEventListener('click', skipCurrent);
  composerConfirm.addEventListener('click', confirmCurrent);
  footerConfirm.addEventListener('click', confirmCurrent);
  shadow.addEventListener('pointerdown', event => event.stopPropagation());
  shadow.addEventListener('click', event => event.stopPropagation());
  shadow.addEventListener('input', event => event.stopPropagation());
  shadow.addEventListener('keydown', event => {
    const keyboardEvent = event as KeyboardEvent;
    event.stopPropagation();
    if (keyboardEvent.isComposing || keyboardEvent.keyCode === 229) return;
    if (keyboardEvent.key === 'Escape') {
      event.preventDefault();
      if (expanded) setExpanded(false);
      else cancel();
    } else if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === 'Enter') {
      event.preventDefault();
      confirmCurrent();
    } else if (
      keyboardEvent.target === comment &&
      keyboardEvent.key === 'Enter' &&
      !keyboardEvent.shiftKey
    ) {
      event.preventDefault();
      confirmCurrent();
    }
  });

  window.addEventListener('resize', schedulePosition);
  window.addEventListener('orientationchange', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePosition) : null;
  resizeObserver?.observe(target);
  resizeObserver?.observe(card);

  position();
  updateConfirm();
  requestAnimationFrame(() => {
    position();
    resizeComment();
    comment.focus({ preventScroll: true });
  });

  return { destroy };
}
