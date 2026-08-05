const MEDIA_DIR = 'media-files'

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  try {
    return await root.getDirectoryHandle(MEDIA_DIR)
  } catch {
    return await root.getDirectoryHandle(MEDIA_DIR, { create: true })
  }
}

export async function saveFileToOPFS(fileName: string, file: File): Promise<void> {
  const dir = await getRoot()
  const fileHandle = await dir.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(file)
  await writable.close()
}

export async function getFileFromOPFS(fileName: string): Promise<File | null> {
  try {
    const dir = await getRoot()
    const fileHandle = await dir.getFileHandle(fileName)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

export async function getFileURLFromOPFS(fileName: string): Promise<string | null> {
  const file = await getFileFromOPFS(fileName)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function deleteFileFromOPFS(fileName: string): Promise<void> {
  try {
    const dir = await getRoot()
    await dir.removeEntry(fileName)
  } catch {
    // file didn't exist, ignore
  }
}

export async function clearOPFS(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(MEDIA_DIR, { recursive: true })
  } catch {
    // dir didn't exist, ignore
  }
}

export async function listFilesInOPFS(): Promise<string[]> {
  try {
    const dir = await getRoot()
    const files: string[] = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        files.push(name)
      }
    }
    return files
  } catch {
    return []
  }
}
