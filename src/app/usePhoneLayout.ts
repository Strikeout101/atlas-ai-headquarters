import { useEffect, useState } from "react";

/**
 * Phones get their own layout: a bottom tab bar, a leaner header and no Office (the 3D/pixel office is
 * desktop only). Narrow windows count, and so do phones held sideways (touch screen, very short viewport).
 */
export const PHONE_LAYOUT_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 500px)";

function matchesPhone(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PHONE_LAYOUT_QUERY).matches
    : false;
}

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(matchesPhone);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_LAYOUT_QUERY);
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return phone;
}
