export interface AgentCallLimiter {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class AgentConcurrencyLimiter implements AgentCallLimiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("maxConcurrency must be positive");
    }
    this.#limit = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
