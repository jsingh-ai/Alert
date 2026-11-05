/**
 * Registers the service worker that makes ProcessGuard installable as an app (public/sw.js).
 *
 * Production builds only: in `vite dev` a cached shell would fight hot reload. Browsers expose
 * service workers only on HTTPS or localhost, so on a plain-HTTP LAN address this does nothing
 * and the site keeps working as a normal web page.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("ProcessGuard: service worker registration failed", error);
    });
  };

  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
