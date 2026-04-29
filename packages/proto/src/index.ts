/**
 * Kafka topic configuration: schemas, partitions, retention.
 *
 * Producer / consumer code in apps/* uses these definitions to
 * stay aligned on event shape and topic naming.
 */
import {
  ShipmentPositionEvent,
  ShipmentFuelEvent,
  PortCongestionEvent,
  WeatherUpdateEvent,
  ShipmentScoreUpdatedEvent,
  KafkaTopic,
} from '@smart-supply/shared-types';

export interface TopicConfig {
  name: string;
  partitions: number;
  retentionMs: number;
  description: string;
}

export const TOPICS = {
  [KafkaTopic.ShipmentPosition]: {
    name: KafkaTopic.ShipmentPosition,
    partitions: 6,
    retentionMs: 24 * 60 * 60 * 1000, // 24h
    description: 'Raw position pings from shipments',
  },
  [KafkaTopic.ShipmentFuel]: {
    name: KafkaTopic.ShipmentFuel,
    partitions: 6,
    retentionMs: 24 * 60 * 60 * 1000,
    description: 'Fuel burn rate and load factor per shipment',
  },
  [KafkaTopic.PortCongestion]: {
    name: KafkaTopic.PortCongestion,
    partitions: 3,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    description: 'Aggregate port queue/wait metrics',
  },
  [KafkaTopic.WeatherUpdate]: {
    name: KafkaTopic.WeatherUpdate,
    partitions: 3,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    description: 'Regional weather conditions',
  },
  [KafkaTopic.ShipmentScoreUpdated]: {
    name: KafkaTopic.ShipmentScoreUpdated,
    partitions: 6,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    description: 'Derived rolling carbon scores per route',
  },
} as const satisfies Record<string, TopicConfig>;

export const TOPIC_VALIDATORS = {
  [KafkaTopic.ShipmentPosition]: ShipmentPositionEvent,
  [KafkaTopic.ShipmentFuel]: ShipmentFuelEvent,
  [KafkaTopic.PortCongestion]: PortCongestionEvent,
  [KafkaTopic.WeatherUpdate]: WeatherUpdateEvent,
  [KafkaTopic.ShipmentScoreUpdated]: ShipmentScoreUpdatedEvent,
} as const;
