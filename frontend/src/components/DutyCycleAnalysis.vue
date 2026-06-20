<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent
} from 'echarts/components';
import { useCanBusStore } from '../store/canbus';
import type { DutyCycleType } from '../types';

use([CanvasRenderer, LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent]);

const store = useCanBusStore();
const selectedSignal = ref<string>('VehicleSpeed');

const availableSignals = computed(() => {
  const sigs = new Set<string>();
  for (const seg of store.dutyCycleSegments) {
    for (const name of Object.keys(seg.signals)) {
      sigs.add(name);
    }
  }
  return Array.from(sigs);
});

watch(availableSignals, (sigs) => {
  if (sigs.length > 0 && !sigs.includes(selectedSignal.value)) {
    selectedSignal.value = sigs[0];
  }
}, { immediate: true });

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m${secs}s`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function handleSelectSegment(id: string) {
  store.selectSegment(store.selectedSegmentId === id ? null : id);
}

function handleFilterByType(type: DutyCycleType | null) {
  store.filterByDutyCycleType(store.selectedDutyCycleType === type ? null : type);
}

const segmentChartOption = computed(() => {
  const segments = store.filteredDutyCycleSegments;
  if (segments.length === 0) {
    return { backgroundColor: '#111827' };
  }

  const yAxisCategories: string[] = [];
  const seriesData: any[] = [];

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const meta = store.getDutyCycleMeta(seg.type);
    const yIndex = segments.length - 1 - i;
    yAxisCategories.push(`${meta.label} #${i + 1}`);
    seriesData.push({
      value: [seg.startTime, yIndex, seg.endTime - seg.startTime],
      itemStyle: { color: meta.color },
      segmentId: seg.id
    });
  }

  return {
    backgroundColor: '#111827',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1f2937',
      borderColor: '#374151',
      textStyle: { color: '#e5e7eb', fontSize: 12 },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const p = params[0];
        const seg = segments.find((s: any) => s.id === p.data.segmentId);
        if (!seg) return '';
        const meta = store.getDutyCycleMeta(seg.type);
        const duration = (seg.endTime - seg.startTime) / 1000;
        const signalInfo = Object.entries(seg.signals)
          .map(([k, v]: [string, any]) => `${k}: ${v.avg.toFixed(1)}`)
          .join('<br/>');
        return `
          <div style="font-weight:bold;color:${meta.color}">${meta.label}</div>
          <div style="font-size:11px;color:#9ca3af">${formatTime(seg.startTime)} - ${formatTime(seg.endTime)}</div>
          <div>持续: ${duration.toFixed(1)}s | 帧数: ${seg.frameCount}</div>
          <div style="margin-top:4px;border-top:1px solid #374151;padding-top:4px">
            ${signalInfo}
          </div>
        `;
      }
    },
    grid: {
      left: 90,
      right: 20,
      top: 20,
      bottom: 40
    },
    xAxis: {
      type: 'time',
      axisLabel: {
        color: '#6b7280',
        fontSize: 10,
        formatter: (val: number) => formatTime(val)
      },
      axisLine: { lineStyle: { color: '#374151' } },
      splitLine: { lineStyle: { color: '#1f2937' } }
    },
    yAxis: {
      type: 'category',
      data: yAxisCategories,
      axisLabel: { color: '#9ca3af', fontSize: 10 },
      axisLine: { lineStyle: { color: '#374151' } },
      splitLine: { show: false }
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        start: 0,
        end: 100
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        start: 0,
        end: 100,
        height: 20,
        bottom: 5,
        borderColor: '#374151',
        backgroundColor: '#1f2937',
        fillerColor: 'rgba(6, 182, 212, 0.2)',
        handleStyle: { color: '#06b6d4' },
        textStyle: { color: '#6b7280' }
      }
    ],
    series: [{
      type: 'custom',
      renderItem: (params: any, api: any) => {
        const categoryIndex = api.value(1);
        const start = api.coord([api.value(0), categoryIndex]);
        const end = api.coord([api.value(0) + api.value(2), categoryIndex]);
        const height = api.size([0, 1])[1] * 0.6;
        const rectShape = {
          x: start[0],
          y: start[1] - height / 2,
          width: Math.max(end[0] - start[0], 2),
          height: height
        };
        return {
          type: 'rect',
          shape: rectShape,
          style: api.style()
        };
      },
      encode: {
        x: [0, 2],
        y: 1
      },
      data: seriesData
    }]
  };
});

