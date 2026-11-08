/*
 * Installable app: registers the service worker and shows an "Install app"
 * button when the browser offers installation (Chrome / Edge / Android).
 * On iPhone, installing is done from Safari's Share menu → "Add to Home Screen".
 */
export function setupPwa(installButton) {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(err => console.warn("Service worker not registered", err));
    });
  }
  if (!installButton) return;
  let promptEvent = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();          // show our own button instead of the browser's mini-bar
    promptEvent = e;
    installButton.hidden = false;
  });
  installButton.addEventListener("click", async () => {
    if (!promptEvent) return;
    promptEvent.prompt();
    await promptEvent.userChoice;
    promptEvent = null;
    installButton.hidden = true;
  });
  window.addEventListener("appinstalled", () => { installButton.hidden = true; });
}
