import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface MicCaptureEvents {
  /** Base64-encoded 24kHz mono PCM16 chunk. */
  onChunk(base64Pcm: string): void;
  /** RMS level 0..1 for the VU meter. */
  onLevel(rms: number): void;
  onError(message: string): void;
}

/** Virtual audio devices that produce silence — never auto-pick these. */
const VIRTUAL_DEVICE = /teams|blackhole|loopback|zoom|virtual|soundflower/i;

/**
 * Microphone capture in the extension host by spawning ffmpeg (avfoundation
 * on macOS). VS Code blocks getUserMedia inside extension webviews by design
 * (microsoft/vscode#323602), so a helper process is the only reliable path.
 * The child process inherits the mic permission macOS granted to VS Code.
 */
export class MicCapture {
  /** Auto-resolved device, cached to avoid re-listing on every utterance. */
  private static resolvedDevice: string | undefined;

  private proc: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;

  get isCapturing(): boolean {
    return this.proc !== undefined;
  }

  /**
   * @param preferredDevice avfoundation device name or index ('' = auto).
   * Auto prefers the built-in mic over the system default: capturing from a
   * Bluetooth headset flips it from A2DP to the low-quality HFP profile,
   * degrading playback for the whole session.
   */
  start(events: MicCaptureEvents, preferredDevice = ''): void {
    if (this.proc) {
      return;
    }
    if (preferredDevice) {
      this.spawnFfmpeg(`:${preferredDevice}`, events, false);
      return;
    }
    if (MicCapture.resolvedDevice) {
      this.spawnFfmpeg(MicCapture.resolvedDevice, events, true);
      return;
    }
    if (process.platform === 'darwin') {
      void this.resolveAndStart(events);
    } else {
      this.spawnFfmpeg(':default', events, false);
    }
  }

  private async resolveAndStart(events: MicCaptureEvents): Promise<void> {
    let device = ':default';
    try {
      const devices = await listAvfoundationAudioDevices();
      const builtIn = devices.find((d) => /macbook.*(microphone|micrófono)|built-?in/i.test(d.name));
      if (builtIn) {
        device = `:${builtIn.index}`;
      }
    } catch {
      /* stick with :default */
    }
    MicCapture.resolvedDevice = device;
    this.spawnFfmpeg(device, events, true);
  }

  private spawnFfmpeg(device: string, events: MicCaptureEvents, allowFallback: boolean): void {
    this.stopping = false;
    let gotAudio = false;
    let stderr = '';

    const inputArgs =
      process.platform === 'darwin'
        ? ['-f', 'avfoundation', '-i', device]
        : process.platform === 'linux'
          ? ['-f', 'pulse', '-i', 'default']
          : ['-f', 'dshow', '-i', 'audio=default'];

    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ]);
    this.proc = proc;

    proc.stdout.on('data', (data: Buffer) => {
      gotAudio = true;
      events.onChunk(data.toString('base64'));
      const sampleCount = data.length >> 1;
      if (sampleCount > 0) {
        let sumSquares = 0;
        for (let i = 0; i < sampleCount; i++) {
          const s = data.readInt16LE(i * 2) / 0x8000;
          sumSquares += s * s;
        }
        events.onLevel(Math.sqrt(sumSquares / sampleCount));
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      this.proc = undefined;
      if (err.code === 'ENOENT') {
        events.onError('ffmpeg no está instalado. Instálalo con: brew install ffmpeg');
      } else {
        events.onError(err.message);
      }
    });

    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = undefined;
      }
      if (this.stopping || code === 0) {
        return;
      }
      if (!gotAudio && allowFallback && process.platform === 'darwin') {
        void this.fallbackToRealMic(events, stderr);
        return;
      }
      events.onError(`ffmpeg terminó con código ${code}: ${stderr.trim().slice(0, 300)}`);
    });
  }

  /**
   * ':default' failed — list avfoundation devices and pick the first one that
   * is not a known virtual/loopback device (those capture silence).
   */
  private async fallbackToRealMic(events: MicCaptureEvents, previousError: string): Promise<void> {
    try {
      const devices = await listAvfoundationAudioDevices();
      const mic = devices.find((d) => !VIRTUAL_DEVICE.test(d.name));
      if (mic) {
        this.spawnFfmpeg(`:${mic.index}`, events, false);
        return;
      }
    } catch {
      /* fall through to error below */
    }
    events.onError(
      `no encontré un micrófono utilizable (${previousError.trim().slice(0, 200)}). ` +
        'Puedes fijar el dispositivo con el setting kato.mic.device.',
    );
  }

  stop(): void {
    if (this.proc) {
      this.stopping = true;
      this.proc.kill('SIGTERM');
      this.proc = undefined;
    }
  }
}

export async function listAvfoundationAudioDevices(): Promise<Array<{ index: number; name: string }>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    let output = '';
    proc.stderr.on('data', (d: Buffer) => (output += d.toString()));
    proc.on('error', reject);
    proc.on('exit', () => {
      const devices: Array<{ index: number; name: string }> = [];
      const audioSection = output.split(/audio devices:/i)[1] ?? '';
      for (const line of audioSection.split('\n')) {
        const match = line.match(/\[(\d+)\]\s+(.+)$/);
        if (match) {
          devices.push({ index: Number(match[1]), name: match[2].trim() });
        }
      }
      resolve(devices);
    });
  });
}
