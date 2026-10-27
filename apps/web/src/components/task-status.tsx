import { CircleCheck, Clock3, CircleAlert, LoaderCircle, SkipForward } from "lucide-react";
import { statusNames } from "../lib/task-status";

export function TaskStatus({ status }: { status: string }) {
  const running = status === "running" || status === "confirming";
  const failed = status === "failed" || status === "auth_expired";
  const Icon =
    status === "skipped"
      ? SkipForward
      : status === "completed"
        ? CircleCheck
        : failed
          ? CircleAlert
          : running
            ? LoaderCircle
            : Clock3;
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap ${status === "completed" ? "text-green-700" : failed ? "text-destructive" : "text-muted-foreground"}`}
    >
      <Icon
        aria-hidden="true"
        className={`size-4 shrink-0${running ? " animate-spin motion-reduce:animate-none" : ""}`}
      />
      {statusNames[status] || status}
    </span>
  );
}
