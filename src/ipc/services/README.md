# Frontend IPC services

UI modules import domain services from this directory. They must not import
generated bindings, Tauri APIs, or the migration transport directly.

- `audio.ts`: output-device contract and browser preview mock selection
- `playback.ts`: transport, playback snapshot, and typed playback event subscriptions
- `mixer.ts`: track faders, mute/solo, routing, metronome, delay, and limiter state
- `library.ts`: song persistence, metadata mutation, and taxonomy queries
- `../transport.ts`: the only temporary location allowed to invoke legacy commands
- `../mocks/`: browser implementations with the same service interface

New commands must be generated from Rust before a service exposes them. The
legacy transport exists only for domain-by-domain migration and cannot be
imported by UI modules.
