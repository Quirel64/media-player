import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

interface LayoutProps {
  sidebar: ReactNode
  main: ReactNode
  player: ReactNode
}

export function Layout({ sidebar, main, player }: LayoutProps) {
  return (
    <div className="flex h-full flex-col bg-slate-950">
      <div className="flex flex-1 overflow-hidden">
        <motion.aside
          initial={{ x: -260 }}
          animate={{ x: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="hidden w-64 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 md:flex"
        >
          {sidebar}
        </motion.aside>
        <main className="flex-1 overflow-y-auto bg-slate-950">
          {main}
        </main>
      </div>
      <motion.div
        initial={{ y: 90 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        className="flex-shrink-0 border-t border-slate-800 bg-slate-900"
      >
        {player}
      </motion.div>
    </div>
  )
}
