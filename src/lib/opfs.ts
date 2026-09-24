import { clearFileBlobs, deleteFileBlob, getAllFileBlobNames, getFileBlob, saveFileBlob } from './idb'
import { addLog } from './logger'

// TEMPORARY: OPFS disabled due to Safari space-not-freed bug.
// All file operations route through IndexedDB (FILES_STORE) instead.
// To test OPFS again, replace these with the original OPFS implementations.

export async function saveFileToOPFS(fileName: string, file: File): Promise<void> {
  await saveFileBlob(fileName, file)
}

export async function getFileFromOPFS(fileName: string): Promise<File | null> {
  return (await getFileBlob(fileName)) ?? null
}

export async function getFileURLFromOPFS(fileName: string): Promise<string | null> {
  const file = await getFileBlob(fileName)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function deleteFileFromOPFS(fileName: string): Promise<void> {
  await deleteFileBlob(fileName)
}

export async function clearOPFS(): Promise<void> {
  await clearFileBlobs()
  try { await navigator.storage.estimate() } catch {}
  addLog('OPFS: cleared via IndexedDB (OPFS disabled)')
}

export async function listFilesInOPFS(): Promise<string[]> {
  return getAllFileBlobNames()
}

export async function debugOPFS(): Promise<void> {
  const files = await getAllFileBlobNames()
  if (files.length === 0) {
    console.log('OPFS is empty — no files stored.')
    return
  }
  console.group(`OPFS: ${files.length} file(s) stored`)
  for (const name of files) {
    const file = await getFileBlob(name)
    if (file) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
      console.log(`${name} — ${sizeMB} MB`)
    }
  }
  console.groupEnd()
}

// Expose to browser console: type `debugOPFS()` in DevTools
if (typeof window !== 'undefined') {
  ;(window as any).debugOPFS = debugOPFS
}
