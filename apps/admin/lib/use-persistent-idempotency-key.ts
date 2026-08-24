"use client";

import { useCallback, useRef, useState } from "react";
import { idempotencyKey } from "./api";

/**
 * Holds one command key across renders and failed submissions. A ref is used
 * as well as state so a key acquired immediately before an HTTP request is
 * already the key that request receives; setState alone is asynchronous.
 */
export function usePersistentIdempotencyKey() {
  const keyRef = useRef<string | null>(null);
  const [key, setKey] = useState<string | null>(null);

  const acquire = useCallback(() => {
    if (!keyRef.current) {
      keyRef.current = idempotencyKey();
      setKey(keyRef.current);
    }
    return keyRef.current;
  }, []);

  const clear = useCallback(() => {
    keyRef.current = null;
    setKey(null);
  }, []);

  return { key, acquire, clear };
}
