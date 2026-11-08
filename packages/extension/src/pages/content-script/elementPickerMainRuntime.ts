import { installComponentOverlay } from './injected/componentOverlay';
import { installSourceTracer } from './injected/sourceTracer';

(function () {
  if (window.__mearlElementPickerMainRuntime) return;
  installSourceTracer();
  installComponentOverlay();
  window.__mearlElementPickerMainRuntime = true;
})();
