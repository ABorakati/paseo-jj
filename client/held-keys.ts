import { useEffect, useRef, useState } from "react";
import { BLUR, NO_MODIFIERS, modifiersAfter, type HeldModifiers } from "./gestures";

/**
 * The slice of a key event the tracker reads, and the two listeners it needs.
 * Both are typed here rather than borrowed from the platform: the plugin builds
 * without the DOM library, and a native host has no window to listen on.
 */
interface HeldKeyEvent {
 type: string;
 key: string;
 ctrlKey: boolean;
 metaKey: boolean;
 shiftKey: boolean;
}

interface KeyHost {
 addEventListener(type: string, listener: (event: HeldKeyEvent) => void): void;
 removeEventListener(type: string, listener: (event: HeldKeyEvent) => void): void;
}

/**
 * The keys held down right now, read from the window.
 *
 * react-native's `PointerEvent` carries no `ctrlKey`, `shiftKey` or `metaKey`,
 * so a gesture that needs a modifier has to ask the keyboard what is held
 * rather than the pointer. That only works where a keyboard exists: the panel
 * runs in a browser through react-native-web, so `globalThis` is the window and
 * the real modifier state is there to read. A native build has no such global,
 * so nothing is installed and every gesture falls back to the action its
 * no-modifier case names. The host decides which of the two this is.
 *
 * `keyup` is not guaranteed to arrive — switching windows mid-chord loses it —
 * and a letter whose release was lost would stay held for the rest of the
 * session, so a blur wipes the state.
 */
export function useHeldKeys(enabled: boolean, onEscape: () => void): HeldModifiers {
 const [held, setHeld] = useState<HeldModifiers>(NO_MODIFIERS);
 /** The listeners are installed once, so the callback is read through a ref. */
 const escape = useRef(onEscape);

 useEffect(() => {
  escape.current = onEscape;
 }, [onEscape]);

 useEffect(() => {
  if (!enabled) return;
  const host = globalThis as unknown as KeyHost;
  const onKey = (event: HeldKeyEvent) => {
   if (event.type === "keydown" && event.key === "Escape") {
    escape.current();
    return;
   }
   setHeld((current) =>
    modifiersAfter(current, {
     action: event.type === "keyup" ? "up" : "down",
     key: event.key,
     ctrlKey: event.ctrlKey,
     metaKey: event.metaKey,
     shiftKey: event.shiftKey,
    }),
   );
  };
  const onBlur = () => setHeld((current) => modifiersAfter(current, BLUR));
  host.addEventListener("keydown", onKey);
  host.addEventListener("keyup", onKey);
  host.addEventListener("blur", onBlur);
  return () => {
   host.removeEventListener("keydown", onKey);
   host.removeEventListener("keyup", onKey);
   host.removeEventListener("blur", onBlur);
  };
 }, [enabled]);

 return enabled ? held : NO_MODIFIERS;
}
