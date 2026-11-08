import { expect, it } from 'vitest';
import { detectRequestEnvironment } from '../utils/requestEnvironment';
it('shows only the installed protocol annotation and never infers deployment from host names', () => {
  expect(detectRequestEnvironment('https://pre.api.example.test/x')).toEqual({ environment: 'unknown', host: 'pre.api.example.test' });
  expect(detectRequestEnvironment('https://api.example.test/x', 'pre')).toEqual({ environment: 'pre', host: 'api.example.test' });
  expect(detectRequestEnvironment('https://api.example.test/x', 'qa-east.2')).toEqual({ environment: 'qa-east.2', host: 'api.example.test' });
  expect(detectRequestEnvironment('invalid', 'prod')).toEqual({ environment: 'unknown', host: '' });
});
