import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { canonical } from './canonical.js'
export function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function readPrivateJson(file: string): unknown {
  if (lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_ANALYTICS_PATH')
  return JSON.parse(readFileSync(file, 'utf8'))
}
export function atomicJson(file: string, value: unknown) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_ANALYTICS_PATH')
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, file); syncDirectory(path.dirname(file))
}
export function removeDurable(file: string) {
  if (existsSync(file)) { unlinkSync(file); syncDirectory(path.dirname(file)) }
}
