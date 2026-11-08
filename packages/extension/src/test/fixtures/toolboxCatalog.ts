export default {
  "tools": [
    {
      "id": "plugin:convert",
      "plugin": "convert",
      "repository": "mearlhq/mearl",
      "skill": "format-converter",
      "title": "格式转换",
      "description": "时间戳、Base64、图片与 URL 双向转换",
      "icon": "wrench",
      "locales": {
        "en": {
          "title": "Format converter",
          "description": "Convert timestamps, Base64, images and URL encoding"
        }
      }
    },
    {
      "id": "plugin:tinypng",
      "plugin": "tinypng",
      "repository": "mearlhq/mearl",
      "skill": "tinypng-compress",
      "title": "图片压缩",
      "description": "粘贴、拖入或选择图片，通过 TinyPNG 压缩",
      "icon": "package",
      "locales": {
        "en": {
          "title": "Image compression",
          "description": "Paste, drop or choose images to compress with TinyPNG"
        }
      }
    }
  ]
};
