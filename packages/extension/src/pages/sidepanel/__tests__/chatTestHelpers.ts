import type { AgentChatEvent } from '@mearl/browser-core';
import { toCompactChatCards } from '../compactMessages';

export function chatMessages(events: AgentChatEvent[]) {
  return toCompactChatCards(events).map(({ role, message }) => ({ role, message }));
}
