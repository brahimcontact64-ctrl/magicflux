import type { PlatformConnector } from './types';
import { woocommerceConnector } from './woocommerce/connector';

/**
 * The one place a future adapter (Shopify, Framer, Webflow, Wix) is
 * registered. The receiver route, the connect route, and any future
 * Connect UI all resolve a connector by platform name through this
 * function -- never by importing a specific adapter module directly.
 */
const CONNECTORS: Readonly<Record<string, PlatformConnector>> = {
  woocommerce: woocommerceConnector,
};

export function getConnector(platform: string): PlatformConnector | null {
  return CONNECTORS[platform] ?? null;
}

export function listConnectorPlatforms(): string[] {
  return Object.keys(CONNECTORS);
}
