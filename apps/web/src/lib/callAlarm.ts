import { useCallback, useEffect, useRef, useState } from "react";

/*
 * In-app call alarm: while the Team Calls page is open on an awake phone, a NEW waiting call
 * rings (two-tone beep), vibrates and flashes the screen, repeating until someone accepts it,
 * it's cancelled, or this person taps Silence. Works on plain http, because it needs no service worker.
 *
 * It can't wake a locked phone or a closed browser: that is what push notifications (public/sw.js,
 * https only) are for. While this is on, the screen is kept awake so the phone stays "awake".
 *
 * Limits of the web: no camera-LED flash (the screen flashes instead), and iPhone Safari has no vibration.
 * Browsers only allow sound after a tap, so the person turns it on once with the speaker button.
 */
const STORE_KEY = "pg_alarm";
const REPEAT_MS = 3000;
/** Stop repeating after this long, so a phone left on a desk doesn't ring forever. */
const MAX_RING_MS = 5 * 60_000;

function stored() {
  try {
    return localStorage.getItem(STORE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(STORE_KEY, "1");
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // private mode: it just won't be remembered
  }
}

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
}

function newAudio(): AudioContext | null {
  const Ctor = audioCtor();
  try {
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

/** Two short high-low pairs: hard to mistake for a message tone. */
function beep(audio: AudioContext) {
  const start = audio.currentTime + 0.02;
  [880, 660, 880, 660].forEach((frequency, i) => {
    const at = start + i * 0.22;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.21);
  });
}

type WakeLock = { release: () => Promise<void> };

/**
 * @param waitingIds ids of calls nobody has taken yet, or null until the list has loaded
 *                   (calls already waiting when the page opens ring too, until accepted or silenced).
 */
export function useCallAlarm(waitingIds: string[] | null) {
  const [enabled, setEnabled] = useState(stored);
  const [pending, setPending] = useState<string[]>([]);
  const audio = useRef<AudioContext | null>(null);
  const known = useRef<Set<string> | null>(null);
  const supported = Boolean(audioCtor());

  // Browsers keep audio locked until a tap; after a reload, the next tap anywhere re-arms it.
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const arm = () => {
      audio.current ??= newAudio();
      void audio.current?.resume().then(() => setLocked(audio.current?.state !== "running"));
    };
    // Works straight away if the person has already interacted with the page (e.g. just signed in)
    arm();
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [enabled]);

  // Which calls are new since the page opened (or since the last list), and still waiting
  const key = waitingIds?.join("|") ?? null;
  useEffect(() => {
    if (!waitingIds) return;
    const current = new Set(waitingIds);
    const before = known.current;
    known.current = current;
    setPending((list) => {
      const stillWaiting = list.filter((id) => current.has(id));
      // First list after opening the page counts too: signing in to a call nobody has taken should ring
      const added = before ? waitingIds.filter((id) => !before.has(id)) : waitingIds;
      const next = Array.from(new Set([...stillWaiting, ...added]));
      return next.length === list.length && next.every((id, i) => id === list[i]) ? list : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const ringing = enabled && pending.length > 0;
  useEffect(() => {
    if (!ringing) return;
    const startedAt = Date.now();
    const ring = () => {
      if (Date.now() - startedAt > MAX_RING_MS) return window.clearInterval(timer);
      if (audio.current && audio.current.state === "running") beep(audio.current);
      try {
        navigator.vibrate?.([300, 120, 300, 120, 300]);
      } catch {
        // no vibration on this device
      }
    };
    const timer = window.setInterval(ring, REPEAT_MS);
    ring();
    return () => {
      window.clearInterval(timer);
      try {
        navigator.vibrate?.(0);
      } catch {
        // ignore
      }
    };
  }, [ringing]);

  // Keep the screen on while alerts are on, so the phone stays awake with the page in front
  useEffect(() => {
    if (!enabled) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLock> } };
    if (!nav.wakeLock) return;
    let lock: WakeLock | null = null;
    let alive = true;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then(
        (got) => {
          if (alive) lock = got;
          else void got.release();
        },
        () => undefined
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);

  const toggle = useCallback(() => {
    if (enabled) {
      setEnabled(false);
      setPending([]);
      remember(false);
      return;
    }
    // Created inside the tap, which is what lets the browser play sound later
    audio.current ??= newAudio();
    void audio.current?.resume().then(() => audio.current && beep(audio.current));
    setEnabled(true);
    remember(true);
  }, [enabled]);

  const silence = useCallback(() => setPending([]), []);

  return { supported, enabled, ringing, toggle, silence, locked: ringing && locked };
}
