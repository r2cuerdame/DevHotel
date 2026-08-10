const MAX_PENDING_MIRRORS = 32

/** Tracks left→right mirror loads so their completion cannot loop back to left. */
export class PreviewSyncGuard {
  private readonly pending = new Set<string>()

  mark(url: string): void {
    if (this.pending.size >= MAX_PENDING_MIRRORS) this.pending.clear()
    this.pending.add(url)
  }

  consume(url: string): boolean {
    return this.pending.delete(url)
  }

  fail(url: string): void {
    this.pending.delete(url)
  }

  clear(): void {
    this.pending.clear()
  }
}
