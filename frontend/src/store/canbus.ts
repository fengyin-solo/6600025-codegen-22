import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CanFrame, DbcMessage, BusStats, DutyCycleType, DutyCycleSegment, DutyCycleStats, DutyCycleSignalStats } from '../types';
import { parseDbc, decodeCanFrame, DEFAULT_DBC_CONTENT } from '../utils/dbc-parser';

let frameIdCounter = 0;
let segmentIdCounter = 0;

const DUTY_CYCLE_THRESHOLDS = {
  idleSpeedMax: 5,
  idleRpmMax: 1200,
  accelerationSpeedDelta: 1.5,
  accelerationThrottleMin: 25,
  brakingSpeedDelta: -5,
  cruiseSpeedDeltaMax: 1,
  cruiseSpeedMin: 15,
  decelerationSpeedDelta: -1
};

const DUTY_CYCLE_MIN_DURATION_MS = 600;

const DUTY_CYCLE_META: Record<DutyCycleType, { label: string; color: string }> = {
  idle: { label: '怠速', color: '#6b7280' },
  acceleration: { label: '加速', color: '#22c55e' },
  braking: { label: '制动', color: '#ef4444' },
  cruise: { label: '匀速', color: '#06b6d4' },
  deceleration: { label: '减速', color: '#eab308' }
};

const SIGNAL_UNITS: Record<string, string> = {
  EngineRPM: 'rpm',
  VehicleSpeed: 'km/h',
  CoolantTemp: '°C',
  ThrottlePosition: '%',
  EngineLoad: '%'
};

function getSignalUnit(name: string): string {
  return SIGNAL_UNITS[name] ?? '';
}

