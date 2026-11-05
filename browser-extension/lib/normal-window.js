/** Select a regular browsing window without letting a focused popup take its place. */
export async function normalWindow(chromeApi, usable = () => true) {
  const valid = window => Number.isInteger(window?.id) && window.id >= 0 && window.type === 'normal' &&
    window.incognito !== true && usable(window);
  const options = { windowTypes: ['normal'] };
  try {
    const current = await chromeApi.windows.getLastFocused(options);
    if (valid(current)) return current;
  } catch { /* The last window may have closed while the command was queued. */ }
  try {
    const windows = await chromeApi.windows.getAll(options);
    return windows.find(window => valid(window) && window.focused) || windows.find(valid) || null;
  } catch { return null; }
}
