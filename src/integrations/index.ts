import type { CourierDescriptor } from '../components/couriers/index.js';
import { mockCourierDescriptor } from './mock/index.js';
import { urbaneBoltDescriptor } from './urbanebolt/index.js';

export const COURIER_DESCRIPTORS: readonly CourierDescriptor[] = [
  urbaneBoltDescriptor,
  mockCourierDescriptor,
];
