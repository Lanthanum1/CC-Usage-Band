export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'
// Figures whose shown value just changed: 'five_hour', 'seven_day', 'ctx'; at is when (clock ms),
// frame the terminal phase it started on
export type Flash = { keys: string[]; at: number; frame: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      measure: Measure | null
      turn: TurnTokens | null
      now: number
      phase: number
      style: Style
      flash: Flash | null
    }
  }
}
