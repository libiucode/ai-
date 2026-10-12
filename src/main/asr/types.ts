import type { AsrConfig } from "../../shared/schemas";
import { AppError } from "../../shared/contracts";

export type AsrEvent =
  | "partial"
  | "final"
  | "connected"
  | "disconnected"
  | "error"
  | "status";

export type AsrHandler = (payload: unknown) => void;
export type Unsubscribe = () => void;

export interface AsrAdapter {
  connect(config: AsrConfig): Promise<void>;
  sendPcm(chunk: ArrayBuffer): Promise<void>;
  stop(): Promise<void>;
  on(event: AsrEvent, handler: AsrHandler): Unsubscribe;
  getConnectionId(): string | null;
}

export interface AsrPartialPayload {
  connectionId: string;
  sourceSeq: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface AsrFinalPayload {
  connectionId: string;
  sourceSeq: number;
  text: string;
  startMs: number;
  endMs: number;
  voiceId: string;
}

export interface AsrErrorPayload {
  error: AppError;
}
