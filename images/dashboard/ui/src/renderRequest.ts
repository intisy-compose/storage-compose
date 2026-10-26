let renderCallback: () => void = () => {};

export function onRenderRequested(callback: () => void): void {
  renderCallback = callback;
}

export function requestRender(): void {
  renderCallback();
}

let refreshCallback: () => void = () => {};

export function onRefreshRequested(callback: () => void): void {
  refreshCallback = callback;
}

/** Reads the page's data again now rather than at the next poll, as after a saved write. */
export function requestRefresh(): void {
  refreshCallback();
}
