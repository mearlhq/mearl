export interface HexColorValue {
  cssValue: string;
  pickerValue: string;
  alpha: string;
}

const HEX_COLOR_PATTERN = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

export const parseHexColorValue = (value: unknown): HexColorValue | null => {
  if (typeof value !== 'string') return null;
  if (
    value[0] !== '#' ||
    (value.length !== 4 && value.length !== 5 && value.length !== 7 && value.length !== 9)
  ) {
    return null;
  }

  const match = value.match(HEX_COLOR_PATTERN);
  if (!match) return null;

  const hex = match[1];
  const expanded =
    hex.length === 3 || hex.length === 4
      ? [...hex].map(character => character.repeat(2)).join('')
      : hex;

  return {
    cssValue: value,
    pickerValue: `#${expanded.slice(0, 6)}`,
    alpha: expanded.length === 8 ? expanded.slice(6) : '',
  };
};

export const applyPickedColor = (pickedColor: string, currentValue: string): string => {
  const parsed = parseHexColorValue(currentValue);
  return parsed?.alpha ? `${pickedColor}${parsed.alpha}` : pickedColor;
};
