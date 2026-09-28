#!/usr/bin/env node
/**
 * 生成测试数据脚本（默认 20,000 点）。
 *
 * 用法：
 *   npm run gen                 # 默认 20000 点 -> data/test-20000.json
 *   node scripts/gen-points.mjs 8000 data/test-8000.json
 *
 * 输出为可直接「导入 JSON」的项目文件（含 version 字段）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const count = Number(process.argv[2]) || 20000
const outPath = resolve(process.argv[3] || `data/test-${count}.json`)
const SEED = 20260928

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(SEED)
const width = 1200
const height = 800
const depth = 200

const points = new Array(count)
for (let i = 0; i < count; i++) {
  const x = rand() * width
  const y = rand() * height
  const z = (rand() - 0.5) * depth
  points[i] = {
    id: `p_${i.toString(36)}_${Math.floor(rand() * 1e9).toString(36)}`,
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
    z: Number(z.toFixed(3)),
    r: Math.round((x / width) * 255),
    g: Math.round((y / height) * 255),
    b: Math.round(rand() * 255),
  }
}

const project = {
  version: 1,
  id: `proj_test_${count}`,
  name: `测试项目 ${count} 点`,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  points,
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(project))
console.log(`已生成 ${count} 个点 -> ${outPath}`)
