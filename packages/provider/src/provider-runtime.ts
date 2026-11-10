import type {
  BrowserProviderDefinition,
  JsonObject,
  JsonValue,
  ProviderAccess,
  ProviderBrowser,
  ProviderContext,
  ProviderInputSchema,
  ProviderObjectSchema,
  ProviderRuntime,
  ProviderLaunchForm,
} from './types.js';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from './types.js';
import { isProviderAction } from './actions.js';
import { isProviderControlSessionModes } from './protocol.js';
import type { BrowserControlSessionMode } from '@mearl/browser-core';
import { isProviderEnhancementTarget, parseExternalBrowserControl } from '@mearl/browser-core';

const LIFECYCLE_OPERATIONS = new Set([
  'start',
  'close',
  'detach',
  'deleteData',
  'access',
  'syncCookies',
  'handoff',
  'resume',
  'finish',
]);

function assertDeadline(context: { deadline?: number }): void {
  if (
    context.deadline !== undefined &&
    (!Number.isSafeInteger(context.deadline) || Date.now() >= context.deadline)
  )
    throw new Error('Provider request deadline exceeded');
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return (
    typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, depth + 1))
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

export function isProviderInputSchema(value: unknown, depth = 0): value is ProviderInputSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 32) return false;
  const schema = value as Record<string, unknown>;
  if (
    !isOptionalString(schema.title) ||
    !isOptionalString(schema.description) ||
    (schema.component !== undefined &&
      !['cookie-sync', 'switch'].includes(String(schema.component))) ||
    (schema.default !== undefined && !isJsonValue(schema.default)) ||
    (schema.formDefault !== undefined && !isJsonValue(schema.formDefault)) ||
    (schema.formHidden !== undefined && typeof schema.formHidden !== 'boolean') ||
    (schema.formWidth !== undefined && !['half', 'full'].includes(String(schema.formWidth))) ||
    (schema.formHideOptional !== undefined && typeof schema.formHideOptional !== 'boolean') ||
    (schema.formVisibleWhen !== undefined &&
      (!schema.formVisibleWhen ||
        typeof schema.formVisibleWhen !== 'object' ||
        Array.isArray(schema.formVisibleWhen) ||
        typeof (schema.formVisibleWhen as Record<string, unknown>).field !== 'string' ||
        !(schema.formVisibleWhen as Record<string, unknown>).field ||
        typeof (schema.formVisibleWhen as Record<string, unknown>).empty !== 'boolean'))
  ) {
    return false;
  }
  if (schema.type === 'string') {
    let validPattern = true;
    if (schema.pattern !== undefined) {
      try {
        new RegExp(String(schema.pattern));
      } catch {
        validPattern = false;
      }
    }
    const valid =
      (schema.enum === undefined ||
        (Array.isArray(schema.enum) && schema.enum.every(item => typeof item === 'string'))) &&
      (schema.secret === undefined || typeof schema.secret === 'boolean') &&
      isOptionalCount(schema.minLength) &&
      isOptionalCount(schema.maxLength) &&
      (schema.minLength === undefined ||
        schema.maxLength === undefined ||
        Number(schema.minLength) <= Number(schema.maxLength)) &&
      isOptionalString(schema.pattern) &&
      validPattern &&
      isOptionalString(schema.placeholder) &&
      (schema.options === undefined ||
        (Array.isArray(schema.options) &&
          schema.options.every(
            option =>
              option &&
              typeof option === 'object' &&
              !Array.isArray(option) &&
              typeof option.value === 'string' &&
              typeof option.label === 'string' &&
              isOptionalString(option.description) &&
              (option.disabled === undefined || typeof option.disabled === 'boolean') &&
              (schema.enum === undefined || (schema.enum as string[]).includes(option.value)),
          ) &&
          new Set(schema.options.map(option => option.value)).size === schema.options.length));
    if (!valid) return false;
  } else if (schema.type === 'number') {
    const valid =
      (schema.integer === undefined || typeof schema.integer === 'boolean') &&
      isOptionalFiniteNumber(schema.minimum) &&
      isOptionalFiniteNumber(schema.maximum) &&
      (schema.minimum === undefined ||
        schema.maximum === undefined ||
        Number(schema.minimum) <= Number(schema.maximum));
    if (!valid) return false;
  } else if (schema.type === 'boolean') {
    // Boolean schemas have no type-specific constraints.
  } else if (schema.type === 'array') {
    if (
      !isProviderInputSchema(schema.items, depth + 1) ||
      !isOptionalCount(schema.minItems) ||
      !isOptionalCount(schema.maxItems) ||
      (schema.minItems !== undefined &&
        schema.maxItems !== undefined &&
        Number(schema.minItems) > Number(schema.maxItems))
    ) {
      return false;
    }
  } else {
    if (
      schema.type !== 'object' ||
      !schema.properties ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties) ||
      (schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== 'boolean')
    ) {
      return false;
    }
    const properties = schema.properties as Record<string, unknown>;
    if (!Object.values(properties).every(item => isProviderInputSchema(item, depth + 1))) {
      return false;
    }
    if (
      Object.values(properties).some(item => {
        const condition = (item as Record<string, unknown>).formVisibleWhen as
          Record<string, unknown> | undefined;
        return condition !== undefined && !(String(condition.field) in properties);
      })
    ) {
      return false;
    }
    if (
      schema.not !== undefined &&
      (!isProviderInputSchema(schema.not, depth + 1) || schema.not.type !== 'object')
    )
      return false;
    if (
      schema.oneOf !== undefined &&
      (!Array.isArray(schema.oneOf) ||
        schema.oneOf.length === 0 ||
        schema.oneOf.some(
          branch => !isProviderInputSchema(branch, depth + 1) || branch.type !== 'object',
        ))
    )
      return false;
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(item => typeof item !== 'string' || !(item in properties)) ||
        new Set(schema.required).size !== schema.required.length)
    ) {
      return false;
    }
  }
  if (schema.component === 'cookie-sync' && schema.type !== 'object') return false;
  if (schema.component === 'switch' && schema.type !== 'boolean') return false;
  if (schema.default !== undefined) {
    try {
      validateSchemaValue(value as ProviderInputSchema, schema.default as JsonValue, 'default');
    } catch {
      return false;
    }
  }
  if (schema.formDefault !== undefined) {
    try {
      validateSchemaValue(
        value as ProviderInputSchema,
        schema.formDefault as JsonValue,
        'formDefault',
      );
    } catch {
      return false;
    }
  }
  return true;
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

