/**
 * smoke-utils.mjs — 冒烟脚本共用工具。
 *
 * 背景：工具栏上的「生成 20,000 点测试数据」按钮已移除。冒烟脚本改为通过
 * 左侧面板「导入 JSON」的 file input 注入一个确定性测试项目，等价地获得一批
 * 可编辑点位，用作选择 / 分组 / 持久化断言的对象。
 */

/**
 * 生成一批测试点并通过「导入 JSON」输入框注入页面。
 *
 * 坐标范围与旧测试数据一致（1200×800），颜色随位置渐变，保证画布中心附近
 * 有点可被单击/套索命中；随机序列用 mulberry32 + 固定种子，结果可复现。
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} count 点位数量
 * @returns {Promise<boolean>} 是否成功找到并写入 file input
 */
export function injectTestPoints(page, count = 20000) {
  return page.evaluate((n) => {
    // mulberry32：与已移除的 core/testdata 相同的确定性伪随机序列
    const mulberry32 = (seed) => {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const rand = mulberry32(20260928)
    const width = 1200
    const height = 800
    const depth = 200
    const points = new Array(n)
    for (let i = 0; i < n; i++) {
      const x = rand() * width
      const y = rand() * height
      points[i] = {
        // 固定前缀 + 序号，保证 id 唯一（validateProject 会拦截重复 id）
        id: `smoke_${i}`,
        frameId: 'frm_smoke',
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        z: Number(((rand() - 0.5) * depth).toFixed(3)),
        r: Math.round((x / width) * 255),
        g: Math.round((y / height) * 255),
        b: Math.round(rand() * 255),
      }
    }
    const project = {
      version: 3,
      id: `proj_smoke_${n}`,
      name: `冒烟测试 ${n} 点`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      droneCount: n,
      // 新结构：一条轨道 + 一个承载全部点位的帧
      tracks: [
        {
          id: 'trk_smoke',
          name: '轨道 1',
          clips: [{ id: 'frm_smoke', name: '帧 1', thumbnail: '', width: 0, height: 0, duration: 3 }],
          transitions: [],
        },
      ],
      points,
      groups: [],
    }
    // 定位「导入 JSON」的隐藏 file input（位于左侧 .panel 内）
    const input = document.querySelector('.panel input[type=file]')
    if (!input) return false
    const file = new File([JSON.stringify(project)], `smoke-${n}.json`, {
      type: 'application/json',
    })
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, count)
}
