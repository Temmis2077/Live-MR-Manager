import type { OutputDevice } from '../../generated/ipc.js';

const devices: OutputDevice[] = [
  { name: 'Speakers (Browser Mock)', config: '48000Hz, 2ch', isActive: true },
  { name: 'OBS Virtual Audio Device', config: '48000Hz, 2ch', isActive: false },
];

let selected = devices[0].name;

export const audioDeviceMock = {
  async listOutputDevices(): Promise<OutputDevice[]> {
    return devices.map((device) => ({ ...device, isActive: device.name === selected }));
  },
  async getOutputDevice(): Promise<string> {
    return selected;
  },
  async getMrOutputDevice(): Promise<string> {
    return '';
  },
  async setOutputDevice(name: string): Promise<string> {
    selected = name || devices[0].name;
    return selected;
  },
  async setMrOutputDevice(name: string): Promise<string> {
    return name;
  },
};