function validateSchemaValue(schema: ProviderInputSchema, value: JsonValue, path: string): void {
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(path, 'must be a string');
    if (schema.enum && !schema.enum.includes(value)) fail(path, 'has an unsupported value');
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(path, `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      fail(path, 'has an invalid format');
    }
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a number');
    if (schema.integer && !Number.isInteger(value)) fail(path, 'must be an integer');
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(path, `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(path, `must be at most ${schema.maximum}`);
    }
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(path, `must contain at most ${schema.maxItems} items`);
    }
    value.forEach((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`));
    return;
  }
  validateObject(schema, value, path);
}

function validateObject(schema: ProviderObjectSchema, value: JsonValue, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const input = value as JsonObject;
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) fail(`${path}.${key}`, 'is required');
  }
  if (schema.not) {
    let matches = false;
    try {
      validateObject(schema.not, input, path);
      matches = true;
    } catch {
      /* A rejected exclusion is valid. */
    }
    if (matches) fail(path, 'matches a forbidden field combination');
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => {
      try {
        validateObject(branch, input, path);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) fail(path, 'must match exactly one launch form');
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(input)) {
      if (!schema.properties[key]) fail(`${path}.${key}`, 'is not supported');
    }
  }
  for (const [key, item] of Object.entries(input)) {
    const property = schema.properties[key];
    if (property) validateSchemaValue(property, item, `${path}.${key}`);
  }
}

export function validateProviderInput(schema: ProviderObjectSchema, value: JsonObject): void {
  validateObject(schema, value, 'options');
}

export function validateProviderBrowser(browser: ProviderBrowser): void {
  if (!browser || typeof browser !== 'object') throw new Error('Provider returned no browser');
  if (typeof browser.browserId !== 'string' || !browser.browserId.trim()) {
    throw new Error('Provider browserId is required');
  }
  if (typeof browser.name !== 'string' || !browser.name.trim()) {
    throw new Error(`Provider browser ${browser.browserId} needs a name`);
  }
  if (!['connected', 'pairing', 'running_disconnected', 'stopped'].includes(browser.status)) {
    throw new Error(`Provider browser ${browser.browserId} has an invalid status`);
  }
  if (!['ephemeral', 'persistent'].includes(browser.persistence)) {
    throw new Error(`Provider browser ${browser.browserId} has invalid persistence`);
  }
  if (browser.ownership !== undefined && !['owned', 'attached'].includes(browser.ownership)) {
    throw new Error(`Provider browser ${browser.browserId} has invalid ownership`);
  }
  if (!browser.control || !['provider', 'host', 'none'].includes(browser.control.kind)) {
    throw new Error(`Provider browser ${browser.browserId} has invalid control`);
  }
  if (
    !Array.isArray(browser.operations) ||
    new Set(browser.operations).size !== browser.operations.length ||
    browser.operations.some(operation => !LIFECYCLE_OPERATIONS.has(operation))
  ) {
    throw new Error(`Provider browser ${browser.browserId} has invalid lifecycle operations`);
  }
  if (browser.status === 'pairing') {
    if (
      browser.pairing?.kind !== 'qr' ||
      typeof browser.pairing.url !== 'string' ||
      !browser.pairing.url.trim()
    ) {
      throw new Error(`Pairing browser ${browser.browserId} needs a pairing URL`);
    }
  } else if (browser.pairing) {
    throw new Error(`Pairing metadata requires a pairing state: ${browser.browserId}`);
  }
  if (
    browser.pairing &&
    (!isOptionalString(browser.pairing.code) || !isOptionalString(browser.pairing.label))
  ) {
    throw new Error(`Provider browser ${browser.browserId} has invalid pairing metadata`);
  }
  if (
    browser.lastFocusedAt !== undefined &&
    (!Number.isFinite(browser.lastFocusedAt) || browser.lastFocusedAt < 0)
  ) {
    throw new Error(`Provider browser ${browser.browserId} has an invalid lastFocusedAt`);
  }
  if (browser.status === 'stopped' && browser.control.kind !== 'none') {
    throw new Error(`Stopped Provider browser ${browser.browserId} cannot expose live control`);
  }
  if (browser.status === 'connected' && browser.control.kind === 'none') {
    throw new Error(`Connected Provider browser ${browser.browserId} must expose control`);
  }
  const capabilities =
    browser.control.kind === 'provider' || browser.control.kind === 'host'
      ? browser.control.capabilities
      : undefined;
  if (browser.control.kind === 'provider' || capabilities) {
    if (!Array.isArray(capabilities?.actions)) {
      throw new Error(`Provider browser ${browser.browserId} needs action capabilities`);
    }
    if (
      capabilities.actions.some(action => !isProviderAction(action)) ||
      new Set(capabilities.actions).size !== capabilities.actions.length
    ) {
      throw new Error(`Provider browser ${browser.browserId} has invalid action capabilities`);
    }
    if (!['native', 'reconstructed', 'none'].includes(capabilities.screenshot)) {
      throw new Error(`Provider browser ${browser.browserId} has invalid screenshot capabilities`);
    }
    if (
      capabilities.controlSessionMode !== undefined &&
      !['mearl', 'external'].includes(capabilities.controlSessionMode)
    ) {
      throw new Error(`Provider browser ${browser.browserId} has invalid control session mode`);
    }
    if (browser.control.kind === 'host' && capabilities.controlSessionMode === 'external') {
      throw new Error('External control sessions require Provider control');
    }
    const supportsScreenshot = capabilities.actions.includes('page_screenshot');
    if (supportsScreenshot === (capabilities.screenshot === 'none')) {
      throw new Error(
        `Provider browser ${browser.browserId} has inconsistent screenshot capabilities`,
      );
    }
  }
  if (
    browser.control.kind === 'host' &&
    (!['extension', 'cdp'].includes(browser.control.transport) ||
      typeof browser.control.browserId !== 'string' ||
      !browser.control.browserId.trim())
  ) {
    throw new Error(`Provider browser ${browser.browserId} has invalid host control`);
  }
  if (
    browser.references !== undefined &&
    (!Array.isArray(browser.references) ||
      browser.references.some(
        reference =>
          !reference ||
          typeof reference.kind !== 'string' ||
          !reference.kind.trim() ||
          typeof reference.id !== 'string' ||
          !reference.id.trim() ||
          !isOptionalString(reference.label),
      ) ||
      new Set(browser.references.map(reference => `${reference.kind}:${reference.id}`)).size !==
        browser.references.length)
  ) {
    throw new Error(`Provider browser ${browser.browserId} has invalid references`);
  }
  if (
    browser.details !== undefined &&
    (!browser.details ||
      typeof browser.details !== 'object' ||
      Array.isArray(browser.details) ||
      !isJsonValue(browser.details))
  ) {
    throw new Error(`Provider browser ${browser.browserId} has invalid details`);
  }
  if (browser.details) {
    const details = browser.details;
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every(item => typeof item === 'string');
    if (
      (details.headless !== undefined && typeof details.headless !== 'boolean') ||
      (details.createdAt !== undefined &&
        (typeof details.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(details.createdAt)))) ||
      (details.cdpPort !== undefined &&
        (!Number.isInteger(details.cdpPort) || details.cdpPort < 1 || details.cdpPort > 65535)) ||
      (details.copiedCookies !== undefined &&
        (!details.copiedCookies ||
          !strings(details.copiedCookies.domains) ||
          !Number.isInteger(details.copiedCookies.count) ||
          details.copiedCookies.count < 0))
    ) {
      throw new Error(`Provider browser ${browser.browserId} has invalid common details`);
    }
  }
}

function validateDefinition(definition: BrowserProviderDefinition): void {
  const { providerId, name, version, protocolVersion } = definition.descriptor;
  if (!providerId?.trim()) throw new Error('providerId is required');
  if (!name?.trim()) throw new Error('provider name is required');
  if (!version?.trim()) throw new Error('provider version is required');
  if (protocolVersion !== undefined && protocolVersion !== MEARL_PROVIDER_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported provider protocol ${protocolVersion}; expected ${MEARL_PROVIDER_PROTOCOL_VERSION}`,
    );
  }
  if (!definition.browserType.name?.trim())
    throw new Error('provider browser type name is required');
  if (
    definition.browserType.controlSessionModes !== undefined &&
    !isProviderControlSessionModes(definition.browserType.controlSessionModes)
  )
    throw new Error('Provider control session modes are invalid');
  if (
    !isProviderInputSchema(definition.browserType.inputSchema) ||
    definition.browserType.inputSchema.type !== 'object'
  ) {
    throw new Error('Provider input schema is invalid');
  }
  if (
    definition.browserType.documentationUrl !== undefined &&
    (typeof definition.browserType.documentationUrl !== 'string' ||
      !/^https?:\/\//.test(definition.browserType.documentationUrl))
  )
    throw new Error('Provider documentation URL must use HTTP(S)');
  if (
    definition.browserType.dynamicLaunchForm !== undefined &&
    typeof definition.browserType.dynamicLaunchForm !== 'boolean'
  )
    throw new Error('Provider dynamic launch form declaration is invalid');
  if (definition.browserType.dynamicLaunchForm && !definition.getLaunchForm)
    throw new Error('Provider does not implement getLaunchForm');
  if (definition.browserType.launchForm !== undefined)
    validateProviderLaunchForm(definition.browserType.launchForm);
  const configuration = definition.browserType.configuration;
  if (
    configuration &&
    (!isProviderInputSchema(configuration.inputSchema) ||
      configuration.inputSchema.type !== 'object')
  ) {
    throw new Error('Provider configuration schema is invalid');
  }
}

