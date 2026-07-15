export interface GenerationResult<T> {
  value: T;
  generation: number;
  current: boolean;
}

/**
 * Serializes asynchronous work while tracking which editor generation owns
 * each result. A rejected task never blocks later work in the queue.
 */
export class GenerationQueue {
  private tail: Promise<void> = Promise.resolve();
  private currentGeneration = 0;

  get generation(): number {
    return this.currentGeneration;
  }

  advance(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  isCurrent(generation: number): boolean {
    return generation === this.currentGeneration;
  }

  enqueue<T>(generation: number, task: () => Promise<T>): Promise<GenerationResult<T>> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then((value) => ({
      value,
      generation,
      current: this.isCurrent(generation),
    }));
  }
}
