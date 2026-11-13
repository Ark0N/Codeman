/** @fileoverview Owner-scoped tab-layout capabilities exposed to route modules. */
import type { TabLayoutService } from '../../tab-layout-service.js';

export interface TabLayoutPort {
  readonly tabLayouts: TabLayoutService;
}