const signalComparisonOption = computed(() => {
  const segments = store.selectedDutyCycleType
    ? store.dutyCycleSegments.filter(s => s.type === store.selectedDutyCycleType)
    : store.dutyCycleSegments;

  if (segments.length === 0) {
    return { backgroundColor: '#111827' };
  }

  const colors = ['#06b6d4', '#22c55e', '#ef4444', '#eab308', '#a855f7', '#f97316'];
  const series = segments.slice(-10).map((seg, idx) => {
    const meta = store.getDutyCycleMeta(seg.type);
    const sigData = seg.signals[selectedSignal.value];
    if (!sigData) return null;
    const startTime = sigData.values[0]?.time || 0;
    return {
      name: `${meta.label} #${store.dutyCycleSegments.indexOf(seg) + 1}`,
      type: 'line' as const,
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2, color: meta.color },
      itemStyle: { color: meta.color },
      data: sigData.values.map(d => [(d.time - startTime) / 1000, d.value]),
      opacity: store.selectedSegmentId && seg.id !== store.selectedSegmentId ? 0.3 : 1
    };
  }).filter(Boolean);

  return {
    backgroundColor: '#111827',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1f2937',
      borderColor: '#374151',
      textStyle: { color: '#e5e7eb', fontSize: 12 },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        let html = `<div style="font-size:11px;color:#9ca3af">${selectedSignal.value} @ ${Number(params[0].value[0]).toFixed(1)}s</div>`;
        for (const p of params) {
          html += `<div style="display:flex;align-items:center;gap:6px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
            <span>${p.seriesName}: <b>${Number(p.value[1]).toFixed(1)}</b></span>
          </div>`;
        }
        return html;
      }
    },
    legend: {
      top: 5,
      right: 10,
      textStyle: { color: '#9ca3af', fontSize: 10 },
      itemWidth: 12,
      itemHeight: 2
    },
    grid: {
      left: 50,
      right: 20,
      top: 40,
      bottom: 30
    },
    xAxis: {
      type: 'value',
      name: '时间 (s)',
      nameTextStyle: { color: '#6b7280', fontSize: 10 },
      axisLabel: { color: '#6b7280', fontSize: 10 },
      axisLine: { lineStyle: { color: '#374151' } },
      splitLine: { lineStyle: { color: '#1f2937' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#6b7280', fontSize: 10 },
      axisLine: { lineStyle: { color: '#374151' } },
      splitLine: { lineStyle: { color: '#1f2937' } }
    },
    series
  };
});

const statsChartOption = computed(() => {
  const stats = store.dutyCycleStats;
  return {
    backgroundColor: '#111827',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1f2937',
      borderColor: '#374151',
      textStyle: { color: '#e5e7eb', fontSize: 12 },
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const p = params[0];
        const stat = stats.find(s => s.label === p.name);
        if (!stat) return '';
        return `
          <div style="font-weight:bold;color:${stat.color}">${stat.label}</div>
          <div>段数: ${stat.count}</div>
          <div>总时长: ${formatDuration(stat.totalDuration)}</div>
          <div>平均时长: ${formatDuration(stat.avgDuration)}</div>
        `;
      }
    },
    grid: {
      left: 50,
      right: 20,
      top: 20,
      bottom: 25
    },
    xAxis: {
      type: 'category',
      data: stats.map(s => s.label),
      axisLabel: { color: '#9ca3af', fontSize: 11 },
      axisLine: { lineStyle: { color: '#374151' } }
    },
    yAxis: {
      type: 'value',
      name: '段数',
      nameTextStyle: { color: '#6b7280', fontSize: 10 },
      axisLabel: { color: '#6b7280', fontSize: 10 },
      axisLine: { lineStyle: { color: '#374151' } },
      splitLine: { lineStyle: { color: '#1f2937' } }
    },
    series: [{
      type: 'bar',
      data: stats.map(s => ({
        value: s.count,
        itemStyle: { color: s.color }
      })),
      barWidth: '50%'
    }]
  };
});
</script>

