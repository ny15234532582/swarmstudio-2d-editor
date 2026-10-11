/**
 * JSON 导入 / 导出（题目 4.4 要求的导出与重新导入）。
 * 导入的数据一律经过 validateProject 校验后才允许进入系统。
 */
import { validateProject } from '../core/validation'
import { DataValidationError } from '../core/validation'
import { isTrajectoryFile, trajectoryToProject } from './trajectory'
import type { Project } from '../core/types'

/** 导入专用错误：统一携带面向用户的中文说明 */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** 生成并触发浏览器下载：JSON 缩进 2 空格，文件名取项目名 */
export function exportProjectJson(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${project.name || 'project'}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 下载已触发，释放对象 URL 防止内存泄漏
  URL.revokeObjectURL(url)
}

/**
 * 读取并解析导入文件，按「读取 → JSON 解析 → 结构校验」三步分别报错；
 * 通过 validateProject 的数据才会返回，保证脏数据不进入系统。
 */
export async function parseProjectFile(file: File): Promise<Project> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new ImportError('读取文件失败')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ImportError('导入失败：文件不是合法 JSON')
  }
  try {
    return validateProject(parsed)
  } catch (err) {
    // 结构校验错误转为可直接展示的 ImportError；其余错误原样抛出
    if (err instanceof DataValidationError) throw new ImportError(`导入失败：${err.message}`)
    throw err
  }
}

/**
 * 通用导入：自动识别是「真实轨迹(.jsdm)」还是「我们的项目 JSON」。
 * 轨迹含 `pointFrames`（关键帧位置），转成帧 + 过渡。
 */
export async function parseAnyProjectFile(file: File): Promise<Project> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new ImportError('读取文件失败')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ImportError('导入失败：文件不是合法 JSON')
  }
  if (isTrajectoryFile(parsed)) {
    const base = file.name.replace(/\.[^.]+$/, '')
    return trajectoryToProject(parsed, base || '导入的轨迹')
  }
  try {
    return validateProject(parsed)
  } catch (err) {
    if (err instanceof DataValidationError) throw new ImportError(`导入失败：${err.message}`)
    throw err
  }
}
