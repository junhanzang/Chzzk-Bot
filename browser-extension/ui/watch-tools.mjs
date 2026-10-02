import { createWatchTools } from '../shared/ui/watch-tools.mjs';
import { connected, unavailable } from './state.mjs';

export function createWatchToolsView({ document, run, notify, onLayoutChange }) {
  return createWatchTools({ document, notify, onLayoutChange, playbackMode: 'browser', send: run,
    capabilities: snapshot => ({ busy: snapshot.pending, available: !unavailable(snapshot.state), recordingAvailable: connected(snapshot.state) })
  });
}
