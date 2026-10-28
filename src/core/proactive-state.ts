/** Session-local trigger and Codex recovery bookkeeping.
 * An extension registration owns one instance. Runtime handlers never share
 * cooldown or pending overflow state across independent Pi instances.
 */
export class ProactiveState {
  private lastCompactTime = 0;
  private triggerActive = false;
  private contextOverflowPending = false;

  isCoolingDown(now = Date.now()): boolean {
    return this.lastCompactTime !== 0 && now - this.lastCompactTime < 3000;
  }
  isTriggered(): boolean { return this.triggerActive; }
  isOverflowPending(): boolean { return this.contextOverflowPending; }
  markOverflow(): void { this.contextOverflowPending = true; }
  clearOverflow(): void { this.contextOverflowPending = false; }
  initiate(now = Date.now()): void {
    this.lastCompactTime = now;
    this.triggerActive = true;
  }
  complete(now = Date.now()): void {
    this.lastCompactTime = now;
    this.triggerActive = false;
    this.contextOverflowPending = false;
  }
  reset(): void {
    this.lastCompactTime = 0;
    this.triggerActive = false;
    this.contextOverflowPending = false;
  }
}
