import { mountPopup } from './bootstrap';

void mountPopup().catch(error => console.error('[Popup] Failed to load application:', error));
