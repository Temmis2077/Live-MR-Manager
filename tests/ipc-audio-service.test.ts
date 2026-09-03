import { describe, expect, it } from 'vitest';
import { createAudioDeviceService } from '../src/ipc/services/audio.js';

describe('audio IPC domain service', () => {
  it('uses the domain mock in browser preview mode', async () => {
    const service = createAudioDeviceService(false);
    const devices = await service.listOutputDevices();
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.filter((device) => device.isActive)).toHaveLength(1);
  });

  it('keeps browser selection and list state consistent', async () => {
    const service = createAudioDeviceService(false);
    await service.setOutputDevice('OBS Virtual Audio Device');
    expect(await service.getOutputDevice()).toBe('OBS Virtual Audio Device');
    expect((await service.listOutputDevices()).find((device) => device.isActive)?.name)
      .toBe('OBS Virtual Audio Device');
  });

  it('provides the MR device path through the same domain service', async () => {
    const service = createAudioDeviceService(false);
    expect(await service.setMrOutputDevice('OBS Virtual Audio Device')).toBe('OBS Virtual Audio Device');
  });
});