<template>
  <div class="flex flex-col h-full bg-gray-900 rounded-lg overflow-hidden">
    <div class="px-4 py-2 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-300">工况切片分析</h3>
      <span class="text-xs text-gray-500">
        {{ store.dutyCycleSegments.length }} 个切片
      </span>
    </div>

    <div class="flex-1 overflow-auto p-3 space-y-3">
      <div class="grid grid-cols-5 gap-2">
        <button
          v-for="stat in store.dutyCycleStats"
          :key="stat.type"
          @click="handleFilterByType(stat.type)"
          class="p-2 rounded-lg border transition-all text-left"
          :class="[
            store.selectedDutyCycleType === stat.type
              ? 'bg-gray-700 border-gray-500'
              : 'bg-gray-800 border-gray-700 hover:bg-gray-700/50'
          ]"
        >
          <div class="flex items-center gap-1.5 mb-1">
            <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: stat.color }"></span>
            <span class="text-xs font-medium text-gray-300">{{ stat.label }}</span>
          </div>
          <div class="text-lg font-bold text-gray-100">{{ stat.count }}</div>
          <div class="text-xs text-gray-500">{{ formatDuration(stat.totalDuration) }}</div>
        </button>
      </div>

      <div v-if="store.selectedDutyCycleType" class="flex items-center justify-between">
        <span class="text-xs text-gray-400">
          已筛选: <span class="text-cyan-400">{{ store.getDutyCycleMeta(store.selectedDutyCycleType).label }}</span>
        </span>
        <button
          @click="handleFilterByType(null)"
          class="text-xs text-gray-400 hover:text-cyan-400 transition-colors"
        >
          清除筛选
        </button>
      </div>

      <div class="bg-gray-800 rounded-lg p-2 border border-gray-700">
        <div class="flex items-center justify-between mb-2 px-1">
          <span class="text-xs font-medium text-gray-400">工况分布统计</span>
        </div>
        <div class="h-32">
          <VChart :option="statsChartOption" autoresize class="w-full h-full" />
        </div>
      </div>

      <div class="bg-gray-800 rounded-lg p-2 border border-gray-700">
        <div class="flex items-center justify-between mb-2 px-1">
          <span class="text-xs font-medium text-gray-400">工况时间轴</span>
          <span class="text-xs text-gray-500">点击切片查看详情</span>
        </div>
        <div class="h-48">
          <VChart
            :option="segmentChartOption"
            autoresize
            class="w-full h-full"
            @click="(params: any) => {
              if (params.data?.segmentId) handleSelectSegment(params.data.segmentId);
            }"
          />
        </div>
      </div>

      <div class="bg-gray-800 rounded-lg p-2 border border-gray-700">
        <div class="flex items-center justify-between mb-2 px-1">
          <span class="text-xs font-medium text-gray-400">信号对比</span>
          <select
            v-model="selectedSignal"
            class="bg-gray-900 border border-gray-600 rounded px-2 py-0.5 text-xs text-gray-300 focus:outline-none focus:border-cyan-500"
          >
            <option v-for="sig in availableSignals" :key="sig" :value="sig">{{ sig }}</option>
          </select>
        </div>
        <div class="h-48">
          <VChart :option="signalComparisonOption" autoresize class="w-full h-full" />
        </div>
      </div>

      <div v-if="store.selectedSegment" class="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span
              class="w-3 h-3 rounded-full"
              :style="{ backgroundColor: store.getDutyCycleMeta(store.selectedSegment.type).color }"
            ></span>
            <span class="text-sm font-semibold text-gray-200">
              {{ store.getDutyCycleMeta(store.selectedSegment.type).label }} 切片详情
            </span>
          </div>
          <button
            @click="handleSelectSegment(store.selectedSegment.id)"
            class="text-xs text-gray-400 hover:text-cyan-400"
          >
            关闭
          </button>
        </div>
        <div class="grid grid-cols-3 gap-2 mb-3 text-xs">
          <div class="bg-gray-900 rounded p-2">
            <div class="text-gray-500">开始时间</div>
            <div class="text-gray-200 font-mono">{{ formatTime(store.selectedSegment.startTime) }}</div>
          </div>
          <div class="bg-gray-900 rounded p-2">
            <div class="text-gray-500">结束时间</div>
            <div class="text-gray-200 font-mono">{{ formatTime(store.selectedSegment.endTime) }}</div>
          </div>
          <div class="bg-gray-900 rounded p-2">
            <div class="text-gray-500">持续/帧数</div>
            <div class="text-gray-200 font-mono">
              {{ formatDuration(store.selectedSegment.endTime - store.selectedSegment.startTime) }} / {{ store.selectedSegment.frameCount }}
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div
            v-for="(sig, name) in store.selectedSegment.signals"
            :key="String(name)"
            class="bg-gray-900 rounded p-2"
          >
            <div class="text-xs text-gray-400 mb-1">{{ String(name) }}</div>
            <div class="grid grid-cols-3 gap-1 text-xs">
              <div>
                <span class="text-gray-500">最小</span>
                <div class="text-gray-200 font-mono">{{ sig.min.toFixed(1) }}</div>
              </div>
              <div>
                <span class="text-gray-500">平均</span>
                <div class="text-cyan-400 font-mono font-bold">{{ sig.avg.toFixed(1) }}</div>
              </div>
              <div>
                <span class="text-gray-500">最大</span>
                <div class="text-gray-200 font-mono">{{ sig.max.toFixed(1) }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="store.dutyCycleSegments.length === 0" class="flex items-center justify-center py-12">
        <p class="text-gray-600 text-sm">暂无工况数据 — 点击"开始捕获"以生成</p>
      </div>
    </div>
  </div>
</template>
