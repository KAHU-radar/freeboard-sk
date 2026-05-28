/**
 * KAHU Crowdsource Tracks Layer
 *
 * Fetches vessel tracks from the KAHU TrackServer GeoJSON API and renders
 * them on the OpenLayers map. Refreshes automatically on map move / zoom.
 *
 * Authentication: uses an API key (?key=<uuid>) because freeboard-sk runs
 * cross-origin relative to TrackServer. The key must have can_read_nearby=True
 * set in the TrackServer admin.
 *
 * TrackServer endpoint:
 *   GET /api/routes/all/<minx,miny,maxx,maxy>/<start>/<end>/geojson?key=<uuid>
 */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges
} from '@angular/core';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Style, Stroke } from 'ol/style';
import { Feature } from 'ol';
import GeoJSON from 'ol/format/GeoJSON';
import { transformExtent } from 'ol/proj';
import { MapComponent } from '../map.component';

/** Stroke colour per source_type returned by TrackServer. */
const TRACK_COLORS: Record<string, string> = {
  own_position: '#00aaff',
  radar_tracked: '#ff8800',
  unknown: '#aaaaaa'
};

/** Pixels per source_type. */
const TRACK_WIDTHS: Record<string, number> = {
  own_position: 3,
  radar_tracked: 2,
  unknown: 1
};

/** Line dash pattern per source_type (undefined = solid). */
const TRACK_DASH: Record<string, number[] | undefined> = {
  own_position: undefined,
  radar_tracked: [4, 6],
  unknown: [3, 5]
};

function styleForFeature(feature: Feature): Style {
  const sourceType: string = feature.get('source_type') ?? 'unknown';
  return new Style({
    stroke: new Stroke({
      color: TRACK_COLORS[sourceType] ?? TRACK_COLORS.unknown,
      width: TRACK_WIDTHS[sourceType] ?? 1,
      lineDash: TRACK_DASH[sourceType]
    })
  });
}

// -------------------------------------------------------------------------

@Component({
  selector: 'ol-map > fb-kahu-tracks',
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class KahuTracksLayerComponent implements OnInit, OnDestroy, OnChanges {
  /** Base URL of the KAHU TrackServer, e.g. https://crowdsource.kahu.earth */
  @Input() serverUrl = 'https://crowdsource.kahu.earth';

  /**
   * API key UUID with can_read_nearby=True.
   * Required for cross-origin access (session cookies are not sent cross-origin).
   */
  @Input() apiKey = '';

  /** Show / hide the layer without destroying it. */
  @Input() enabled = true;

  /** How many days of history to request. */
  @Input() lookbackDays = 183;

  /** OL layer zIndex. */
  @Input() zIndex = 110;

  private vectorLayer: VectorLayer;
  private source: VectorSource;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private readonly onMoveEnd: () => void;

  constructor(
    private mapComponent: MapComponent,
    private changeDetectorRef: ChangeDetectorRef
  ) {
    this.changeDetectorRef.detach();
    // Bind once so we can un-register the exact same reference in ngOnDestroy.
    this.onMoveEnd = () => {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => this.fetchTracks(), 300);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  ngOnInit() {
    this.source = new VectorSource();
    this.vectorLayer = new VectorLayer({
      source: this.source,
      zIndex: this.zIndex,
      visible: this.enabled,
      style: (feature) => styleForFeature(feature as Feature)
    });

    const map = this.mapComponent.getMap();
    if (map) {
      map.addLayer(this.vectorLayer);
      map.on('moveend', this.onMoveEnd);
      // Initial fetch once the view is ready.
      this.fetchTracks();
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!this.vectorLayer) return;

    if ('enabled' in changes) {
      this.vectorLayer.setVisible(this.enabled);
    }
    if ('zIndex' in changes) {
      this.vectorLayer.setZIndex(this.zIndex);
    }
    if ('apiKey' in changes || 'serverUrl' in changes || 'lookbackDays' in changes) {
      this.fetchTracks();
    }
  }

  ngOnDestroy() {
    const map = this.mapComponent.getMap();
    if (map) {
      map.un('moveend', this.onMoveEnd);
      if (this.vectorLayer) {
        map.removeLayer(this.vectorLayer);
      }
    }
    this.abortController?.abort();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
  }

  // -------------------------------------------------------------------------
  // Fetch

  private buildUrl(extent4326: number[]): string {
    const [minX, minY, maxX, maxY] = extent4326.map((v) =>
      Number(v.toFixed(6))
    );
    const end = new Date();
    const start = new Date(end.getTime() - this.lookbackDays * 86_400_000);
    const bbox = `${minX},${minY},${maxX},${maxY}`;
    const url =
      `${this.serverUrl}/api/routes/all/${bbox}` +
      `/${start.toISOString()}/${end.toISOString()}/geojson`;
    return this.apiKey ? `${url}?key=${this.apiKey}` : url;
  }

  private async fetchTracks(): Promise<void> {
    if (!this.enabled || !this.serverUrl) return;

    const map = this.mapComponent.getMap();
    if (!map) return;

    const view = map.getView();
    const size = map.getSize();
    if (!size) return;

    const extent3857 = view.calculateExtent(size);
    const extent4326 = transformExtent(extent3857, 'EPSG:3857', 'EPSG:4326');

    // Server rejects bounding boxes wider/taller than 60°. Skip the request
    // and clear stale features when zoomed out too far (e.g. world view).
    const spanX = extent4326[2] - extent4326[0];
    const spanY = extent4326[3] - extent4326[1];
    if (spanX > 50 || spanY > 50) {
      this.source.clear();
      return;
    }

    // Cancel any in-flight request before starting a new one.
    this.abortController?.abort();
    this.abortController = new AbortController();

    const url = this.buildUrl(extent4326);

    try {
      const res = await fetch(url, { signal: this.abortController.signal });
      if (!res.ok) {
        console.warn(`[KahuTracks] ${res.status} from ${url}`);
        return;
      }
      const geojson = await res.json();

      const format = new GeoJSON();
      const features = format.readFeatures(geojson, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857'
      });

      this.source.clear();
      this.source.addFeatures(features as Feature[]);
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        console.warn('[KahuTracks] fetch error:', err);
      }
    }
  }
}
