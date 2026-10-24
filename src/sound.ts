import chime from '../assets/chime.wav';

/** The parts of `expo-audio` the adapter uses; pass the module itself. */
export interface ExpoAudioModule {
  createAudioPlayer(source: number): ExpoAudioPlayer;
}

export interface ExpoAudioPlayer {
  volume: number;
  play(): void;
  seekTo(seconds: number): Promise<void>;
}

/**
 * Plays the web widget's reply chime with `expo-audio`. Takes the module as an argument, so the
 * SDK has no dependency on Expo:
 *
 *     import * as ExpoAudio from 'expo-audio';
 *     new OpenDesk({ …, sound: expoAudioSound(ExpoAudio) });
 *
 * The player is made on the first reply and kept for the next. The app's audio mode is left
 * alone; under expo-audio's default the chime mixes with other audio instead of pausing it.
 */
export function expoAudioSound(ExpoAudio: ExpoAudioModule, options: { volume?: number } = {}): () => void {
  let player: ExpoAudioPlayer | null = null;

  return () => {
    if (!player) {
      player = ExpoAudio.createAudioPlayer(chime);
      if (options.volume !== undefined) {
        player.volume = options.volume;
      }
    }
    const current = player;
    void current
      .seekTo(0)
      .catch(() => undefined)
      .then(() => current.play());
  };
}
