import { commands, type OutputDevice } from '../../generated/ipc.js';
import { IpcError } from '../errors.js';
import { isTauriRuntime } from '../transport.js';
import { audioDeviceMock } from '../mocks/audio.js';

export interface AudioDeviceService {
  listOutputDevices(): Promise<OutputDevice[]>;
  getOutputDevice(): Promise<string>;
  getMrOutputDevice(): Promise<string>;
  setOutputDevice(name: string): Promise<string>;
  setMrOutputDevice(name: string): Promise<string>;
}

export function createAudioDeviceService(runtime = isTauriRuntime()): AudioDeviceService {
  if (!runtime) return audioDeviceMock;

  return {
    async listOutputDevices() {
      const result = await commands.listOutputDevices();
      if (result.status === 'error') throw new IpcError(result.error, 'audio.device.enumeration');
      return result.data;
    },
    getOutputDevice: () => commands.getOutputDevice(),
    getMrOutputDevice: () => commands.getMrOutputDevice(),
    async setOutputDevice(name) {
      const result = await commands.setOutputDevice(name);
      if (result.status === 'error') throw new IpcError(result.error, 'audio.device.switch_failed');
      return result.data;
    },
    async setMrOutputDevice(name) {
      const result = await commands.setMrOutputDevice(name);
      if (result.status === 'error') throw new IpcError(result.error, 'audio.mr_device.switch_failed');
      return result.data;
    },
  };
}

export const audioDeviceService = createAudioDeviceService();
