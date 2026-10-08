/**
 * ID 生成。
 *
 * 选择理由：不依赖 crypto.randomUUID 的可用性（部分内网/旧环境缺失），
 * 采用「时间戳前缀 + 自增计数 + 随机后缀」，在同一会话内保证唯一，
 * 跨会话由进程启动时的随机片段降低碰撞概率。项目内 ID 只需在项目范围内唯一。
 */

/** 会话内自增计数，循环回绕，用于同毫秒内的去重 */
let counter = 0
/**
 * 会话级随机盐：进程启动时生成一次，降低不同会话在相同时刻生成相同 id 的概率
 * （时间戳 + 计数在同一毫秒内可能撞车，随机片段把碰撞概率进一步压低）。
 */
const sessionSalt = Math.random().toString(36).slice(2, 8)

/**
 * 生成一个带前缀的业务 id。
 * 结构：`前缀_时间戳(36进制)计数(4位)会话盐`——按生成顺序大致单调递增，
 * 便于日志排查时看出先后关系。
 */
export function createId(prefix = 'p'): string {
  counter = (counter + 1) % 0xffffff
  const time = Date.now().toString(36)
  const count = counter.toString(36).padStart(4, '0')
  return `${prefix}_${time}${count}${sessionSalt}`
}

/** 项目 id：同一套规则，仅前缀不同（同时用作 OPFS 目录名） */
export function createProjectId(): string {
  return createId('proj')
}