export const useCanBusStore = defineStore('canbus', () => {
  const frames = ref<CanFrame[]>([]);
  const signals = ref<Map<string, { name: string; data: { time: number; value: number }[] }>>(new Map());
  const dbcMessages = ref<Map<number, DbcMessage>>(new Map());
  const filterId = ref('');
  const filterText = ref('');
  const isCapturing = ref(false);
  const pollInterval = ref<number | null>(null);
  const selectedSegmentId = ref<string | null>(null);
  const selectedDutyCycleType = ref<DutyCycleType | null>(null);

  const busStats = ref<BusStats>({
    totalFrames: 0,
    rxCount: 0,
    txCount: 0,
    errorCount: 0,
    busLoad: 0,
    lastUpdate: Date.now()
  });

  const dutyCycleSegments = ref<DutyCycleSegment[]>([]);
  const currentSegment = ref<DutyCycleSegment | null>(null);
  const pendingCandidate = ref<DutyCycleSegment | null>(null);
  let lastSpeed: number | null = null;
  let lastSpeedTime: number | null = null;

  const filteredFrames = computed(() => {
    let result = frames.value;

    if (filterId.value.trim()) {
      const idFilter = filterId.value.trim().toLowerCase().replace(/^0x/, '');
      result = result.filter(f =>
        f.arbitrationId.toString(16).toLowerCase().includes(idFilter)
      );
    }

    if (filterText.value.trim()) {
      const textFilter = filterText.value.trim().toLowerCase();
      result = result.filter(f => {
        if (f.arbitrationId.toString(16).toLowerCase().includes(textFilter)) return true;
        if (f.data.toLowerCase().includes(textFilter)) return true;
        for (const key of Object.keys(f.decoded)) {
          if (key.toLowerCase().includes(textFilter)) return true;
        }
        return false;
      });
    }

    return result;
  });

  const busLoadPercent = computed(() => {
    return busStats.value.busLoad.toFixed(1);
  });

  const allSegmentsWithCurrent = computed<DutyCycleSegment[]>(() => {
    const list = [...dutyCycleSegments.value];
    const cur = currentSegment.value;
    if (cur && cur.frameCount > 0) {
      list.push(cur);
    }
    return list;
  });

  const filteredDutyCycleSegments = computed(() => {
    const base = allSegmentsWithCurrent.value;
    if (!selectedDutyCycleType.value) return base;
    return base.filter(s => s.type === selectedDutyCycleType.value);
  });

  const dutyCycleStats = computed<DutyCycleStats[]>(() => {
    const statsMap = new Map<DutyCycleType, { count: number; totalDuration: number }>();
    for (const type of Object.keys(DUTY_CYCLE_META) as DutyCycleType[]) {
      statsMap.set(type, { count: 0, totalDuration: 0 });
    }
    for (const seg of allSegmentsWithCurrent.value) {
      const s = statsMap.get(seg.type)!;
      s.count++;
      s.totalDuration += (seg.endTime - seg.startTime);
    }
    return (Object.keys(DUTY_CYCLE_META) as DutyCycleType[]).map(type => {
      const meta = DUTY_CYCLE_META[type];
      const s = statsMap.get(type)!;
      return {
        type,
        label: meta.label,
        color: meta.color,
        count: s.count,
        totalDuration: s.totalDuration,
        avgDuration: s.count > 0 ? s.totalDuration / s.count : 0
      };
    });
  });

  const selectedSegment = computed(() => {
    if (!selectedSegmentId.value) return null;
    return allSegmentsWithCurrent.value.find(s => s.id === selectedSegmentId.value) || null;
  });

  function computeSegmentStats(seg: DutyCycleSegment) {
    for (const sigName of Object.keys(seg.signals)) {
      const sig = seg.signals[sigName];
      if (sig.values.length > 0) {
        const vals = sig.values.map(v => v.value);
        sig.min = Math.min(...vals);
        sig.max = Math.max(...vals);
        sig.avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        sig.count = vals.length;
        const variance = vals.reduce((acc, v) => acc + (v - sig.avg) * (v - sig.avg), 0) / vals.length;
        sig.std = Math.sqrt(variance);
      }
    }
  }

  function detectDutyCycle(speed: number, rpm: number, throttle: number | undefined, timestamp: number): DutyCycleType {
    if (speed <= DUTY_CYCLE_THRESHOLDS.idleSpeedMax && rpm <= DUTY_CYCLE_THRESHOLDS.idleRpmMax) {
      return 'idle';
    }
    if (lastSpeed !== null && lastSpeedTime !== null) {
      const dt = Math.max(1, timestamp - lastSpeedTime);
      const speedDeltaPerSec = ((speed - lastSpeed) / dt) * 1000;
      if (speedDeltaPerSec <= DUTY_CYCLE_THRESHOLDS.brakingSpeedDelta) {
        return 'braking';
      }
      if (speedDeltaPerSec >= DUTY_CYCLE_THRESHOLDS.accelerationSpeedDelta &&
          throttle !== undefined && throttle >= DUTY_CYCLE_THRESHOLDS.accelerationThrottleMin) {
        return 'acceleration';
      }
      if (speed >= DUTY_CYCLE_THRESHOLDS.cruiseSpeedMin &&
          Math.abs(speedDeltaPerSec) <= DUTY_CYCLE_THRESHOLDS.cruiseSpeedDeltaMax) {
        return 'cruise';
      }
      if (speedDeltaPerSec <= DUTY_CYCLE_THRESHOLDS.decelerationSpeedDelta) {
        return 'deceleration';
      }
    }
    return speed <= DUTY_CYCLE_THRESHOLDS.idleSpeedMax ? 'idle' : 'cruise';
  }

  function appendFrameToSegment(seg: DutyCycleSegment, frame: CanFrame) {
    seg.endTime = frame.timestamp;
    seg.frameCount++;
    for (const [name, value] of Object.entries(frame.decoded)) {
      if (!seg.signals[name]) {
        seg.signals[name] = {
          min: value,
          max: value,
          avg: value,
          std: 0,
          count: 0,
          unit: getSignalUnit(name),
          values: []
        };
      }
      const sig = seg.signals[name];
      sig.values.push({ time: frame.timestamp, value });
      sig.count = sig.values.length;
      if (sig.values.length > 500) {
        sig.values = sig.values.slice(-500);
        sig.count = sig.values.length;
      }
    }
  }

  function createNewSegment(type: DutyCycleType, timestamp: number): DutyCycleSegment {
    return {
      id: `seg-${++segmentIdCounter}`,
      type,
      startTime: timestamp,
      endTime: timestamp,
      frameCount: 0,
      signals: {}
    };
  }

  function commitSegment(seg: DutyCycleSegment | null) {
    if (!seg || seg.frameCount === 0) return;
    computeSegmentStats(seg);
    dutyCycleSegments.value.push(seg);
    if (dutyCycleSegments.value.length > 200) {
      dutyCycleSegments.value = dutyCycleSegments.value.slice(-200);
    }
  }

  function updateDutyCycleAnalysis(frame: CanFrame) {
    const speed = frame.decoded.VehicleSpeed;
    const rpm = frame.decoded.EngineRPM;
    const throttle = frame.decoded.ThrottlePosition;

    if (speed === undefined || rpm === undefined) {
      lastSpeed = null;
      lastSpeedTime = null;
      return;
    }

    const detectedType = detectDutyCycle(speed, rpm, throttle, frame.timestamp);

    const cur = currentSegment.value;
    if (!cur) {
      currentSegment.value = createNewSegment(detectedType, frame.timestamp);
      pendingCandidate.value = null;
    } else if (cur.type === detectedType) {
      pendingCandidate.value = null;
    } else {
      let candidate = pendingCandidate.value;
      if (!candidate || candidate.type !== detectedType) {
        candidate = createNewSegment(detectedType, frame.timestamp);
        pendingCandidate.value = candidate;
      } else {
        candidate.endTime = frame.timestamp;
      }
      const elapsed = candidate.endTime - candidate.startTime;
      if (elapsed >= DUTY_CYCLE_MIN_DURATION_MS) {
        commitSegment(cur);
        currentSegment.value = candidate;
        pendingCandidate.value = null;
      }
    }

    const active = currentSegment.value!;
    appendFrameToSegment(active, frame);
    const candidate = pendingCandidate.value;
    if (candidate && candidate !== active) {
      appendFrameToSegment(candidate, frame);
    }
    computeSegmentStats(active);
    currentSegment.value = { ...active };

    lastSpeed = speed;
    lastSpeedTime = frame.timestamp;
  }

  function selectSegment(id: string | null) {
    selectedSegmentId.value = id;
  }

  function filterByDutyCycleType(type: DutyCycleType | null) {
    selectedDutyCycleType.value = type;
    selectedSegmentId.value = null;
  }

  function clearDutyCycleAnalysis() {
    dutyCycleSegments.value = [];
    currentSegment.value = null;
    pendingCandidate.value = null;
    lastSpeed = null;
    lastSpeedTime = null;
    selectedSegmentId.value = null;
    selectedDutyCycleType.value = null;
    segmentIdCounter = 0;
  }

  function getDutyCycleMeta(type: DutyCycleType) {
    return DUTY_CYCLE_META[type];
  }

  function addFrame(frame: CanFrame) {
    frames.value.push(frame);
    if (frames.value.length > 500) {
      frames.value = frames.value.slice(-500);
    }

    busStats.value.totalFrames++;
    if (frame.direction === 'RX') busStats.value.rxCount++;
    else busStats.value.txCount++;
    busStats.value.lastUpdate = Date.now();

    // Decode frame FIRST so duty-cycle analysis can read decoded signals
    const msgDef = dbcMessages.value.get(frame.arbitrationId);
    if (msgDef) {
      if (Object.keys(frame.decoded).length === 0) {
        frame.decoded = decodeCanFrame(frame, msgDef);
      }
      for (const [name, value] of Object.entries(frame.decoded)) {
        if (!signals.value.has(name)) {
          signals.value.set(name, { name, data: [] });
        }
        const sig = signals.value.get(name)!;
        sig.data.push({ time: frame.timestamp, value });
        if (sig.data.length > 100) {
          sig.data = sig.data.slice(-100);
        }
      }
    }

    updateDutyCycleAnalysis(frame);

    // Simulate bus load (random 15-45%)
    busStats.value.busLoad = 15 + Math.random() * 30;
  }

  function clearFrames() {
    frames.value = [];
    signals.value = new Map();
    busStats.value = {
      totalFrames: 0,
      rxCount: 0,
      txCount: 0,
      errorCount: 0,
      busLoad: 0,
      lastUpdate: Date.now()
    };
    frameIdCounter = 0;
    clearDutyCycleAnalysis();
    resetMockState();
  }

  function loadMockDbc() {
    parseAndLoadDbc(DEFAULT_DBC_CONTENT);
  }

  function parseAndLoadDbc(text: string) {
    dbcMessages.value = parseDbc(text);
  }

  const mockDrivingState = ref({
    phase: 'idle' as 'idle' | 'accelerate' | 'cruise' | 'decelerate' | 'brake',
    phaseStartTime: Date.now(),
    currentSpeed: 0,
    currentRpm: 800,
    currentThrottle: 0,
    currentLoad: 10,
    coolantTemp: 75,
    frameCount: 0
  });

  const PHASE_DURATIONS = {
    idle: { min: 30, max: 60 },
    accelerate: { min: 20, max: 40 },
    cruise: { min: 40, max: 80 },
    decelerate: { min: 15, max: 30 },
    brake: { min: 10, max: 20 }
  };

  function resetMockState() {
    mockDrivingState.value = {
      phase: 'idle',
      phaseStartTime: Date.now(),
      currentSpeed: 0,
      currentRpm: 800,
      currentThrottle: 0,
      currentLoad: 10,
      coolantTemp: 75,
      frameCount: 0
    };
  }

  function shouldTransitionPhase(): boolean {
    const durations = PHASE_DURATIONS[mockDrivingState.value.phase];
    const elapsedFrames = mockDrivingState.value.frameCount;
    const minFrames = durations.min;
    const maxFrames = durations.max;
    if (elapsedFrames < minFrames) return false;
    if (elapsedFrames >= maxFrames) return true;
    return Math.random() < 0.15;
  }

  function getNextPhase(): 'idle' | 'accelerate' | 'cruise' | 'decelerate' | 'brake' {
    const s = mockDrivingState.value;
    switch (s.phase) {
      case 'idle':
        return 'accelerate';
      case 'accelerate':
        return Math.random() < 0.7 ? 'cruise' : 'decelerate';
      case 'cruise':
        return Math.random() < 0.5 ? 'decelerate' : 'accelerate';
      case 'decelerate':
        if (s.currentSpeed <= 5) return 'idle';
        return Math.random() < 0.6 ? 'brake' : 'cruise';
      case 'brake':
        return s.currentSpeed <= 3 ? 'idle' : 'decelerate';
      default:
        return 'idle';
    }
  }

  function generateMockFrame(): CanFrame {
    const s = mockDrivingState.value;
    s.frameCount++;

    if (shouldTransitionPhase()) {
      s.phase = getNextPhase();
      s.phaseStartTime = Date.now();
      s.frameCount = 0;
    }

    switch (s.phase) {
      case 'idle':
        s.currentSpeed = Math.max(0, s.currentSpeed + (Math.random() - 0.6) * 0.3);
        s.currentRpm = 800 + Math.random() * 150;
        s.currentThrottle = Math.random() * 5;
        s.currentLoad = 8 + Math.random() * 8;
        break;
      case 'accelerate':
        s.currentSpeed = Math.min(120, s.currentSpeed + 1.5 + Math.random() * 1.5);
        s.currentRpm = Math.min(6000, s.currentRpm + 80 + Math.random() * 60);
        s.currentThrottle = 50 + Math.random() * 45;
        s.currentLoad = 60 + Math.random() * 35;
        break;
      case 'cruise':
        s.currentSpeed = s.currentSpeed + (Math.random() - 0.5) * 0.8;
        s.currentRpm = Math.max(1500, Math.min(3000, s.currentSpeed * 30 + (Math.random() - 0.5) * 200));
        s.currentThrottle = 20 + Math.random() * 20;
        s.currentLoad = 30 + Math.random() * 25;
        break;
      case 'decelerate':
        s.currentSpeed = Math.max(0, s.currentSpeed - 0.25 - Math.random() * 0.3);
        s.currentRpm = Math.max(800, s.currentRpm - 20 - Math.random() * 30);
        s.currentThrottle = Math.random() * 10;
        s.currentLoad = 15 + Math.random() * 15;
        break;
      case 'brake':
        s.currentSpeed = Math.max(0, s.currentSpeed - 3 - Math.random() * 2);
        s.currentRpm = Math.max(800, s.currentRpm - 150 - Math.random() * 100);
        s.currentThrottle = 0;
        s.currentLoad = 5 + Math.random() * 10;
        break;
    }

    s.coolantTemp = Math.min(110, s.coolantTemp + (Math.random() - 0.4) * 0.2);

    const rpm = Math.round(s.currentRpm);
    const speed = s.currentSpeed;
    const temp = Math.round(s.coolantTemp);
    const throttle = Math.round(s.currentThrottle);
    const load = Math.round(s.currentLoad);

    const messageIds = Array.from(dbcMessages.value.keys());
    const arbId = messageIds.length > 0
      ? messageIds[Math.floor(Math.random() * messageIds.length)]
      : 0x7DF;

    const msgDef = dbcMessages.value.get(arbId);

    const rpmRaw = Math.round(rpm / 0.25);
    const rpmLow = rpmRaw & 0xFF;
    const rpmHigh = (rpmRaw >> 8) & 0xFF;
    const speedByte = speed & 0xFF;
    const tempByte = (temp + 40) & 0xFF;
    const throttleByte = Math.round(throttle / 0.392) & 0xFF;
    const loadByte = Math.round(load / 0.392) & 0xFF;

    const dataBytes = [rpmLow, rpmHigh, speedByte, tempByte, throttleByte, loadByte, 0x00, 0x00];
    const dataHex = dataBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

    const frame: CanFrame = {
      id: `frame-${++frameIdCounter}`,
      timestamp: Date.now(),
      arbitrationId: arbId,
      dlc: 8,
      data: dataHex,
      decoded: {},
      direction: Math.random() > 0.3 ? 'RX' : 'TX'
    };

    if (msgDef) {
      frame.decoded = {
        EngineRPM: rpm,
        VehicleSpeed: speed,
        CoolantTemp: temp,
        ThrottlePosition: throttle,
        EngineLoad: load
      };
    }

    return frame;
  }

  function startCapture() {
    if (isCapturing.value) return;
    isCapturing.value = true;

    // Load mock DBC if not loaded
    if (dbcMessages.value.size === 0) {
      loadMockDbc();
    }

    pollInterval.value = window.setInterval(() => {
      const frame = generateMockFrame();
      addFrame(frame);
    }, 200);
  }

  function stopCapture() {
    isCapturing.value = false;
    if (pollInterval.value !== null) {
      clearInterval(pollInterval.value);
      pollInterval.value = null;
    }
    commitSegment(currentSegment.value);
    currentSegment.value = null;
    pendingCandidate.value = null;
    lastSpeed = null;
    lastSpeedTime = null;
  }

  function decodeFrame(frame: CanFrame): Record<string, number> {
    const msgDef = dbcMessages.value.get(frame.arbitrationId);
    if (!msgDef) return {};
    return decodeCanFrame(frame, msgDef);
  }

  function exportFrames(): string {
    const header = 'Timestamp,Direction,CAN_ID,DLC,Data,Decoded\n';
    const rows = frames.value.map(f => {
      const decodedStr = Object.entries(f.decoded)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return `${f.timestamp},${f.direction},0x${f.arbitrationId.toString(16).toUpperCase()},${f.dlc},"${f.data}","${decodedStr}"`;
    }).join('\n');
    return header + rows;
  }

  return {
    frames,
    signals,
    dbcMessages,
    filterId,
    filterText,
    busStats,
    isCapturing,
    filteredFrames,
    busLoadPercent,
    dutyCycleSegments,
    allSegmentsWithCurrent,
    filteredDutyCycleSegments,
    dutyCycleStats,
    selectedSegment,
    selectedSegmentId,
    selectedDutyCycleType,
    addFrame,
    clearFrames,
    loadMockDbc,
    parseAndLoadDbc,
    startCapture,
    stopCapture,
    decodeFrame,
    exportFrames,
    selectSegment,
    filterByDutyCycleType,
    getDutyCycleMeta
  };
});