export function validateProviderLaunchForm(form: ProviderLaunchForm): void {
  if (
    !form ||
    !isProviderInputSchema(form.inputSchema) ||
    form.inputSchema.type !== 'object' ||
    !isOptionalString(form.variant) ||
    !isOptionalString(form.message) ||
    (form.blocked !== undefined && typeof form.blocked !== 'boolean') ||
    (form.values !== undefined &&
      (!form.values ||
        typeof form.values !== 'object' ||
        Array.isArray(form.values) ||
        !isJsonValue(form.values))) ||
    (form.dynamicFields !== undefined &&
      (!Array.isArray(form.dynamicFields) ||
        form.dynamicFields.some(
          field => typeof field !== 'string' || !(field in form.inputSchema.properties),
        ))) ||
    (form.refreshOn !== undefined &&
      (!Array.isArray(form.refreshOn) ||
        form.refreshOn.some(
          field => typeof field !== 'string' || !(field in form.inputSchema.properties),
        ))) ||
    (form.variants !== undefined &&
      (!Array.isArray(form.variants) ||
        !form.variants.length ||
        form.variants.some(
          variant =>
            !variant ||
            typeof variant.id !== 'string' ||
            !variant.id ||
            typeof variant.title !== 'string' ||
            !isOptionalString(variant.description),
        ) ||
        new Set(form.variants.map(variant => variant.id)).size !== form.variants.length ||
        !form.variants.some(variant => variant.id === form.variant)))
  ) {
    throw new Error('Provider returned an invalid launch form');
  }
  for (const variant of form.variants ?? []) {
    validateProviderLaunchForm({
      inputSchema: variant.inputSchema === undefined ? form.inputSchema : variant.inputSchema,
      values: variant.values === undefined ? form.values : variant.values,
      refreshOn: variant.refreshOn === undefined ? form.refreshOn : variant.refreshOn,
      dynamicFields:
        variant.dynamicFields === undefined ? form.dynamicFields : variant.dynamicFields,
    });
  }
}

