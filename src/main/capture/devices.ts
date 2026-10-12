import { ipcMain } from "electron";
import { AudioDeviceSchema, type AudioDevice } from "../../shared/schemas";

/**
 * Device enumeration runs in the renderer via navigator.mediaDevices, so the
 * main process acts as a passthrough validated by Zod. Windows system loopback
 * is surfaced as a virtual device entry selected in the renderer.
 */
export function registerCaptureIpc(getDevices: () => Promise<unknown>) {
  ipcMain.handle("capture.listDevices", async () => {
    const raw = await getDevices();
    if (!Array.isArray(raw)) return [];
    return raw
      .map((d) => AudioDeviceSchema.safeParse(d))
      .filter((r) => r.success)
      .map((r) => r.data as AudioDevice);
  });
}
