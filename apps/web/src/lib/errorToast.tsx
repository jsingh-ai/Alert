import { useEffect, useState } from "react";

const SUPPORT_MESSAGE = "There was a problem. Please reach out to JJ at jsingh@fivestar.com and report the issue.";
const EVENT_NAME = "processguard:error";

type ErrorToastEvent = {
  detail?: string;
};

export function notifyAppError(detail?: string) {
  window.dispatchEvent(new CustomEvent<ErrorToastEvent>(EVENT_NAME, { detail: { detail } }));
}

export function ErrorToastHost() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    let timeout: number | undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ErrorToastEvent>).detail?.detail;
      setMessage(detail ? `${SUPPORT_MESSAGE} ${detail}` : SUPPORT_MESSAGE);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setMessage(""), 7000);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener(EVENT_NAME, handler);
    };
  }, []);

  if (!message) return null;
  return (
    <div className="error-toast" role="alert">
      <strong>Something went wrong</strong>
      <span>{message}</span>
      <button type="button" onClick={() => setMessage("")}>Dismiss</button>
    </div>
  );
}
