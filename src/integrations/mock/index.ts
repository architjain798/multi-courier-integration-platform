import type { CourierDescriptor } from '../../components/couriers/index.js';
import { MockCourierAdapter, MOCK_COURIER_ID } from './mock.adapter.js';
import { loadMockCourierConfig } from './mock.config.js';

export const mockCourierDescriptor: CourierDescriptor = {
  id: MOCK_COURIER_ID,
  displayName: 'Mock Courier',

  isEnabled(env) {
    return env.MOCK_ENABLED === 'true';
  },

  create(env) {
    return new MockCourierAdapter(loadMockCourierConfig(env));
  },
};

export { MockCourierAdapter, MOCK_COURIER_ID } from './mock.adapter.js';
export type { MockCourierConfig } from './mock.adapter.js';
