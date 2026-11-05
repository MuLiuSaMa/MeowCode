export const DEFAULT_INITIAL_VIEWPORT_POLICY = Object.freeze({
  version: 1,
  mode: "fit-content",
  apply: "first-open",
  viewportZoomFactor: 0.86,
  maxZoom: 1,
  animate: false,
  restoreSavedViewport: true
});

export function shouldFitInitialViewport(
  policy,
  { loadedFromAutosave = false } = {}
) {
  if (!policy || policy.mode !== "fit-content") {
    return false;
  }
  if (!loadedFromAutosave) {
    return true;
  }
  return policy.apply === "every-open" || policy.restoreSavedViewport === false;
}

export function initialViewportOptions(policy) {
  return {
    fitToViewport: true,
    viewportZoomFactor: policy.viewportZoomFactor,
    maxZoom: policy.maxZoom,
    animate: policy.animate
  };
}
