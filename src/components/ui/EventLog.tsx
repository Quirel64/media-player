import { useEffect, useState } from 'react'
import { getLogs, subscribeLogs, clearLogs, addLog } from '../../lib/logger'
import { usePlayerStore } from '../../stores/playerStore'
import { groupTracks, describeGroups } from '../../lib/group'
import { getStorageEstimate } from '../../lib/idb'

export function EventLog() {
  const [entries, setEntries] = useState<string[]>(() => getLogs())
  const queue = usePlayerStore((s) => s.queue)

  useEffect(() => subscribeLogs(setEntries), [])

  const runGroupPreview = () => {
    if (queue.length === 0) { addLog('group preview: queue empty'); return }
    const res = groupTracks(queue, { minGroupSize: 2 })
    addLog(`=== GROUP PREVIEW (${queue.length} tracks) ===`)
    for (const line of describeGroups(res).split('\n')) addLog(line)
    if (res.loose.length > 0) addLog(`Tip: loose tracks stay as single items; folder toggle will keep queue flat`)
  }

  const runStorageCheck = async () => {
    const est = await getStorageEstimate()
    if (est) {
      const usageMB = (est.usage / (1024 * 1024)).toFixed(2)
      const quotaMB = (est.quota / (1024 * 1024)).toFixed(0)
      addLog(`storage estimate: usage=${usageMB}MB quota=${quotaMB}MB`)
    } else {
      addLog('storage estimate: not available')
    }
    try { await (window as any).debugTrackFiles?.() } catch {}
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Event Log</h3>
        <div className="flex gap-2">
          <button
            onClick={runGroupPreview}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            title="Preview auto-group (folder + common words)"
          >
            Test Grouping
          </button>
          <button
            onClick={runStorageCheck}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
            title="Check storage estimate and track file list"
          >
            Check Storage
          </button>
          <button
            onClick={clearLogs}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <p className="text-slate-600">No events yet — play, pause, or lock the phone to generate logs. Tap "Test Grouping" to preview auto-album grouping.</p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words text-slate-300">
              {e}
            </div>
          ))
        )}
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
        Tip: keep this tab open, then lock your phone. After resume, come back here — logs persist until clear. Storage debug: <span className="text-slate-400">await getStorageEstimate()</span> and <span className="text-slate-400">await debugTrackFiles()</span> available in console (PWA homescreen has no console — use this log).
      </p>
    </div>
  )
}