export function createProviderRuntime(definition: BrowserProviderDefinition): ProviderRuntime {
  validateDefinition(definition);
  let publishedBrowsers: ProviderBrowser[] = [];
  const declaredModes = new Set(definition.browserType.controlSessionModes ?? ['mearl']);
  const controlModes = new Map<string, BrowserControlSessionMode>();

  const rememberControlMode = (browser: ProviderBrowser): void => {
    if (browser.control.kind !== 'none') {
      controlModes.set(
        browser.browserId,
        browser.control.capabilities?.controlSessionMode ?? 'mearl',
      );
    }
  };

  const validateRuntimeBrowser = (browser: ProviderBrowser): void => {
    validateProviderBrowser(browser);
    if (browser.control.kind !== 'none') {
      const previous = controlModes.get(browser.browserId);
      const mode = browser.control.capabilities?.controlSessionMode ?? 'mearl';
      if (!declaredModes.has(mode))
        throw new Error(`Provider did not declare control session mode: ${mode}`);
      if (previous !== undefined && previous !== mode) {
        throw new Error(
          'CONTROL_SESSION_MODE_CHANGED: use a new browserId to change task control mode',
        );
      }
    }
    const implementations = {
      start: definition.start,
      detach: definition.detach,
      access: definition.getAccess,
      syncCookies: definition.syncCookies,
      handoff: definition.control,
      resume: definition.control,
      finish: definition.control,
    };
    for (const [operation, implementation] of Object.entries(implementations)) {
      if (
        browser.operations.includes(operation as ProviderBrowser['operations'][number]) &&
        !implementation
      ) {
        throw new Error(
          `Provider browser ${browser.browserId} advertises ${operation} without implementing it`,
        );
      }
    }
  };

  const listBrowsers = async (context: ProviderContext = {}): Promise<ProviderBrowser[]> => {
    assertDeadline(context);
    const browsers = definition.listBrowsers
      ? await definition.listBrowsers(context)
      : publishedBrowsers;
    const seen = new Set<string>();
    for (const browser of browsers) {
      validateRuntimeBrowser(browser);
      if (seen.has(browser.browserId)) {
        throw new Error(`Duplicate provider browserId: ${browser.browserId}`);
      }
      seen.add(browser.browserId);
    }
    browsers.forEach(rememberControlMode);
    return browsers;
  };

  const requireBrowser = async (
    browserId: string,
    operation: ProviderBrowser['operations'][number],
    context: ProviderContext,
  ): Promise<ProviderBrowser> => {
    const browser = (await listBrowsers(context)).find(item => item.browserId === browserId);
    if (!browser) throw new Error(`Provider browser not found: ${browserId}`);
    if (!browser.operations.includes(operation)) {
      throw new Error(`Provider browser ${browserId} does not support ${operation}`);
    }
    assertDeadline(context);
    return browser;
  };

  return {
    definition,
    listBrowsers,
    updateBrowsers(browsers): void {
      browsers.forEach(validateRuntimeBrowser);
      if (new Set(browsers.map(browser => browser.browserId)).size !== browsers.length) {
        throw new Error('Provider browser ids must be unique');
      }
      browsers.forEach(rememberControlMode);
      publishedBrowsers = [...browsers];
    },
    async getLaunchForm(request, context = {}): Promise<ProviderLaunchForm> {
      assertDeadline(context);
      if (!definition.browserType.dynamicLaunchForm || !definition.getLaunchForm)
        throw new Error('Provider does not support dynamic launch forms');
      if (
        !request ||
        !isOptionalString(request.variant) ||
        !request.values ||
        typeof request.values !== 'object' ||
        Array.isArray(request.values) ||
        !isJsonValue(request.values)
      )
        throw new Error('Invalid launch form request');
      const form = await definition.getLaunchForm(request, context);
      validateProviderLaunchForm(form);
      for (const [key, value] of Object.entries(form.values ?? {})) {
        const schema = definition.browserType.inputSchema.properties[key];
        if (!schema) throw new Error(`Launch form returned an unknown parameter: ${key}`);
        validateSchemaValue(schema, value, key);
      }
      return form;
    },
    async launch(options, context = {}): Promise<ProviderBrowser> {
      assertDeadline(context);
      validateProviderInput(definition.browserType.inputSchema, options);
      const browser = await definition.launch(options, context);
      validateRuntimeBrowser(browser);
      rememberControlMode(browser);
      return browser;
    },
    async start(request, context = {}): Promise<ProviderBrowser> {
      await requireBrowser(request.browserId, 'start', context);
      if (!definition.start) throw new Error('Provider does not implement start');
      const browser = await definition.start(request, context);
      validateRuntimeBrowser(browser);
      rememberControlMode(browser);
      return browser;
    },
    async close(request, context = {}): Promise<unknown> {
      await requireBrowser(request.browserId, request.deleteData ? 'deleteData' : 'close', context);
      return definition.close(request, context);
    },
    async control(request, context = {}) {
      const { browserId, ...data } = request;
      const params = parseExternalBrowserControl(data);
      const browser = await requireBrowser(browserId, params.operation, context);
      if (
        browser.status !== 'connected' ||
        browser.control.kind !== 'provider' ||
        browser.control.capabilities.controlSessionMode !== 'external' ||
        !definition.control
      )
        throw new Error('Provider does not support external browser control');
      const result = await definition.control({ browserId, ...params }, context);
      const expected =
        params.operation === 'handoff'
          ? 'user'
          : params.operation === 'resume'
            ? 'agent'
            : 'finished';
      if (
        result?.controlSessionMode !== 'external' ||
        result.operation !== params.operation ||
        result.control !== expected
      )
        throw new Error('Invalid external browser control result');
      return result;
    },
    async detach(request, context = {}): Promise<unknown> {
      await requireBrowser(request.browserId, 'detach', context);
      if (!definition.detach) throw new Error('Provider does not implement detach');
      return definition.detach(request, context);
    },
    async syncCookies(request, context = {}): Promise<unknown> {
      await requireBrowser(request.browserId, 'syncCookies', context);
      if (!definition.syncCookies) throw new Error('Provider does not implement cookie sync');
      if (
        !request.scope ||
        typeof request.scope !== 'object' ||
        Array.isArray(request.scope) ||
        !isJsonValue(request.scope)
      ) {
        throw new Error('Cookie sync scope must be a JSON object');
      }
      return definition.syncCookies(request, context);
    },
    async getAccess(request, context = {}): Promise<ProviderAccess> {
      await requireBrowser(request.browserId, 'access', context);
      if (!definition.getAccess) throw new Error('Provider does not expose browser access');
      const access = await definition.getAccess(request, context);
      if (
        !access ||
        typeof access.kind !== 'string' ||
        !access.kind.trim() ||
        typeof access.url !== 'string'
      ) {
        throw new Error('Provider returned an invalid browser access result');
      }
      const url = new URL(access.url);
      const isDevTools =
        access.kind === 'cdp-devtools' &&
        url.protocol === 'devtools:' &&
        url.host === 'devtools' &&
        url.pathname === '/bundled/inspector.html';
      if (
        (!['http:', 'https:'].includes(url.protocol) && !isDevTools) ||
        access.sensitive !== true
      ) {
        throw new Error('Provider returned an invalid browser access result');
      }
      return { ...access, url: url.toString() };
    },
    async configure(options, context = {}): Promise<unknown> {
      assertDeadline(context);
      const configuration = definition.browserType.configuration;
      if (!configuration || !definition.configure) {
        throw new Error('Provider does not support configuration');
      }
      validateProviderInput(configuration.inputSchema, options);
      return definition.configure(options, context);
    },
    async getEnhancementTarget(request, context = {}) {
      assertDeadline(context);
      if (!definition.getEnhancementTarget)
        throw new Error('BROWSER_ENHANCEMENT_TARGET_UNSUPPORTED');
      if (!Number.isSafeInteger(request.tabId) || request.tabId < 0)
        throw new Error('A valid Provider tabId is required');
      const browser = (await listBrowsers(context)).find(
        item => item.browserId === request.browserId,
      );
      if (
        browser?.status !== 'connected' ||
        browser.control.kind !== 'provider' ||
        browser.control.capabilities.controlSessionMode !== 'external'
      )
        throw new Error('BROWSER_ENHANCEMENT_OWNER_UNAVAILABLE');
      assertDeadline(context);
      const target = await definition.getEnhancementTarget(request, context);
      if (!isProviderEnhancementTarget(target) || target.tabId !== request.tabId)
        throw new Error('Invalid Provider enhancement target');
      assertDeadline(context);
      return target.ready
        ? {
            tabId: target.tabId,
            ready: true,
            ...(target.mainFrameId ? { mainFrameId: target.mainFrameId } : {}),
            ...(target.targetId ? { targetId: target.targetId } : {}),
            url: target.url,
            ...(target.initialEnvironment
              ? { initialEnvironment: structuredClone(target.initialEnvironment) }
              : {}),
          }
        : { tabId: target.tabId, ready: false };
    },
    async invokeAction(actionContext): Promise<unknown> {
      const browser = (
        await listBrowsers({
          controlSource: actionContext.controlSource,
          ...(actionContext.deadline !== undefined ? { deadline: actionContext.deadline } : {}),
        })
      ).find(item => item.browserId === actionContext.browserId);
      if (!browser) throw new Error(`Provider browser not found: ${actionContext.browserId}`);
      if (browser.status !== 'connected') {
        throw new Error(`Provider browser ${actionContext.browserId} is not connected`);
      }
      if (browser.control.kind !== 'provider') {
        throw new Error(`Provider browser ${actionContext.browserId} uses host control`);
      }
      if (!browser.control.capabilities.actions.includes(actionContext.action)) {
        throw new Error(
          `Provider browser ${actionContext.browserId} does not support ${actionContext.action}`,
        );
      }
      if (!definition.handleAction) throw new Error('Provider does not implement browser actions');
      assertDeadline(actionContext);
      return definition.handleAction(actionContext);
    },
  };
}
