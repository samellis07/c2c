/**
 * Test-only preload used to keep the gallery watchdog's idle-timeout test
 * deterministic. The regular gallery CLI has no switch for this behavior.
 */
import '../src/heartbeat.js';

const gate = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(gate, 0, 0, 90_000);
