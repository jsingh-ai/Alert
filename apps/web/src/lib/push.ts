import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, postJson } from "./api";

/*
 * Call notifications on this device (Web Push). The service worker (public/sw.js) shows them.
 *
 * What the switch can say:
 *   loading      still checking
 *   insecure     the app isn't on https, so the browser won't allow it (IT: docs/app-rollout.md)
 *   install      iPhone/iPad in Safari: notifications only work once the app is on the Home Screen
 *   unsupported  this browser can't (or the app isn't installed as a production build)
 *   unavailable  this server hasn't been set up for notifications (no keys in .env)
 *   denied       the person blocked notifications for this site in the browser or phone settings
 *   off / on
 */
/** Who this device's notifications belong to, so a different person signing in switches them off. */
const OWNER_KEY = "pg_push_owner";

function setOwner(userId: string | null) {
  try {
    if (userId) localStorage.setItem(OWNER_KEY, userId);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    // private mode: nothing to remember
  }
}

export type PushState = "loading" | "insecure" | "install" | "unsupported" | "unavailable" | "denied" | "off" | "on";

function isAppleMobile() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function keyBytes(base64url: string) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, publicKey: string) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // older browsers don't report it; assume it matches
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The service worker, or null if there isn't one (development builds, or it failed to install). */
async function worker() {
  if (!("serviceWorker" in navigator)) return null;
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

function bodyOf(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint, keys: json.keys };
}

export function usePush(userId: string) {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const publicKey = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async (): Promise<PushState> => {
      if (!window.isSecureContext) return "insecure";
      if (isAppleMobile() && !isInstalled()) return "install";
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
      const key = await api<{ data?: { publicKey: string | null } }>("/api/push/key", {}, { quiet: true }).catch(() => null);
      publicKey.current = key?.data?.publicKey ?? null;
      if (!publicKey.current) return "unavailable";
      if (Notification.permission === "denied") return "denied";
      const registration = await worker();
      if (!registration) return "unsupported";
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription || Notification.permission !== "granted") return "off";
      if (!sameKey(subscription, publicKey.current)) {
        // The server's keys changed: the old subscription can't receive anything any more
        await subscription.unsubscribe().catch(() => undefined);
        return "off";
      }
      // Keep the server current: this device belongs to whoever is signed in now
      await postJson("/api/push/subscribe", bodyOf(subscription)).catch(() => undefined);
      setOwner(userId);
      return "on";
    })()
      .catch(() => "unsupported" as const)
      .then((next) => {
        if (alive) setState(next);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  const enable = useCallback(async () => {
    setError("");
    // Ask first, before anything else is awaited: Safari only shows the prompt straight from a tap
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState(permission === "denied" ? "denied" : "off");
      return;
    }
    setBusy(true);
    try {
      const registration = await worker();
      if (!registration || !publicKey.current) throw new Error("This device can't receive notifications right now.");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey.current) });
      await postJson("/api/push/subscribe", bodyOf(subscription));
      setOwner(userId);
      setState("on");
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Couldn't turn on notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }, [userId]);

  const disable = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const registration = await worker();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await postJson("/api/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => undefined);
        await subscription.unsubscribe();
      }
      setOwner(null);
      setState("off");
    } catch {
      setError("Couldn't turn off notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, error, enable, disable };
}

/**
 * Signing out: this device stops getting the person's calls. The token is read right away, because
 * the caller clears it as soon as this starts.
 */
export function forgetPushDevice() {
  const token = getToken();
  setOwner(null);
  if (!("serviceWorker" in navigator)) return;
  void (async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return;
    if (token) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      }).catch(() => undefined);
    }
    // Even if the server couldn't be told, the device stops: the server drops it on the next send
    await subscription.unsubscribe();
  })().catch(() => undefined);
}

/**
 * Someone signing in. If this device's notifications were turned on by a different person (their
 * session ran out on a shared phone, so they never signed out), switch them off: the new person
 * turns their own on. The same person signing back in keeps theirs.
 */
export function handOverPushDevice(nextUserId: string) {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(OWNER_KEY);
  } catch {
    return;
  }
  if (owner && owner !== nextUserId) forgetPushDevice();
}
