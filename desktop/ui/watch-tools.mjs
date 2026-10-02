import { createWatchTools } from '../../browser-extension/shared/ui/watch-tools.mjs';

export function createWatchToolsView({ document, run, notify, onLayoutChange }) {
  return createWatchTools({ document, notify, onLayoutChange, playbackMode: 'desktop',
    send: (method, argument, success) => run('watch-tools', method, argument, success),
    capabilities: snapshot => ({ busy: snapshot.pending.size > 0, available: snapshot.initialized && !snapshot.preview, recordingAvailable: !snapshot.preview })
  });
}
