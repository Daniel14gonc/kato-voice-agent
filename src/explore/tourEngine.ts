import type { ReferentStore } from '../conversation/referents';
import type { TourStop } from './deepUnderstanding';
import { TourHighlighter } from './highlighter';
import { goTo } from './lspQueries';

export type TourAction = 'next' | 'prev' | 'repeat' | 'stop';

/**
 * A piece of narration: the text goes to TTS, and onAudioStart fires at the
 * exact moment its audio starts playing (the webview reports it), which is
 * when the tour lights up the code lines this sentence talks about.
 */
export interface SpokenPart {
  text: string;
  onAudioStart?: () => void;
}

/**
 * Plays back a deep-understanding tour: opens each stop, reveals the range and
 * narrates segment by segment, highlighting the exact lines being spoken
 * about. Stops are also registered as referents, so "ve a la tercera parada"
 * works through the normal nav path.
 */
export class TourEngine {
  private stops: TourStop[] = [];
  private index = -1;
  private readonly highlighter = new TourHighlighter();

  constructor(private readonly referents: ReferentStore) {}

  load(stops: TourStop[]): void {
    this.stops = stops;
    this.index = -1;
    this.highlighter.clear();
    this.referents.setResults(
      stops.map((s) => ({
        label: s.label,
        uri: s.uri,
        range: s.range,
        preview: s.explanation.slice(0, 60),
      })),
    );
  }

  get active(): boolean {
    return this.stops.length > 0;
  }

  /** Snapshot line for the router; empty when no tour is loaded. */
  statusLine(): string {
    if (!this.active) {
      return '';
    }
    const position =
      this.index < 0 ? 'not started yet' : `at stop ${this.index + 1} (${this.stops[this.index].label})`;
    return `TOUR: active with ${this.stops.length} stops, ${position}. "next/siguiente", "previous/anterior", "repeat/repite", "stop/termina" control it.`;
  }

  async control(action: TourAction, es: boolean): Promise<SpokenPart[]> {
    if (!this.active) {
      return say(es ? 'No hay ningún tour activo ahora mismo.' : 'There is no active tour right now.');
    }
    switch (action) {
      case 'next':
        if (this.index + 1 >= this.stops.length) {
          return say(es ? 'Esa era la última parada del tour.' : 'That was the last stop of the tour.');
        }
        this.index++;
        return this.narrate(es);
      case 'prev':
        this.index = Math.max(0, this.index - 1);
        return this.narrate(es);
      case 'repeat':
        if (this.index < 0) {
          this.index = 0;
        }
        return this.narrate(es);
      case 'stop':
        this.stops = [];
        this.index = -1;
        this.highlighter.clear();
        return say(es ? 'Listo, tour terminado.' : 'Done, tour finished.');
    }
  }

  private async narrate(es: boolean): Promise<SpokenPart[]> {
    const stop = this.stops[this.index];
    this.highlighter.clear();
    await goTo(stop.uri, stop.range);
    const header = es
      ? `Parada ${this.index + 1} de ${this.stops.length}`
      : `Stop ${this.index + 1} of ${this.stops.length}`;
    return stop.segments.map((seg, i) => ({
      // The header rides on the first segment to save one TTS round-trip.
      text: i === 0 ? `${header}: ${seg.text}` : seg.text,
      onAudioStart: () => void this.highlighter.highlight(stop.uri, seg.range, i),
    }));
  }

  dispose(): void {
    this.highlighter.dispose();
  }
}

function say(text: string): SpokenPart[] {
  return [{ text }];
}
