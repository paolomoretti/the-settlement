/**
 * Audio Manager - handles all game sounds and music
 * Currently a placeholder - ready for sound integration
 */

import { Howl, Howler } from 'howler';

export type SoundEvent =
  | 'build_placed'
  | 'road_build'
  | 'demolish'
  | 'erase_demolition'
  | 'building_complete'
  | 'battle_clash_1'
  | 'battle_clash_2'
  | 'battle_victory'
  | 'battle_loss'
  | 'forest_1'
  | 'forest_2'
  | 'worker_spawn'
  | 'footstep'
  | 'chop_wood'
  | 'hammer'
  | 'ambient_birds'
  | 'ui_click'
  | 'surveyor';

export class AudioManager {
  private sounds: Map<SoundEvent, Howl> = new Map();
  /** Keyed by arbitrary string (e.g. 'building_worker_lumberjack') for building-worker ambient sounds. */
  private dynamicSounds: Map<string, Howl> = new Map();
  private musicTrack?: Howl;
  private enabled: boolean = true;
  private volume: number = 0.7;

  constructor() {
    Howler.volume(this.volume);
  }

  // Load a sound effect
  loadSound(event: SoundEvent, path: string, volume = 0.5): void {
    if (!this.sounds.has(event)) {
      this.sounds.set(
        event,
        new Howl({
          src: [path],
          volume,
        })
      );
    }
  }

  // Play a sound effect
  playSound(event: SoundEvent): void {
    if (!this.enabled) return;

    const sound = this.sounds.get(event);
    if (sound) {
      sound.play();
    } else {
      // Placeholder: log that sound would play
      console.log(`[Audio] Would play: ${event}`);
    }
  }

  // Load a dynamic (non-SoundEvent) sound by string key
  loadDynamicSound(key: string, path: string, volume = 0.5): void {
    if (!this.dynamicSounds.has(key)) {
      this.dynamicSounds.set(
        key,
        new Howl({
          src: [path],
          volume,
        })
      );
    }
  }

  // Play a dynamic sound by string key
  playDynamicSound(key: string): void {
    if (!this.enabled) return;
    const sound = this.dynamicSounds.get(key);
    if (sound) {
      sound.play();
    } else {
      console.log(`[Audio] Would play dynamic: ${key}`);
    }
  }

  // Load and play music
  playMusic(path: string, loop: boolean = true): void {
    if (this.musicTrack) {
      this.musicTrack.stop();
    }

    this.musicTrack = new Howl({
      src: [path],
      loop,
      volume: 0.3,
    });

    if (this.enabled) {
      this.musicTrack.play();
    }
  }

  stopMusic(): void {
    if (this.musicTrack) {
      this.musicTrack.stop();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    Howler.volume(this.volume);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.stopMusic();
    }
  }

  mute(): void {
    Howler.mute(true);
  }

  unmute(): void {
    Howler.mute(false);
  }
}

export const audioManager = new AudioManager();
