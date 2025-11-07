import type { StatusResponse } from "../api";

interface StatusIndicatorProps {
  status: StatusResponse | null;
  loading?: boolean;
}

export function StatusIndicator({ status, loading }: StatusIndicatorProps) {
  if (loading || !status) {
    return (
      <div className="status-indicator loading">
        <span className="status-dot"></span>
        <span className="status-text">Loading...</span>
      </div>
    );
  }

  const isRunning = status.running;
  const hasError = status.lastError !== null;

  return (
    <div className={`status-indicator ${isRunning ? "running" : "stopped"}`}>
      <span className="status-dot"></span>
      <span className="status-text">
        {isRunning ? (
          <>
            Running {status.pid !== null && `(PID: ${status.pid})`}
          </>
        ) : (
          <>Stopped{hasError && `: ${status.lastError}`}</>
        )}
      </span>
    </div>
  );
}
