/**
 * 设备选择持久化的判据（纯函数，无副作用）。
 *
 * 为什么抽出来：这套判据有四条路径（保存 / 读回 / 失效回落 / 清除），
 * 散在组件里各写一份必然漂移；而且测试若自己复刻一份判据，
 * 改坏真代码照样通过——那是假安全。
 *
 * 背景：设备选择原来只活在 React state 里，重启即丢。现在随 app_settings 落库，
 * 但落库带来了新问题——**存的 id 可能在下次启动时已经不存在**（设备拔了、
 * 换了 USB 口 id 会变），此时必须明确回落，不能静默拿一个失效 id 去采集。
 */

/** 从库里读回的选择，与当前实际设备列表做一次核对。 */
export interface ResolvedDevice {
  /** 实际生效的 deviceId；null 表示用系统默认 */
  deviceId: string | null;
  /** 是否需要提示用户「已回落」 */
  fellBack: boolean;
  /** 回落原因（面向用户）；未回落为 null */
  fallbackReason: string | null;
}

/**
 * 把「库里存的 deviceId」和「当前枚举到的设备」对上，得出实际该用哪个。
 *
 * 规则：
 * - 存的是 null / undefined / 空串 → 用默认，不算回落（用户就是这么选的）
 * - 存的 id 在设备列表里 → 用它，不回落
 * - 存的 id 不在列表里 → **回落 + 明确告知**（不能静默采错）
 * - 设备列表为空（还没授权/枚举失败）→ 保守用默认，不报回落
 *   （此时无法判断 id 是否失效，报了可能是误报）
 */
/**
 * 把「库里存的 deviceId」和「当前枚举到的设备」对上，得出实际该用哪个。
 *
 * 签名只要求 `{ id: string }` 而不是完整的 `AudioDevice`：
 * 判据本身只关心「这个 id 还在不在」，与设备是什么种类（麦克风/输出）无关。
 * 绑死完整契约会让一个无关的契约变更把这里也弄崩。
 */
export function resolveStoredDevice(
  stored: string | null | undefined,
  devices: Array<{ id: string }>,
): ResolvedDevice {
  const storedId = normalizeDeviceId(stored);

  // 没存过或选了默认：不是回落
  if (storedId === null) {
    return { deviceId: null, fellBack: false, fallbackReason: null };
  }

  // 列表为空时无法判定，保守走默认且不报回落（避免误报）
  if (devices.length === 0) {
    return { deviceId: null, fellBack: false, fallbackReason: null };
  }

  const stillThere = devices.some((d) => d.id === storedId);
  if (stillThere) {
    return { deviceId: storedId, fellBack: false, fallbackReason: null };
  }

  return {
    deviceId: null,
    fellBack: true,
    fallbackReason: `上次选择的音频设备已不可用（设备被拔出、禁用或更换了接口），已回落到系统默认设备。请重新选择。`,
  };
}

/**
 * 归一化：空串与 null 等价（select 的 value="" 表示默认），
 * 统一收敛成 null，避免"清除"和"没选过"两种语义混淆。
 */
export function normalizeDeviceId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 生成要落库的值：选默认时写 null（清除已存值），不留失效旧 id。 */
export function toStoredDeviceId(selected: string | null | undefined): string | null {
  return normalizeDeviceId(selected);
}
