import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';

export type SeekListener    = (time: number) => void;
export type RegionListener  = (start: number, end: number) => void;

export class WaveformController {
  private ws:      WaveSurfer | null = null;
  private regions: ReturnType<typeof RegionsPlugin.create> | null = null;
  private region: ReturnType<RegionsPlugin['addRegion']> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private _seekListeners:   SeekListener[]   = [];
  private _regionListeners: RegionListener[] = [];

  private _duration   = 0;
  private _zoomLevel  = 50;
  private _scrollLock = false;

  init(container: HTMLElement): void {
    const regionsPlugin = RegionsPlugin.create();
    this.regions = regionsPlugin;

    this.ws = WaveSurfer.create({
      container,
      waveColor:     '#4f4f70',
      progressColor: '#7c3aed',
      cursorColor:   '#06b6d4',
      cursorWidth:   2,
      height:        'auto',
      normalize:     true,
      interact:      true,
      minPxPerSec:   this._zoomLevel,
      plugins: [regionsPlugin],
    });

    // Silence WaveSurfer's own audio — AudioEngine handles all playback
    this.ws.setVolume(0);

    // WaveSurfer observes its own scroll element; also watch the panel so
    // height-only window/layout changes resize the waveform.
    let lastHeight = container.clientHeight;
    this.resizeObserver = new ResizeObserver(() => {
      const height = container.clientHeight;
      if (height === lastHeight) return;
      lastHeight = height;
      this.ws?.setOptions({ height: 'auto' });
    });
    this.resizeObserver.observe(container);

    this.ws.on('interaction', (time: number) => {
      this._seekListeners.forEach(fn => fn(time));
    });

    regionsPlugin.on('region-updated', (r: { start: number; end: number }) => {
      this._regionListeners.forEach(fn => fn(r.start, r.end));
    });
  }

  async load(blobUrl: string): Promise<void> {
    if (!this.ws) return;
    this.clearLoop();
    this._duration = 0;
    await this.ws.load(blobUrl);
    this._duration = this.ws.getDuration();
  }

  /** Move the waveform cursor to match AudioEngine position. */
  setTime(t: number): void {
    if (!this.ws || !this._duration) return;
    if (this._scrollLock) return;
    this.ws.setTime(t);
  }

  setLoop(start: number, end: number): void {
    if (!this.regions) return;
    if (this.region) {
      this.region.setOptions({ start, end });
    } else {
      this.region = this.regions.addRegion({
        start,
        end,
        drag:    true,
        resize:  true,
        color:   'rgba(124, 58, 237, 0.18)',
      });
    }
  }

  clearLoop(): void {
    this.regions?.clearRegions();
    this.region = null;
  }

  zoomIn(): void {
    this._zoomLevel = Math.min(600, this._zoomLevel * 1.5);
    this.ws?.zoom(this._zoomLevel);
  }

  zoomOut(): void {
    this._zoomLevel = Math.max(10, this._zoomLevel / 1.5);
    this.ws?.zoom(this._zoomLevel);
  }

  get duration() { return this._duration; }

  onSeek(fn: SeekListener):        void { this._seekListeners.push(fn); }
  onRegionChange(fn: RegionListener): void { this._regionListeners.push(fn); }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.ws?.destroy();
    this.ws = null;
    this.regions = null;
    this.region = null;
  }
}
