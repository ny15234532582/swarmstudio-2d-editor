<script setup lang="ts">
/**
 * 过渡统计图表（ECharts）。
 * - 距离分布直方图；
 * - 速度 / 进度曲线（双纵轴）；
 * - 加权得分构成（各权重项贡献）；
 * - 峰值 / 上限占比（超限红）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { TransitionStats } from '../../core/transition'

const props = defineProps<{ stats: TransitionStats; maxSpeed: number; maxAccel: number }>()

const histEl = ref<HTMLDivElement>()
const curveEl = ref<HTMLDivElement>()
const scoreEl = ref<HTMLDivElement>()
const gaugeEl = ref<HTMLDivElement>()
let hist: echarts.ECharts | null = null
let curve: echarts.ECharts | null = null
let score: echarts.ECharts | null = null
let gauge: echarts.ECharts | null = null
let ro: ResizeObserver | null = null

const AXIS = '#8a93a6'
const GRID = '#222833'
const AXIS_LABEL = { color: AXIS, fontSize: 9 }
const TERM_LABELS = ['距离', '均匀', '方向', '同组', '顺序', '半径', '极角']

function histOption(s: TransitionStats): echarts.EChartsOption {
  const bins = 12
  const lo = s.minDistance
  const hi = s.maxDistance
  const width = hi > lo ? (hi - lo) / bins : 1
  const counts = new Array(bins).fill(0)
  for (const d of s.distances) counts[Math.min(bins - 1, Math.max(0, Math.floor((d - lo) / width)))]++
  const labels = counts.map((_, i) => `${(lo + i * width).toFixed(0)}~`)
  return {
    backgroundColor: 'transparent',
    grid: { left: 34, right: 8, top: 16, bottom: 22 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { ...AXIS_LABEL, interval: 2 }, axisLine: { lineStyle: { color: GRID } } },
    yAxis: { type: 'value', axisLabel: AXIS_LABEL, splitLine: { lineStyle: { color: GRID } } },
    series: [{ type: 'bar', data: counts, itemStyle: { color: '#36c6ff' }, barCategoryGap: '20%' }],
  }
}

function curveOption(s: TransitionStats): echarts.EChartsOption {
  const len = s.velocityCurve.length
  const x = s.velocityCurve.map((_, i) => ((i / Math.max(1, len - 1)) * 100).toFixed(0))
  return {
    backgroundColor: 'transparent',
    grid: { left: 40, right: 40, top: 16, bottom: 22 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: x, axisLabel: { ...AXIS_LABEL, interval: Math.floor(len / 5) }, axisLine: { lineStyle: { color: GRID } } },
    yAxis: [
      { type: 'value', name: '速度', nameTextStyle: AXIS_LABEL, axisLabel: AXIS_LABEL, splitLine: { lineStyle: { color: GRID } } },
      { type: 'value', min: 0, max: 1, name: '进度', nameTextStyle: AXIS_LABEL, axisLabel: { ...AXIS_LABEL, formatter: (v: number | string) => Number(v).toFixed(1) }, splitLine: { show: false } },
    ],
    series: [
      { name: '速度', type: 'line', showSymbol: false, smooth: true, data: s.velocityCurve, lineStyle: { color: '#36c6ff' }, itemStyle: { color: '#36c6ff' } },
      { name: '进度', type: 'line', yAxisIndex: 1, showSymbol: false, smooth: true, data: s.progressCurve, lineStyle: { color: '#4ad991' }, itemStyle: { color: '#4ad991' } },
    ],
  }
}

function scoreOption(s: TransitionStats): echarts.EChartsOption {
  return {
    backgroundColor: 'transparent',
    grid: { left: 34, right: 8, top: 16, bottom: 22 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: TERM_LABELS, axisLabel: AXIS_LABEL, axisLine: { lineStyle: { color: GRID } } },
    yAxis: { type: 'value', axisLabel: AXIS_LABEL, splitLine: { lineStyle: { color: GRID } } },
    series: [{ type: 'bar', data: s.scoreByTerm.map((v) => Number(v.toFixed(3))), itemStyle: { color: '#b27aff' }, barCategoryGap: '30%' }],
  }
}

function gaugeOption(s: TransitionStats): echarts.EChartsOption {
  const pct = (v: number, limit: number) => (limit > 0 ? Math.min(150, (v / limit) * 100) : 0)
  const speedPct = pct(s.peakSpeed, props.maxSpeed)
  const accelPct = pct(s.peakAccel, props.maxAccel)
  const color = (v: number) => (v > 100 ? '#ff6b6b' : '#36c6ff')
  return {
    backgroundColor: 'transparent',
    grid: { left: 48, right: 30, top: 12, bottom: 16 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${Number(v).toFixed(0)}%` },
    xAxis: { type: 'value', max: 150, axisLabel: { ...AXIS_LABEL, formatter: '{value}%' }, splitLine: { lineStyle: { color: GRID } } },
    yAxis: { type: 'category', data: ['速度', '加速度'], axisLabel: AXIS_LABEL, axisLine: { lineStyle: { color: GRID } } },
    series: [
      {
        type: 'bar',
        data: [
          { value: speedPct, itemStyle: { color: color(speedPct) } },
          { value: accelPct, itemStyle: { color: color(accelPct) } },
        ],
        barWidth: 14,
        markLine: { silent: true, symbol: 'none', data: [{ xAxis: 100 }], lineStyle: { color: '#ff6b6b', type: 'dashed' }, label: { show: false } },
      },
    ],
  }
}

function update(): void {
  hist?.setOption(histOption(props.stats), true)
  curve?.setOption(curveOption(props.stats), true)
  score?.setOption(scoreOption(props.stats), true)
  gauge?.setOption(gaugeOption(props.stats), true)
}

onMounted(() => {
  if (histEl.value) hist = echarts.init(histEl.value)
  if (curveEl.value) curve = echarts.init(curveEl.value)
  if (scoreEl.value) score = echarts.init(scoreEl.value)
  if (gaugeEl.value) gauge = echarts.init(gaugeEl.value)
  update()
  ro = new ResizeObserver(() => {
    hist?.resize()
    curve?.resize()
    score?.resize()
    gauge?.resize()
  })
  if (histEl.value) ro.observe(histEl.value)
})

watch(() => props.stats, update)

onBeforeUnmount(() => {
  ro?.disconnect()
  hist?.dispose()
  curve?.dispose()
  score?.dispose()
  gauge?.dispose()
})
</script>

<template>
  <div class="charts">
    <div class="chart">
      <div class="cap">距离分布</div>
      <div ref="histEl" class="canvas" />
    </div>
    <div class="chart">
      <div class="cap">速度 / 进度曲线</div>
      <div ref="curveEl" class="canvas" />
    </div>
    <div class="chart">
      <div class="cap">加权得分构成</div>
      <div ref="scoreEl" class="canvas short" />
    </div>
    <div class="chart">
      <div class="cap">峰值 / 上限占比</div>
      <div ref="gaugeEl" class="canvas short" />
    </div>
  </div>
</template>

<style scoped>
.charts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cap {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 2px;
}
.canvas {
  width: 100%;
  height: 130px;
}
.canvas.short {
  height: 84px;
}
</style>
