import type { PageSession } from './cdp-session.js';

type PageSessionInitializer = (session: PageSession) => Promise<void>;

const initializers: PageSessionInitializer[] = [];

/** Register state that must be reconstructed whenever a daemon attaches to a page target. */
export function registerPageSessionInitializer(initializer: PageSessionInitializer): void {
  initializers.push(initializer);
}

export async function initializePageSession(session: PageSession): Promise<void> {
  for (const initializer of initializers) await initializer(session);
}
