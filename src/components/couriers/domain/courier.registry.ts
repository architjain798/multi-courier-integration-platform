import { AppError, ErrorCode } from '../../../libraries/errors/index.js';
import type {
  CourierAdapter,
  CourierCapabilities,
  CourierDescriptor,
  CourierFactoryDependencies,
} from './courier.interface.js';

export type CourierSummary = {
  id: string;
  displayName: string;
  capabilities: CourierCapabilities;
};

export type AdapterDecorator = (adapter: CourierAdapter) => CourierAdapter;

export class CourierRegistry {
  private readonly adapters = new Map<string, CourierAdapter>();
  private readonly summaries = new Map<string, CourierSummary>();

  register(descriptor: CourierDescriptor, adapter: CourierAdapter): void {
    if (this.adapters.has(descriptor.id)) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Courier "${descriptor.id}" is registered twice`,
        { isOperational: false },
      );
    }
    this.adapters.set(descriptor.id, adapter);
    this.summaries.set(descriptor.id, {
      id: descriptor.id,
      displayName: descriptor.displayName,
      capabilities: adapter.capabilities,
    });
  }

  get(id: string): CourierAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new AppError(
        ErrorCode.UNKNOWN_COURIER_PARTNER,
        `Unsupported courier_partner "${id}"`,
        { details: [{ supported: this.ids() }] },
      );
    }
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  list(): CourierSummary[] {
    return this.ids().map((id) => {
      const summary = this.summaries.get(id);
      if (summary === undefined) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, `Missing summary for "${id}"`, {
          isOperational: false,
        });
      }
      return summary;
    });
  }
}

export function buildRegistry(
  descriptors: readonly CourierDescriptor[],
  env: NodeJS.ProcessEnv,
  deps: CourierFactoryDependencies,
  decorate: AdapterDecorator,
): CourierRegistry {
  const registry = new CourierRegistry();

  for (const descriptor of descriptors) {
    if (!descriptor.isEnabled(env)) {
      deps.logger.info({ courier: descriptor.id }, 'Courier disabled by configuration');
      continue;
    }
    registry.register(descriptor, decorate(descriptor.create(env, deps)));
  }

  if (registry.ids().length === 0) {
    throw new AppError(ErrorCode.COURIER_NOT_CONFIGURED, 'No courier partners are enabled', {
      isOperational: false,
    });
  }

  return registry;
}
