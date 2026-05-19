/**
 * Tailwind class merger.
 *
 *   cn("px-2 py-1", isActive && "bg-brand-accent", className)
 *
 * clsx handles the conditional + array/object syntax; tailwind-merge
 * deduplicates conflicting Tailwind classes (the last one wins). Used
 * across the new shadcn-style UI components.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
