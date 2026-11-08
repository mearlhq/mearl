import { StringDecoder } from 'node:string_decoder';

export interface Utf8LineBufferResult {
  lines: string[];
  overflow: boolean;
}

/** Accumulates newline-delimited socket messages without splitting UTF-8 code points. */
export class Utf8LineBuffer {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly maxBufferBytes: number) {}

  push(chunk: Buffer): Utf8LineBufferResult {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferBytes) {
      this.buffer = '';
      return { lines: [], overflow: true };
    }

    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      lines.push(this.buffer.slice(0, newlineIndex));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }
    return { lines, overflow: false };
  }
}
