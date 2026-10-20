import { cp, rm } from 'node:fs/promises'

const source = new URL('../db/', import.meta.url)
const target = new URL('../dist/db/', import.meta.url)
await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true, dereference: false })
