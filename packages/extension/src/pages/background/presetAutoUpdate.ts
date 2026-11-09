import { PRESET_UPDATE_INTERVAL_MS, PRESET_UPDATE_RETRY_MS } from '@mearl/preset/installation';
import {
  PRESET_AUTO_UPDATE_KEY,
  type PresetAutoUpdateResult,
  type PresetAutoUpdateState,
} from '../../shared/presetAutoUpdate';

const ALARM = 'mearl-preset-update';

/** Alarms survive worker suspension; the persisted deadline prevents repeated startup downloads. */
export function initializePresetAutoUpdate(update: () => Promise<PresetAutoUpdateResult>) {
  let pending: Promise<PresetAutoUpdateResult | undefined> | undefined;
  const check = (force = false): Promise<PresetAutoUpdateResult | undefined> => {
    if (pending) return force ? pending.then(result => result ?? check(true)) : pending;
    pending = (async () => {
      const now = Date.now();
      const previous = (await chrome.storage.local.get(PRESET_AUTO_UPDATE_KEY))[
        PRESET_AUTO_UPDATE_KEY
      ] as PresetAutoUpdateState | undefined;
      if (
        !force &&
        previous &&
        Number.isFinite(previous.nextCheckAt) &&
        previous.nextCheckAt > now &&
        previous.checkedAt <= now
      )
        return;
      await chrome.storage.local.set({
        [PRESET_AUTO_UPDATE_KEY]: {
          ...previous,
          checkedAt: now,
          nextCheckAt: now + PRESET_UPDATE_RETRY_MS,
        },
      });
      let result: PresetAutoUpdateResult;
      try {
        result = await update();
      } catch (error) {
        result = {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const retry =
        ['failed', 'waiting-native', 'permission-required'].includes(result.status) || result.error;
      await chrome.storage.local.set({
        [PRESET_AUTO_UPDATE_KEY]: {
          ...result,
          checkedAt: now,
          nextCheckAt: now + (retry ? PRESET_UPDATE_RETRY_MS : PRESET_UPDATE_INTERVAL_MS),
        },
      });
      return result;
    })()
      .catch(error => {
        console.warn('[PresetUpdate] Check unavailable:', String(error));
        return { status: 'failed' as const };
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void check();
  });
  chrome.permissions.onAdded.addListener(() => {
    void chrome.storage.local
      .get(PRESET_AUTO_UPDATE_KEY)
      .then(value => {
        if (value[PRESET_AUTO_UPDATE_KEY]?.status === 'permission-required') return check(true);
      })
      .catch(() => {});
  });
  void chrome.alarms.create(ALARM, { periodInMinutes: PRESET_UPDATE_RETRY_MS / 60_000 });
  void check();
  return check;
}
