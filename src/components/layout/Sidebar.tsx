import { motion } from 'framer-motion'

interface SidebarProps {
  trackCount: number
  onPickFolder: () => void
  onPickFiles: () => void
  onClearAll: () => void
}

export function Sidebar({ trackCount, onPickFolder, onPickFiles, onClearAll }: SidebarProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-6">
        <h1 className="text-lg font-bold text-white">Media Player</h1>
        <p className="text-sm text-slate-400">Free & Open Source</p>
      </div>

      <nav className="flex-1 space-y-1">
        <SidebarItem label="Library" count={trackCount} active />
        <SidebarItem label="Playlists" count={0} />
        <SidebarItem label="Settings" />
      </nav>

      <div className="mt-auto space-y-2">
        <button
          onClick={onPickFolder}
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
        >
          + Open Folder
        </button>
        <button
          onClick={onPickFiles}
          className="w-full rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-accent hover:text-accent"
        >
          + Select Files
        </button>
        {trackCount > 0 && (
          <button
            onClick={onClearAll}
            className="w-full rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400 transition-colors hover:border-danger hover:text-danger"
          >
            Clear Library
          </button>
        )}
      </div>
    </div>
  )
}

interface SidebarItemProps {
  label: string
  count?: number
  active?: boolean
  onClick?: () => void
}

function SidebarItem({ label, count, active, onClick }: SidebarItemProps) {
  return (
    <motion.button
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-slate-800 text-white'
          : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
      }`}
    >
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
          {count}
        </span>
      )}
    </motion.button>
  )
}
