// AudioWorklet Processor — Runs on the audio rendering thread
// Accumulates PCM samples into ~3-second Float32Array chunks at 16kHz mono

class AudioChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions || {};
    this.chunkDuration = opts.chunkDurationSec || 3;
    // sampleRate is a global in AudioWorkletGlobalScope
    this.bufferSize = Math.floor(sampleRate * this.chunkDuration);
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(inputs) {
    if (!this.active) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Take first channel (mono)
    const channelData = input[0];
    if (!channelData) return true;

    // Copy samples into the accumulation buffer
    const remaining = this.bufferSize - this.writeIndex;
    const toCopy = Math.min(channelData.length, remaining);

    this.buffer.set(channelData.subarray(0, toCopy), this.writeIndex);
    this.writeIndex += toCopy;

    // When buffer is full, send the chunk
    if (this.writeIndex >= this.bufferSize) {
      // Create a copy to transfer
      const chunk = this.buffer.slice(0);
      this.port.postMessage(
        { type: 'audio-chunk', buffer: chunk, sampleRate },
        [chunk.buffer]
      );

      // Reset buffer
      this.writeIndex = 0;

      // If there were leftover samples from channelData, copy them
      if (toCopy < channelData.length) {
        const leftover = channelData.subarray(toCopy);
        this.buffer.set(leftover, 0);
        this.writeIndex = leftover.length;
      }
    }

    return true;
  }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
