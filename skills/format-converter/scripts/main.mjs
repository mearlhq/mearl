import '../assets/toolbox/codec.js';

const { convert, analyze } = globalThis.mearlFormatCodec;
export const name = 'convert';
export const description = '本地转换时间戳、Base64、Base64 图片与 URL 编码';
export const toolbox = {
  version: 1, title: '格式转换', description: '时间戳、Base64、图片与 URL 双向转换', icon: 'wrench',
  locales: { en: { title: 'Format converter', description: 'Convert timestamps, Base64, images and URL encoding' } },
  page: { type: 'sandbox', runtime: 'preact', entry: 'assets/toolbox/index.html', commands: ['convert'] },
  order: 65,
};
export default function register(app) {
  app.command('convert', input => {
    const result = input?.format ? convert(input) : analyze(input);
    if (result.image && typeof result.image === 'object') {
      const { mime, bytes } = result.image;
      return { ...result, image: { mime, bytes } };
    }
    if (result.kind === 'image') {
      const { mime, bytes } = result.meta;
      return { ...result, meta: { mime, bytes } };
    }
    return result;
  }, '自动识别 value 并转换；zone=local/utc。也可显式传 format=timestamp/base64/image/url 和 direction=encode/decode');
}
