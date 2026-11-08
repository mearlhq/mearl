import { renderSVG } from 'uqr';

const SVG_ROOT_ATTRIBUTES = 'width="100%" height="100%" focusable="false" aria-hidden="true"';

interface QrCodeOptions {
  color?: string;
  border?: number;
}

export const generateQrCodeSvgMarkup = (
  value: string,
  { color = '#000000', border = 1 }: QrCodeOptions = {},
): string => {
  const svg = renderSVG(value, {
    pixelSize: 1,
    border,
    blackColor: color,
    whiteColor: '#FFFFFF',
  });

  return svg.replace('<svg ', `<svg ${SVG_ROOT_ATTRIBUTES} `);
};
