/**
 * Booking-link share actions — copy, native share, open-in-browser.
 *
 * Thin wrappers over expo-clipboard, the React Native Share API, and
 * expo-web-browser, with haptic feedback. Kept out of bookingLinks.ts (which
 * stays pure/testable). Each returns a boolean so callers can show a toast.
 *
 * A module-level guard prevents a double-tap from opening two native share
 * sheets at once.
 */

import { Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";

let shareInFlight = false;

/** Copy a URL to the clipboard. Returns true on success. */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(url);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the native share sheet for a booking URL. Guarded against double-taps so
 * two sheets never stack. Returns true if the sheet opened (not necessarily
 * shared — RN doesn't always report the dismissed action reliably).
 */
export async function shareLink(url: string, title?: string): Promise<boolean> {
  if (shareInFlight) return false;
  shareInFlight = true;
  try {
    void Haptics.selectionAsync().catch(() => {});
    // On Android `url` is ignored, so include it in the message too.
    await Share.share(
      { message: title ? `${title}\n${url}` : url, url, title: title ?? "Booking link" },
      { dialogTitle: title ?? "Share booking link" },
    );
    return true;
  } catch {
    return false;
  } finally {
    shareInFlight = false;
  }
}

/** Open a URL in the in-app browser (safe preview without leaving the app). */
export async function openLink(url: string): Promise<boolean> {
  try {
    void Haptics.selectionAsync().catch(() => {});
    await WebBrowser.openBrowserAsync(url);
    return true;
  } catch {
    return false;
  }
}
