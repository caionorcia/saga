export interface Clock {
  /** epoch em ms */
  now(): number
  /** relógio monotônico em ms (não pula com mudança de hora do sistema) */
  monotonic(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now()
}

export class FakeClock implements Clock {
  private mono = 0

  constructor(private wall = 0) {}

  now(): number {
    return this.wall
  }

  monotonic(): number {
    return this.mono
  }

  advance(ms: number): void {
    this.wall += ms
    this.mono += ms
  }
}
