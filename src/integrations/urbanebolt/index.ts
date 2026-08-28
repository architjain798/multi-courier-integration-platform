import type { CourierDescriptor } from '../../components/couriers/index.js';
import { UrbaneBoltAdapter } from './urbanebolt.adapter.js';
import { UrbaneBoltClient } from './urbanebolt.client.js';
import { loadUrbaneBoltConfig } from './urbanebolt.config.js';
import { COURIER_ID } from './urbanebolt.errors.js';

export const urbaneBoltDescriptor: CourierDescriptor = {
  id: COURIER_ID,
  displayName: 'UrbaneBolt',

  isEnabled(env) {
    return env.URBANEBOLT_ENABLED !== 'false';
  },

  create(env, deps) {
    const config = loadUrbaneBoltConfig(env);
    return new UrbaneBoltAdapter(config, new UrbaneBoltClient(config), deps.logger);
  },
};

export { loadUrbaneBoltConfig } from './urbanebolt.config.js';
export type { UrbaneBoltConfig } from './urbanebolt.config.js';
