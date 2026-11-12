import { app, safeStorage } from 'electron'
import { readFile, rename, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import type { StorageState } from '../managers/BrowserSessionManager'

function statePath(accountId: string): string {
  if (!/^[\w-]{1,100}$/.test(accountId)) throw new Error('账号标识无效')
  return path.join(app.getPath('userData'), `shop-session-${accountId}.bin`)
}

export async function loadDoudianSessionState(accountId: string): Promise<StorageState | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    const encrypted = await readFile(statePath(accountId))
    const state = JSON.parse(safeStorage.decryptString(encrypted)) as StorageState
    if (!state || typeof state !== 'object' || !Array.isArray(state.cookies) || !Array.isArray(state.origins))
      return undefined
    return state
  } catch {
    return undefined
  }
}

export async function saveDoudianSessionState(accountId: string, context: BrowserContext): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return
  const state = await context.storageState({ indexedDB: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(state))
  const target = statePath(accountId)
  const temporary = `${target}.pending`
  await writeFile(temporary, encrypted, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target)
}
