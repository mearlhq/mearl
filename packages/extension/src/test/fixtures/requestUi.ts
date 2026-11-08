import { validateBrowserRequestUi } from '@mearl/preset/bundles';

export const requestUiFixture = validateBrowserRequestUi({
  "schemaVersion": 1,
  "service": "example-metadata",
  "setting": {
    "key": "requestMetadataEnabled",
    "label": {
      "en": "Metadata service",
      "zh_CN": "Metadata service"
    }
  },
  "apiLink": {
    "url": "https://metadata.example.test/max/mtop/detail/overview",
    "query": {
      "type": "RPC"
    },
    "apiParameter": "rpcName",
    "versionParameter": "rpcVersion",
    "title": {
      "en": "Click to view details in Metadata service",
      "zh_CN": "点击跳转到 Metadata service 查看详情"
    }
  },
  "login": {
    "url": "https://metadata.example.test/",
    "title": {
      "en": "Login to Metadata service",
      "zh_CN": "登录 Metadata service"
    },
    "requiredMessage": {
      "en": "No access to Metadata service. Please log in via the popup and try again.",
      "zh_CN": "无权访问 Metadata service，请在弹窗中登录后重试"
    },
    "errorIncludes": [
      "please login to example-metadata",
      "unauthorized",
      "未授权",
      "无权访问",
      "not logged in",
      "html page instead of json"
    ]
  },
  "details": {
    "hook": "request.apiSchema.details",
    "toggleLabel": {
      "en": "HSF",
      "zh_CN": "HSF"
    },
    "interfaceLabel": {
      "en": "HSF Interface",
      "zh_CN": "HSF 接口"
    },
    "maintainerLabel": {
      "en": "Maintainer",
      "zh_CN": "维护人"
    },
    "viewTitle": {
      "en": "View in HSF Console",
      "zh_CN": "在 HSF 控制台查看"
    },
    "notFound": {
      "en": "HSF interface info not found",
      "zh_CN": "未找到 HSF 接口信息"
    }
  },
  "save": {
    "hook": "request.example.save",
    "setting": "requestCasesEnabled"
  }
});
