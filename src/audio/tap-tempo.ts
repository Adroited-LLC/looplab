/** Collects tap times and returns the average BPM. */
export class TapTempo {
  private taps:    number[] = [];
  private readonly MAX_GAP = 3000; // ms — reset if gap > 3s
  private readonly MAX_TAPS = 8;

  tap(): number | null {
    const now = Date.now();
    if (this.taps.length > 0 && now - this.taps[this.taps.length - 1] > this.MAX_GAP) {
      this.taps = [];
    }
    this.taps.push(now);
    if (this.taps.length > this.MAX_TAPS) this.taps.shift();
    if (this.taps.length < 2) return null;

    let total = 0;
    for (let i = 1; i < this.taps.length; i++) {
      total += this.taps[i] - this.taps[i - 1];
    }
    const avgMs = total / (this.taps.length - 1);
    return Math.round(60000 / avgMs);
  }

  reset(): void { this.taps = []; }
}
