let renderCallback: () => void = () => {};

export function onRenderRequested(callback: () => void): void {
  renderCallback = callback;
}

export function requestRender(): void {
  renderCallback();
}
