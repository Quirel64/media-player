import { useEffect, useState } from 'react'
import { getLogs, subscribeLogs, clearLogs } from '../../lib/logger'

export function EventLog() {
  const [entries, setEntries] = useState<string[]>(() => getLogs())

  useEffect(() => subscribeLogs(setEntries), [])

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Event Log</h3>
        <button
          onClick={clearLogs}
          className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <p className="text-slate-600">No events yet — play, pause, or lock the phone to generate logs.</p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words text-slate-300">
              {e}
            </div>
          ))
        )}
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
        Tip: keep this tab open, then lock your phone. After resume, come back here — logs persist until clear.
      </p>
    </div>
  )
}
