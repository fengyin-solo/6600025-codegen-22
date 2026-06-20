export interface CanFrame {
  id: string;
  timestamp: number;
  arbitrationId: number;
  dlc: number;
  data: string;
  decoded: Record<string, number>;
  direction: 'RX' | 'TX';
}

export interface DbcSignal {
  name: string;
  startBit: number;
  bitLength: number;
  factor: number;
  offset: number;
  unit: string;
  minValue: number;
  maxValue: number;
  messageId: number;
}

export interface DbcMessage {
  id: number;
  name: string;
  dlc: number;
  sender: string;
  signals: DbcSignal[];
}

export interface BusStats {
  totalFrames: number;
  rxCount: number;
  txCount: number;
  errorCount: number;
  busLoad: number;
  lastUpdate: number;
}

export type DutyCycleType = 'idle' | 'acceleration' | 'braking' | 'cruise' | 'deceleration';

export interface DutyCycleSegment {
  id: string;
  type: DutyCycleType;
  startTime: number;
  endTime: number;
  frameCount: number;
  signals: Record<string, { min: number; max: number; avg: number; values: { time: number; value: number }[]>;
}

export interface DutyCycleStats {
  type: DutyCycleType;
  label: string;
  color: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
}
