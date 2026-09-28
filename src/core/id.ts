/**
 * ID 生成。
 *
 * 选择理由：不依赖 crypto.randomUUID 的可用性（部分内网/旧环境缺失），
 * 采用「时间戳前缀 + 自增计数 + 随机后缀」，在同一会话内保证唯一，
 * 跨会话由进程启动时的随机片段降低碰撞概率。项目内 ID 只需在项目范围内唯一。
 */

let counter = 0
const sessionSalt = Math.random().toString(36).slice(2, 8)

export function createId(prefix = 'p'): string {
  counter = (counter + 1) % 0xffffff
  const time = Date.now().toString(36)
  const count = counter.toString(36).padStart(4, '0')
  return `${prefix}_${time}${count}${sessionSalt}`
}

export function createProjectId(): string {
  return createId('proj')
}
