/**
 * Static reference data used by the seed.
 *
 * Carbon factors are illustrative (kg CO2e per ton-km) calibrated against
 * commonly-cited freight emission ranges. These are not authoritative -
 * a production system would source EPA SmartWay / GLEC factors.
 */

export interface CountryProfile {
  code: string;
  name: string;
  // Grid carbon intensity proxy (g CO2 / kWh) - influences supplier baseline.
  gridIntensity: number;
}

export const COUNTRIES: readonly CountryProfile[] = [
  { code: 'US', name: 'United States', gridIntensity: 386 },
  { code: 'CA', name: 'Canada', gridIntensity: 130 },
  { code: 'MX', name: 'Mexico', gridIntensity: 423 },
  { code: 'BR', name: 'Brazil', gridIntensity: 90 },
  { code: 'GB', name: 'United Kingdom', gridIntensity: 233 },
  { code: 'DE', name: 'Germany', gridIntensity: 380 },
  { code: 'FR', name: 'France', gridIntensity: 56 },
  { code: 'NL', name: 'Netherlands', gridIntensity: 350 },
  { code: 'IT', name: 'Italy', gridIntensity: 295 },
  { code: 'ES', name: 'Spain', gridIntensity: 168 },
  { code: 'PL', name: 'Poland', gridIntensity: 720 },
  { code: 'SE', name: 'Sweden', gridIntensity: 41 },
  { code: 'NO', name: 'Norway', gridIntensity: 30 },
  { code: 'CN', name: 'China', gridIntensity: 581 },
  { code: 'JP', name: 'Japan', gridIntensity: 462 },
  { code: 'KR', name: 'South Korea', gridIntensity: 442 },
  { code: 'IN', name: 'India', gridIntensity: 713 },
  { code: 'VN', name: 'Vietnam', gridIntensity: 463 },
  { code: 'TH', name: 'Thailand', gridIntensity: 451 },
  { code: 'ID', name: 'Indonesia', gridIntensity: 760 },
  { code: 'AU', name: 'Australia', gridIntensity: 549 },
  { code: 'AE', name: 'United Arab Emirates', gridIntensity: 478 },
  { code: 'TR', name: 'Turkey', gridIntensity: 440 },
  { code: 'ZA', name: 'South Africa', gridIntensity: 877 },
  { code: 'EG', name: 'Egypt', gridIntensity: 482 },
] as const;

export interface HubSeed {
  name: string;
  country: string;
  type: 'port' | 'airport' | 'rail' | 'warehouse';
  lat: number;
  lng: number;
}

// Major freight hubs across global trade corridors.
export const HUBS: readonly HubSeed[] = [
  // Asia-Pacific
  { name: 'Shanghai Port', country: 'CN', type: 'port', lat: 31.2304, lng: 121.4737 },
  { name: 'Shenzhen Port', country: 'CN', type: 'port', lat: 22.5431, lng: 114.0579 },
  { name: 'Ningbo Port', country: 'CN', type: 'port', lat: 29.8683, lng: 121.544 },
  { name: 'Hong Kong Port', country: 'CN', type: 'port', lat: 22.3193, lng: 114.1694 },
  { name: 'Busan Port', country: 'KR', type: 'port', lat: 35.1796, lng: 129.0756 },
  { name: 'Tokyo Port', country: 'JP', type: 'port', lat: 35.6528, lng: 139.7595 },
  { name: 'Yokohama Port', country: 'JP', type: 'port', lat: 35.4437, lng: 139.638 },
  { name: 'Singapore Port', country: 'ID', type: 'port', lat: 1.2644, lng: 103.8222 },
  { name: 'Tanjung Priok', country: 'ID', type: 'port', lat: -6.1045, lng: 106.8806 },
  { name: 'Laem Chabang', country: 'TH', type: 'port', lat: 13.0827, lng: 100.8836 },
  { name: 'Mumbai Port', country: 'IN', type: 'port', lat: 18.948, lng: 72.844 },
  { name: 'Chennai Port', country: 'IN', type: 'port', lat: 13.1067, lng: 80.2961 },
  { name: 'Cat Lai Port', country: 'VN', type: 'port', lat: 10.7782, lng: 106.7784 },
  // Europe
  { name: 'Rotterdam Port', country: 'NL', type: 'port', lat: 51.9244, lng: 4.4777 },
  { name: 'Antwerp Port', country: 'NL', type: 'port', lat: 51.2603, lng: 4.4019 },
  { name: 'Hamburg Port', country: 'DE', type: 'port', lat: 53.5511, lng: 9.9937 },
  { name: 'Felixstowe Port', country: 'GB', type: 'port', lat: 51.9542, lng: 1.3464 },
  { name: 'Le Havre Port', country: 'FR', type: 'port', lat: 49.4944, lng: 0.1079 },
  { name: 'Algeciras Port', country: 'ES', type: 'port', lat: 36.1408, lng: -5.4536 },
  { name: 'Gioia Tauro', country: 'IT', type: 'port', lat: 38.4406, lng: 15.8842 },
  // Americas
  { name: 'Los Angeles Port', country: 'US', type: 'port', lat: 33.7395, lng: -118.262 },
  { name: 'Long Beach Port', country: 'US', type: 'port', lat: 33.7701, lng: -118.1937 },
  { name: 'New York / NJ Port', country: 'US', type: 'port', lat: 40.6595, lng: -74.0455 },
  { name: 'Savannah Port', country: 'US', type: 'port', lat: 32.0809, lng: -81.0912 },
  { name: 'Vancouver Port', country: 'CA', type: 'port', lat: 49.2827, lng: -123.1207 },
  { name: 'Manzanillo Port', country: 'MX', type: 'port', lat: 19.0518, lng: -104.3158 },
  { name: 'Santos Port', country: 'BR', type: 'port', lat: -23.961, lng: -46.3336 },
  // MENA / Africa / Oceania
  { name: 'Jebel Ali Port', country: 'AE', type: 'port', lat: 25.013, lng: 55.061 },
  { name: 'Durban Port', country: 'ZA', type: 'port', lat: -29.8587, lng: 31.0218 },
  { name: 'Sydney Port', country: 'AU', type: 'port', lat: -33.8688, lng: 151.2093 },
] as const;

// Approximate emission factors (kg CO2e per ton-km).
// These are baseline; the ML stack adjusts per-trip with real conditions.
export const TRANSPORT_MODE_FACTORS = {
  sea: 0.011,
  rail: 0.022,
  road: 0.062,
  air: 0.602,
  multimodal: 0.045,
} as const;

export type TransportMode = keyof typeof TRANSPORT_MODE_FACTORS;

export const SUPPLIER_NAME_PARTS = {
  prefixes: [
    'Atlas',
    'Nordic',
    'Pacific',
    'Continental',
    'Meridian',
    'Sterling',
    'Vanguard',
    'Apex',
    'Global',
    'United',
    'Imperial',
    'Pioneer',
    'Cascade',
    'Summit',
    'Heritage',
    'Premier',
    'Horizon',
  ],
  suffixes: [
    'Logistics',
    'Industries',
    'Manufacturing',
    'Trading',
    'Group',
    'Materials',
    'Components',
    'Supply Co',
    'Holdings',
    'Partners',
    'Works',
  ],
} as const;
