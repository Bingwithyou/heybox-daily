import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function readableError(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
export function rewardDelta(value: number) {
  return value >= 0 ? `+${value}` : String(value);
}
export function dateTime(time: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}
