import { motion } from "framer-motion";
import { HOLD_MS } from "./useHoldToDrag"; // adjust path to your hook

const SIZE = 32;          // column width in px
const STROKE_WIDTH = 3;   // thickness of the ring
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function HoldRing() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      className="pointer-events-none"
    >
      {/* Background track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={STROKE_WIDTH}
      />

      {/* Animated progress ring */}
      <motion.circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="white"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        style={{ strokeDasharray: CIRCUMFERENCE }}
        initial={{ strokeDashoffset: CIRCUMFERENCE }}
        animate={{ strokeDashoffset: 0 }}
        transition={{
          duration: HOLD_MS / 1000,
          ease: "linear",
        }}
      />
    </svg>
  );
}
