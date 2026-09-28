/**
 * JSON 导入 / 导出（题目 4.4 要求的导出与重新导入）。
 * 导入的数据一律经过 validateProject 校验后才允许进入系统。
 */
import { validateProject } from '../core/validation'
import { DataValidationError } from '../core/validation'
import type { Project } from '../core/types'

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

export function exportProjectJson(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${project.name || 'project'}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

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
    if (err instanceof DataValidationError) throw new ImportError(`导入失败：${err.message}`)
    throw err
  }
}
