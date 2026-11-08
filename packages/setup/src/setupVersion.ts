import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const SETUP_VERSION: string = (require('../package.json') as { version: string }).version;

export const SETUP_COMMAND = `npx @mearl/setup${SETUP_VERSION.includes('-beta.') ? '@beta' : ''}`;
