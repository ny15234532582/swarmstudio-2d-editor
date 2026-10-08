#!/usr/bin/env node
/**
 * gen-points.mjs — 确定性的测试点数据生成器
 *
 * 用途：批量生成随机点位并写出为可直接「导入 JSON」的项目文件，用于性能测试
 *       （20000 点等大规模数据）与 E2E 冒烟脚本的数据来源。
 *
 * 用法（PNPM 脚本）：
 *   pnpm gen                    # 默认 20000 点 -> data/test-20000.json
 *   pnpm gen 8000               # 生成 8000 点 -> data/test-8000.json
 *   node scripts/gen-points.mjs 8000 data/test-8000.json   # 指定数量与输出路径
 *
 * 环境要求：仅需 Node.js >= 20，无额外环境变量。
 * 关键步骤：固定随机种子 -> 用 mulberry32 生成可复现的伪随机序列 -> 组装
 *           { version, points } 项目对象 -> 递归建目录并写出 JSON。
 *
 * 注意：使用固定种子，同样的入参每次生成的数据完全一致，便于回归对比。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// 点位数量与输出路径：优先取命令行参数，默认 20000 点、输出到 data/test-<count>.json
const count = Number(process.argv[2]) || 20000
const outPath = resolve(process.argv[3] || `data/test-${count}.json`)
// 固定随机种子，保证生成结果可复现
const SEED = 20260928

// mulberry32：轻量级 32 位可播种伪随机数生成器，返回 [0,1) 的浮点数
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
// 生成区域边界：平面 1200x800，Z 方向（深度）范围 ±100（共 200）
const width = 1200
const height = 800
const depth = 200

const points = new Array(count)
for (let i = 0; i < count; i++) {
  // X/Y 均匀分布，Z 以 0 为中心对称分布
  const x = rand() * width
  const y = rand() * height
  const z = (rand() - 0.5) * depth
  // id 由序号（36 进制）+ 随机后缀组成，降低碰撞概率；坐标保留 3 位小数
  points[i] = {
    id: `p_${i.toString(36)}_${Math.floor(rand() * 1e9).toString(36)}`,
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
    z: Number(z.toFixed(3)),
    // 颜色与位置关联：R 随 X、G 随 Y 变化，B 随机，便于肉眼观察分布
    r: Math.round((x / width) * 255),
    g: Math.round((y / height) * 255),
    b: Math.round(rand() * 255),
  }
}

// 组装项目文件；version 字段为导入校验所必需
const project = {
  version: 1,
  id: `proj_test_${count}`,
  name: `测试项目 ${count} 点`,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  points,
}

// 递归创建输出目录后写入紧凑 JSON（无缩进以减小体积）
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(project))
console.log(`已生成 ${count} 个点 -> ${outPath}`)
