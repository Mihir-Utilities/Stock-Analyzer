"use client";

import { useEffect, useState } from "react";

/** The value after it has stopped changing for `ms` (a text filter should not query per key). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
