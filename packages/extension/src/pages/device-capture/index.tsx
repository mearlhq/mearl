import { createRoot } from 'react-dom/client';
import { DeviceCapture } from './DeviceCapture';
import { initAnalytics } from '../../shared/analytics';
import '../../global.css';
import '../../shared/fontSize';

initAnalytics('device_capture');

const container = document.getElementById('app-container');
const root = createRoot(container!);

root.render(<DeviceCapture />);
